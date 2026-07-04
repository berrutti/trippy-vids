import { onMounted, onUnmounted, watch, type Ref, type ComputedRef } from 'vue';
import { ShaderEffect, shaderEffects } from '@/utils';
import {
  vertexShader,
  blitShader,
  passthroughShader,
  createEffectShaderWGSL,
  rdStepShader,
  rdCompositeShader,
  UNIFORMS_FLOAT_COUNT,
  UNIFORM_IDX
} from '@/shaderBuilderWGSL';

export interface UseWebGPURendererOptions {
  canvasRef: Ref<HTMLCanvasElement | null>;
  videoRef: Ref<HTMLVideoElement | null>;
  activeEffects: ComputedRef<Record<ShaderEffect, boolean>>;
  effectIntensities: ComputedRef<Record<ShaderEffect, number>>;
  bpmSyncEnabled: ComputedRef<Record<ShaderEffect, boolean>>;
  bpm: Ref<number>;
  // Called once per frame. When it returns a value, that time/bpm pair is fed to the
  // uniform buffer instead of the free-running clock and manual bpm, phase-locking the
  // existing beatPeriod/beatPhase shader math to an external clock (e.g. Beatmatcher).
  getBeatClock?: () => { time: number; bpm: number } | null;
  onRenderPerformance?: (fps: number, frameTime: number) => void;
  onVideoNotRenderable?: () => void;
  onFrameQuality?: (lumaAvg: number, variance: number) => void;
  onRendererUnavailable?: () => void;
}

// ── Vue composable ─────────────────────────────────────────────────────────

export function useWebGPURenderer(options: UseWebGPURendererOptions) {
  let cleanup: (() => void) | null = null;
  onMounted(async () => {
    cleanup = (await initRenderer(options)) ?? null;
  });
  onUnmounted(() => cleanup?.());
}

// ── Constants ──────────────────────────────────────────────────────────────

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

const QUAD_VERTICES = new Float32Array([
  -1, -1, 0, 1, 1, -1, 1, 1, -1, 1, 0, 0, -1, 1, 0, 0, 1, -1, 1, 1, 1, 1, 1, 0
]);

const FRAME_RING_SIZE = 128;

// ── Pure helpers ───────────────────────────────────────────────────────────

export function computeCrop(
  videoWidth: number,
  videoHeight: number,
  canvasWidth: number,
  canvasHeight: number
): [number, number, number, number] {
  if (videoWidth === 0 || videoHeight === 0) return [0, 1, 0, 1];
  const vAspect = videoWidth / videoHeight;
  const cAspect = canvasWidth / canvasHeight;
  if (vAspect < cAspect) {
    const crop = (1 - vAspect / cAspect) / 2;
    return [0, 1, crop, 1 - crop];
  } else {
    const crop = (1 - cAspect / vAspect) / 2;
    return [crop, 1 - crop, 0, 1];
  }
}

// Acquires the WebGPU device and configures the canvas context.
async function acquireGPUContext(canvas: HTMLCanvasElement): Promise<{
  device: GPUDevice;
  context: GPUCanvasContext;
  canvasFormat: GPUTextureFormat;
} | null> {
  if (!navigator.gpu) {
    console.error('WebGPU not supported.');
    return null;
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    console.error('No WebGPU adapter found.');
    return null;
  }
  const device = await adapter.requestDevice();
  const rawContext = canvas.getContext('webgpu');
  if (!rawContext) {
    console.error('WebGPU context not available.');
    return null;
  }
  const context = rawContext as unknown as GPUCanvasContext;
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format: canvasFormat, alphaMode: 'opaque' });
  return { device, context, canvasFormat };
}

// Creates all static GPU resources: buffers, sampler, bind group layouts, pipelines.
// Nothing here depends on canvas size — resize-dependent resources live in updateTargets.
function createGPUResources(device: GPUDevice, canvasFormat: GPUTextureFormat) {
  const vertexBuffer = device.createBuffer({
    size: QUAD_VERTICES.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
  });
  device.queue.writeBuffer(vertexBuffer, 0, QUAD_VERTICES);

  const vertexLayout: GPUVertexBufferLayout = {
    arrayStride: 16,
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x2' },
      { shaderLocation: 1, offset: 8, format: 'float32x2' }
    ]
  };

  const uniformBuffer = device.createBuffer({
    size: UNIFORMS_FLOAT_COUNT * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });
  const uniformData = new Float32Array(UNIFORMS_FLOAT_COUNT);

  const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });

  // 64 px × 4 bytes = 256 bytes — one WebGPU-aligned row for quality readback.
  const qualityReadbackBuffer = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });

  const externalTextureBGL = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, externalTexture: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } }
    ]
  });
  const textureBGL = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } }
    ]
  });
  const feedbackTextureBGL = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }
    ]
  });
  const uniformBGL = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform' }
      }
    ]
  });
  const uniformBindGroup = device.createBindGroup({
    layout: uniformBGL,
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }]
  });

  const vsModule = device.createShaderModule({ code: vertexShader });
  function makePipeline(
    fragCode: string,
    bgl: GPUBindGroupLayout,
    format: GPUTextureFormat
  ): GPURenderPipeline {
    return device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bgl, uniformBGL] }),
      vertex: { module: vsModule, entryPoint: 'vs_main', buffers: [vertexLayout] },
      fragment: {
        module: device.createShaderModule({ code: fragCode }),
        entryPoint: 'fs_main',
        targets: [{ format }]
      },
      primitive: { topology: 'triangle-list' }
    });
  }

  const effectPipelines = new Map<ShaderEffect, GPURenderPipeline>();
  for (const effect of Object.values(ShaderEffect)) {
    const wgsl = createEffectShaderWGSL(effect);
    if (wgsl === null) continue;
    effectPipelines.set(
      effect,
      makePipeline(
        wgsl,
        shaderEffects[effect].stage === 'feedback' ? feedbackTextureBGL : textureBGL,
        TEXTURE_FORMAT
      )
    );
  }

  return {
    vertexBuffer,
    uniformBuffer,
    uniformData,
    sampler,
    qualityReadbackBuffer,
    bgls: { externalTextureBGL, textureBGL, feedbackTextureBGL, uniformBGL },
    uniformBindGroup,
    pipelines: {
      blit: makePipeline(blitShader, externalTextureBGL, TEXTURE_FORMAT),
      effects: effectPipelines,
      passthrough: makePipeline(passthroughShader, textureBGL, canvasFormat),
      rdStep: makePipeline(rdStepShader, feedbackTextureBGL, TEXTURE_FORMAT),
      rdComposite: makePipeline(rdCompositeShader, feedbackTextureBGL, TEXTURE_FORMAT)
    }
  };
}

// Writes all per-frame uniform values into the CPU-side Float32Array.
// The caller is responsible for uploading it to the GPU with writeBuffer.
function writeUniforms(
  data: Float32Array,
  options: UseWebGPURendererOptions,
  timeSec: number
): void {
  const { bpm: bpmRef, effectIntensities, bpmSyncEnabled, getBeatClock } = options;
  const intensities = effectIntensities.value;
  const sync = bpmSyncEnabled.value;
  const beatClock = getBeatClock?.();

  data[UNIFORM_IDX.time] = beatClock?.time ?? timeSec;
  data[UNIFORM_IDX.bpm] = beatClock?.bpm ?? bpmRef.value;

  for (const effect of Object.values(ShaderEffect)) {
    const iIdx = UNIFORM_IDX.intensity[effect];
    if (iIdx !== undefined) data[iIdx] = intensities[effect] ?? 1;
    const sIdx = UNIFORM_IDX.bpmSync[effect];
    if (sIdx !== undefined) data[sIdx] = sync[effect] ? 1 : 0;
  }
}

// Schedules a GPU→CPU readback of a 64-pixel strip from the center of the given texture.
// Calls onFrameQuality with luma average and variance when the result is available.
// Returns true if a readback was started (pending flag managed by caller).
function scheduleQualityReadback(
  device: GPUDevice,
  readbackBuffer: GPUBuffer,
  sourceTexture: GPUTexture,
  canvasWidth: number,
  canvasHeight: number,
  onDone: (lumaAvg: number, variance: number) => void,
  onSettled: () => void
): void {
  const stripY = Math.floor(canvasHeight / 2);
  const stripX = Math.max(0, Math.floor(canvasWidth / 2) - 32);
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture: sourceTexture, origin: { x: stripX, y: stripY } },
    { buffer: readbackBuffer, bytesPerRow: 256 },
    { width: 64, height: 1 }
  );
  device.queue.submit([enc.finish()]);

  readbackBuffer
    .mapAsync(GPUMapMode.READ)
    .then(() => {
      const data = new Uint8Array(readbackBuffer.getMappedRange(0, 256));
      let lumaSum = 0;
      for (let i = 0; i < 256; i += 4)
        lumaSum += (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
      const lumaAvg = lumaSum / 64;
      let varSum = 0;
      for (let i = 0; i < 256; i += 4) {
        const luma = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
        varSum += (luma - lumaAvg) ** 2;
      }
      readbackBuffer.unmap();
      onSettled();
      onDone(lumaAvg, varSum / 64);
    })
    .catch(onSettled);
}

// ── Renderer init ──────────────────────────────────────────────────────────
// Orchestrates the above pieces. Returns a cleanup function on success.

async function initRenderer(options: UseWebGPURendererOptions): Promise<(() => void) | undefined> {
  const canvas = options.canvasRef.value;
  if (!canvas) return;

  const gpu = await acquireGPUContext(canvas);
  if (!gpu) {
    options.onRendererUnavailable?.();
    return;
  }
  const { device, context, canvasFormat } = gpu;

  const res = createGPUResources(device, canvasFormat);
  const { vertexBuffer, uniformBuffer, uniformData, sampler, qualityReadbackBuffer } = res;
  const { externalTextureBGL, textureBGL, feedbackTextureBGL } = res.bgls;
  const { uniformBindGroup, pipelines } = res;

  // ── Resize-dependent render targets ──────────────────────────────────────
  //
  // Three render targets rotate each frame: one holds the previous frame's
  // final output (history), the other two ping-pong for the current frame's
  // effect chain. histIdx tracks which RT is currently the history texture.
  // This eliminates the per-frame copyTextureToTexture that the old
  // 2-RT + separate history design required.

  let renderTargets: [GPUTexture, GPUTexture, GPUTexture] | null = null;
  let rtBindGroups: [GPUBindGroup, GPUBindGroup, GPUBindGroup] | null = null;
  // historyBindGroups[src][hist] — null when src === hist (invalid pair)
  let historyBindGroups: (GPUBindGroup | null)[][] | null = null;
  let rdTextures: [GPUTexture, GPUTexture] | null = null;
  // rdStepBGs[rdSrc][rtSrc] — precomputed for all ping-pong/history combinations
  let rdStepBGs: GPUBindGroup[][] | null = null;
  // rdCompBGs[rtSrc] — rdSrcIdx is always 0 after 4 iterations (even count)
  let rdCompBGs: GPUBindGroup[] | null = null;
  let histIdx = 2;

  function makeTexture(w: number, h: number, extraUsage = 0): GPUTexture {
    return device.createTexture({
      size: [w, h],
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST |
        extraUsage
    });
  }

  function updateTargets() {
    if (!canvas) return;
    const newW = window.innerWidth;
    const newH = window.innerHeight;
    const sizeChanged = canvas.width !== newW || canvas.height !== newH;
    canvas.width = newW;
    canvas.height = newH;

    const video = options.videoRef.value;
    const [uMin, uMax, vMin, vMax] = computeCrop(
      video?.videoWidth ?? 0,
      video?.videoHeight ?? 0,
      newW,
      newH
    );
    uniformData[UNIFORM_IDX.cropUMin] = uMin;
    uniformData[UNIFORM_IDX.cropUMax] = uMax;
    uniformData[UNIFORM_IDX.cropVMin] = vMin;
    uniformData[UNIFORM_IDX.cropVMax] = vMax;

    if (renderTargets && !sizeChanged) return;

    renderTargets?.forEach((t) => t.destroy());
    rdTextures?.forEach((t) => t.destroy());

    const [rt0, rt1, rt2] = [
      makeTexture(newW, newH),
      makeTexture(newW, newH),
      makeTexture(newW, newH)
    ];
    const [rdA, rdB] = [
      device.createTexture({
        size: [newW, newH],
        format: TEXTURE_FORMAT,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
      }),
      device.createTexture({
        size: [newW, newH],
        format: TEXTURE_FORMAT,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
      })
    ];

    renderTargets = [rt0, rt1, rt2];
    rdTextures = [rdA, rdB];
    // RT[2] starts as history; RT[0] and RT[1] are the first frame's ping-pong pair.
    histIdx = 2;

    rtBindGroups = [rt0, rt1, rt2].map((rt) =>
      device.createBindGroup({
        layout: textureBGL,
        entries: [
          { binding: 0, resource: rt.createView() },
          { binding: 1, resource: sampler }
        ]
      })
    ) as [GPUBindGroup, GPUBindGroup, GPUBindGroup];

    historyBindGroups = [rt0, rt1, rt2].map((srcTex, src) =>
      [rt0, rt1, rt2].map((histTex, hist) =>
        src === hist
          ? null
          : device.createBindGroup({
              layout: feedbackTextureBGL,
              entries: [
                { binding: 0, resource: srcTex.createView() },
                { binding: 1, resource: sampler },
                { binding: 2, resource: histTex.createView() }
              ]
            })
      )
    );

    // Precompute RD step bind groups for all (rdSrc, rtSrc) pairs.
    rdStepBGs = [rdA, rdB].map((rdTex) =>
      [rt0, rt1, rt2].map((rtTex) =>
        device.createBindGroup({
          layout: feedbackTextureBGL,
          entries: [
            { binding: 0, resource: rdTex.createView() },
            { binding: 1, resource: sampler },
            { binding: 2, resource: rtTex.createView() }
          ]
        })
      )
    );

    // Precompute RD composite bind groups for all rtSrc values.
    // rdSrcIdx is always 0 after the 4-iteration step loop (even iteration count).
    rdCompBGs = [rt0, rt1, rt2].map((rtTex) =>
      device.createBindGroup({
        layout: feedbackTextureBGL,
        entries: [
          { binding: 0, resource: rtTex.createView() },
          { binding: 1, resource: sampler },
          { binding: 2, resource: rdA.createView() }
        ]
      })
    );

    const initEnc = device.createCommandEncoder();
    for (const rdTex of [rdA, rdB]) {
      const p = initEnc.beginRenderPass({
        colorAttachments: [
          {
            view: rdTex.createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 1, g: 0, b: 0, a: 1 }
          }
        ]
      });
      p.end();
    }
    device.queue.submit([initEnc.finish()]);
  }

  updateTargets();
  window.addEventListener('resize', updateTargets);
  const stopVideoWatch = watch(
    options.videoRef,
    (newVideo, oldVideo) => {
      if (oldVideo) oldVideo.removeEventListener('loadedmetadata', updateTargets);
      if (newVideo) newVideo.addEventListener('loadedmetadata', updateTargets);
    },
    { immediate: true }
  );

  // ── Render loop ───────────────────────────────────────────────────────────

  const perfData = {
    frameRing: new Float64Array(FRAME_RING_SIZE),
    frameHead: 0,
    lastReport: 0
  };
  let lastVideo: HTMLVideoElement | null = null;
  let videoWasReady = false;
  let notifiedNotRenderable = false;
  let qualityFrameCount = 0;
  let qualityReadbackPending = false;
  let rafId = 0;

  function renderFrame(now: number) {
    const video = options.videoRef.value;

    if (video !== lastVideo) {
      lastVideo = video;
      videoWasReady = false;
      notifiedNotRenderable = false;
      updateTargets();
      if (canvas && context) {
        const enc = device.createCommandEncoder();
        const pass = enc.beginRenderPass({
          colorAttachments: [
            {
              view: context.getCurrentTexture().createView(),
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: { r: 0, g: 0, b: 0, a: 1 }
            }
          ]
        });
        pass.end();
        device.queue.submit([enc.finish()]);
      }
    }

    const videoReady = !!video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
    if (!videoReady) {
      if (videoWasReady && canvas && context) {
        const enc = device.createCommandEncoder();
        const pass = enc.beginRenderPass({
          colorAttachments: [
            {
              view: context.getCurrentTexture().createView(),
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: { r: 0, g: 0, b: 0, a: 1 }
            }
          ]
        });
        pass.end();
        device.queue.submit([enc.finish()]);
      }
      videoWasReady = false;
      rafId = requestAnimationFrame(renderFrame);
      return;
    }
    videoWasReady = true;

    if (video.videoWidth === 0 && !notifiedNotRenderable) {
      notifiedNotRenderable = true;
      options.onVideoNotRenderable?.();
    } else if (video.videoWidth > 0) {
      notifiedNotRenderable = false;
    }

    if (!renderTargets || !rtBindGroups || !historyBindGroups) {
      rafId = requestAnimationFrame(renderFrame);
      return;
    }

    let externalTexture: GPUExternalTexture;
    try {
      externalTexture = device.importExternalTexture({ source: video });
    } catch {
      rafId = requestAnimationFrame(renderFrame);
      return;
    }

    const frameStart = performance.now();
    writeUniforms(uniformData, options, now / 1000);
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const activeList = Object.values(ShaderEffect).filter((e) => options.activeEffects.value[e]);
    const enc = device.createCommandEncoder();

    // Determine which two render targets ping-pong this frame.
    // histIdx is the RT holding last frame's output; the other two are the active pair.
    const pingPong = [0, 1, 2].filter((i) => i !== histIdx);
    const ppA = pingPong[0];
    const ppB = pingPong[1];

    // Blit video → renderTargets[ppA]
    {
      const blitBG = device.createBindGroup({
        layout: externalTextureBGL,
        entries: [
          { binding: 0, resource: externalTexture },
          { binding: 1, resource: sampler }
        ]
      });
      const blitPass = enc.beginRenderPass({
        colorAttachments: [
          {
            view: renderTargets[ppA].createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 }
          }
        ]
      });
      blitPass.setPipeline(pipelines.blit);
      blitPass.setBindGroup(0, blitBG);
      blitPass.setBindGroup(1, uniformBindGroup);
      blitPass.setVertexBuffer(0, vertexBuffer);
      blitPass.draw(6);
      blitPass.end();
    }

    // Effect passes — ping-pong between ppA and ppB
    let srcIdx = ppA;
    let rdSrcIdx = 0;

    for (const effect of activeList) {
      const dstIdx = srcIdx === ppA ? ppB : ppA;

      if (effect === ShaderEffect.REACTION_DIFFUSION && rdTextures) {
        for (let iter = 0; iter < 4; iter++) {
          const rdDst = (1 - rdSrcIdx) as 0 | 1;
          const stepBG = rdStepBGs![rdSrcIdx][srcIdx];
          const stepPass = enc.beginRenderPass({
            colorAttachments: [
              { view: rdTextures[rdDst].createView(), loadOp: 'load', storeOp: 'store' }
            ]
          });
          stepPass.setPipeline(pipelines.rdStep);
          stepPass.setBindGroup(0, stepBG);
          stepPass.setBindGroup(1, uniformBindGroup);
          stepPass.setVertexBuffer(0, vertexBuffer);
          stepPass.draw(6);
          stepPass.end();
          rdSrcIdx = rdDst;
        }
        const rdCompBG = rdCompBGs![srcIdx];
        const rdCompPass = enc.beginRenderPass({
          colorAttachments: [
            {
              view: renderTargets[dstIdx].createView(),
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: { r: 0, g: 0, b: 0, a: 1 }
            }
          ]
        });
        rdCompPass.setPipeline(pipelines.rdComposite);
        rdCompPass.setBindGroup(0, rdCompBG);
        rdCompPass.setBindGroup(1, uniformBindGroup);
        rdCompPass.setVertexBuffer(0, vertexBuffer);
        rdCompPass.draw(6);
        rdCompPass.end();
        srcIdx = dstIdx;
      } else {
        const pipeline = pipelines.effects.get(effect)!;
        const bg =
          shaderEffects[effect].stage === 'feedback'
            ? historyBindGroups![srcIdx][histIdx]!
            : rtBindGroups![srcIdx];
        const effectPass = enc.beginRenderPass({
          colorAttachments: [
            {
              view: renderTargets[dstIdx].createView(),
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: { r: 0, g: 0, b: 0, a: 1 }
            }
          ]
        });
        effectPass.setPipeline(pipeline);
        effectPass.setBindGroup(0, bg);
        effectPass.setBindGroup(1, uniformBindGroup);
        effectPass.setVertexBuffer(0, vertexBuffer);
        effectPass.draw(6);
        effectPass.end();
        srcIdx = dstIdx;
      }
    }

    // Passthrough final RT → canvas
    const finalPass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 }
        }
      ]
    });
    finalPass.setPipeline(pipelines.passthrough);
    finalPass.setBindGroup(0, rtBindGroups![srcIdx]);
    finalPass.setBindGroup(1, uniformBindGroup);
    finalPass.setVertexBuffer(0, vertexBuffer);
    finalPass.draw(6);
    finalPass.end();

    device.queue.submit([enc.finish()]);

    // Rotate history: the RT that just received the final output becomes next frame's history.
    histIdx = srcIdx;

    if (options.onFrameQuality && renderTargets && canvas && !qualityReadbackPending) {
      if (++qualityFrameCount >= 30) {
        qualityFrameCount = 0;
        qualityReadbackPending = true;
        scheduleQualityReadback(
          device,
          qualityReadbackBuffer,
          renderTargets[srcIdx],
          canvas.width,
          canvas.height,
          options.onFrameQuality,
          () => {
            qualityReadbackPending = false;
          }
        );
      }
    }

    const frameEnd = performance.now();
    const frameTime = frameEnd - frameStart;
    perfData.frameRing[perfData.frameHead & (FRAME_RING_SIZE - 1)] = frameStart;
    perfData.frameHead++;
    if (frameStart - perfData.lastReport > 200 && options.onRenderPerformance) {
      const cutoff = frameStart - 1000;
      let fps = 0;
      for (let i = 0; i < FRAME_RING_SIZE; i++) {
        if (perfData.frameRing[i] > cutoff) fps++;
      }
      options.onRenderPerformance(fps, frameTime);
      perfData.lastReport = frameStart;
    }

    rafId = requestAnimationFrame(renderFrame);
  }

  rafId = requestAnimationFrame(renderFrame);

  return () => {
    stopVideoWatch();
    cancelAnimationFrame(rafId);
    window.removeEventListener('resize', updateTargets);
    renderTargets?.forEach((t) => t.destroy());
    rdTextures?.forEach((t) => t.destroy());
    qualityReadbackBuffer.destroy();
    vertexBuffer.destroy();
    uniformBuffer.destroy();
    device.destroy();
  };
}
