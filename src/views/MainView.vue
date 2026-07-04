<template>
  <div
    class="main-view"
    :class="{ 'cursor-hidden': cursorHidden }"
    @contextmenu.prevent="openControls"
    @mousemove="onMouseMove"
  >
    <div v-if="showSplash" id="splash">
      <svg id="splash-logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
        <rect width="1024" height="1024" rx="224" ry="224" fill="white" />
        <circle cx="512" cy="347" r="190" fill="#EE44A8" />
        <circle cx="322" cy="676" r="190" fill="#22B8EE" />
        <circle cx="702" cy="676" r="190" fill="#F5C820" />
      </svg>
      <div id="splash-name">Performer</div>
    </div>
    <canvas ref="canvasRef" class="main-canvas" @dblclick="toggleFullscreen" />
    <video ref="videoRef" class="hidden-video" crossorigin="anonymous" />
    <video ref="randomizeRef1" class="hidden-video" preload="auto" crossorigin="anonymous" />
    <video ref="randomizeRef2" class="hidden-video" preload="auto" crossorigin="anonymous" />

    <div v-if="showNotRenderableWarning" class="canvas-overlay canvas-overlay--warn">
      video format not supported by renderer
    </div>

    <div v-if="showRendererUnavailable" class="canvas-overlay canvas-overlay--warn">
      WebGPU is not available, rendering is disabled
    </div>

    <div v-if="showNoVideoMessage" class="canvas-overlay canvas-overlay--hint">
      {{
        playlist.videoPlaylist.value.length === 0
          ? 'right click to open controls and add videos'
          : 'double-click a video in the playlist to start'
      }}
    </div>

    <div v-if="settings.showHelp.value" class="help-overlay">
      <div>Right click to open controls | Spacebar to play / pause</div>
      <div class="help-stats">
        Version: {{ VERSION }} | GPU FPS: {{ fps }} | Frame Time: {{ frameTime.toFixed(2) }}ms
        <span v-if="midi.connected.value" class="external-connected"
          >MIDI: {{ midi.deviceName.value }}</span
        >
        <span v-else class="midi-disconnected">MIDI: Not connected</span>
        <span v-if="beatmatcher.connected.value" class="external-connected"
          >Beatmatcher: connected</span
        >
        <span v-else class="midi-disconnected">Beatmatcher: not connected</span>
      </div>
      <div v-if="showMidiSyncNotification" class="midi-sync-notification">
        MIDI Connected! Move each knob slightly to sync with current positions
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, watchEffect, onMounted, onUnmounted, toRaw } from 'vue';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { ShaderEffect, shaderEffects, buildEffectRecord } from '@/utils';
import { useSettings } from '@/composables/useSettings';
import { useEffectTransitions } from '@/components/effects/useEffectTransitions';
import { useVideoPlaylist } from '@/components/input/useVideoPlaylist';
import { useVideoPlayer } from '@/components/input/useVideoPlayer';
import { useVideoSource } from '@/components/input/useVideoSource';
import { useMidi } from '@/composables/useMidi';
import { useBeatmatcherLink } from '@/composables/useBeatmatcherLink';
import { useWebGPURenderer } from '@/composables/useWebGPURenderer';
import { useRandomizeMode } from '@/composables/useRandomizeMode';
import { useFrameQualityGuard } from '@/composables/useFrameQualityGuard';
import { CHANNEL_NAME, type FromControls, type FromMain } from '@/broadcast';
import packageJson from '../../package.json';

const VERSION = packageJson.version;
const MIDI_NOTIFICATION_DURATION_MS = 5000;

const canvasRef = ref<HTMLCanvasElement | null>(null);

async function toggleFullscreen() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();
  const isFs = await win.isFullscreen();
  await win.setFullscreen(!isFs);
}
const videoRef = ref<HTMLVideoElement | null>(null);
const randomizeRef1 = ref<HTMLVideoElement | null>(null);
const randomizeRef2 = ref<HTMLVideoElement | null>(null);

const fps = ref(0);
const frameTime = ref(0);
const showMidiSyncNotification = ref(false);
const showSplash = ref(true);
const showNotRenderableWarning = ref(false);
const showRendererUnavailable = ref(false);

// Set once the user has ever started playback — suppresses the hint permanently
// so a brief not-playing state during video transitions doesn't flash the message.
const videoEverStarted = ref(false);

const initialActiveEffects = buildEffectRecord(() => false);
const initialIntensities = buildEffectRecord((e) => shaderEffects[e].intensity ?? 0);

const settings = useSettings();
const bpm = settings.bpm;
const beatmatcher = useBeatmatcherLink();
const effectTransitions = useEffectTransitions(initialActiveEffects, initialIntensities);
const playlist = useVideoPlaylist(settings.inputSource);
const player = useVideoPlayer({
  videoRef,
  randomizeRef1,
  randomizeRef2,
  videoPlaylist: playlist.videoPlaylist,
  selectedVideoIndex: playlist.selectedVideoIndex,
  inputSource: settings.inputSource,
  isMuted: settings.isMuted
});

useVideoSource(videoRef, settings.inputSource, player.loadedVideoIndex, playlist.videoPlaylist);

const randomize = useRandomizeMode(
  bpm,
  playlist.videoPlaylist,
  player.loadedVideoIndex,
  (snapshot) => {
    effectTransitions.setActiveEffects(snapshot.effects);
    effectTransitions.setEffectIntensities(snapshot.intensities);
    player.applyVideoSnapshot(snapshot);
  },
  player.preloadUpcomingVideo,
  () => beatmatcher.getBeatNow()
);

watch(
  () => randomize.isActive.value,
  (active) => {
    if (!active) player.onRandomizeDeactivated();
  }
);

watch(
  () => player.isVideoPlaying.value,
  (playing) => {
    if (playing) videoEverStarted.value = true;
    else showNotRenderableWarning.value = false;
  }
);

const { onQualityData } = useFrameQualityGuard(
  computed(() => effectTransitions.renderingEffects.value),
  effectTransitions.renderingIntensities,
  (effect, intensity) => effectTransitions.handleIntensityChange(effect, intensity)
);

function handleRenderPerformance(renderFps: number, renderFrameTime: number) {
  fps.value = renderFps;
  frameTime.value = renderFrameTime;
}

useWebGPURenderer({
  canvasRef,
  videoRef: player.rendererVideoRef,
  activeEffects: effectTransitions.renderingEffects,
  effectIntensities: effectTransitions.renderingIntensities,
  bpmSyncEnabled: computed(() => effectTransitions.bpmSyncEnabled.value),
  bpm,
  getBeatClock: () => beatmatcher.getBeatClock(),
  onRenderPerformance: handleRenderPerformance,
  onFrameQuality: (lumaAvg, variance) => {
    if (randomize.isActive.value) onQualityData(lumaAvg, variance);
  },
  onVideoNotRenderable: () => {
    showNotRenderableWarning.value = true;
  },
  onRendererUnavailable: () => {
    showRendererUnavailable.value = true;
  }
});

const midi = useMidi({
  onEffectToggle: (effect: ShaderEffect) => effectTransitions.handleToggleEffect(effect),
  onIntensityChange: (effect: ShaderEffect, intensity: number) => {
    effectTransitions.setEffectIntensities({
      ...effectTransitions.effectIntensities.value,
      [effect]: intensity
    });
  },
  onMidiConnect: () => {
    showMidiSyncNotification.value = true;
    setTimeout(() => {
      showMidiSyncNotification.value = false;
    }, MIDI_NOTIFICATION_DURATION_MS);
  },
  activeEffects: effectTransitions.activeEffects
});

const showNoVideoMessage = computed(
  () =>
    settings.inputSource.value === 'video' &&
    !player.isVideoPlaying.value &&
    !player.videoPausedManually.value &&
    !videoEverStarted.value
);

const appState = computed(() => ({
  activeEffects: { ...effectTransitions.activeEffects.value },
  beatmatcherAvgBpm: beatmatcher.getAverageBpm(),
  beatmatcherConnected: beatmatcher.connected.value,
  beatmatcherDecks: beatmatcher.decks.value.map((deck) => ({ ...deck })),
  beatmatcherFollowing: beatmatcher.getAverageBpm() !== null,
  effectIntensities: { ...effectTransitions.effectIntensities.value },
  bpmSyncEnabled: { ...effectTransitions.bpmSyncEnabled.value },
  inputSource: settings.inputSource.value,
  isMuted: settings.isMuted.value,
  isRandomizeActive: randomize.isActive.value,
  randomizeBeat: randomize.beatProgress.value ? { ...randomize.beatProgress.value } : null,
  midiActiveBank: midi.activeBank.value,
  midiConnected: midi.connected.value,
  midiDeviceName: midi.deviceName.value,
  bpm: bpm.value,
  isHelpVisible: settings.showHelp.value,
  videoPlaylist: toRaw(playlist.videoPlaylist.value).map((item) => ({ ...toRaw(item) })),
  selectedVideoIndex: playlist.selectedVideoIndex.value,
  loadedVideoIndex: player.loadedVideoIndex.value,
  isVideoPlaying: player.isVideoPlaying.value,
  currentTime: player.currentTime.value,
  duration: player.duration.value
}));

let channel: BroadcastChannel | null = null;

function handleAction(msg: FromControls) {
  switch (msg.type) {
    case 'request-state':
      channel?.postMessage({ type: 'state', payload: appState.value } satisfies FromMain);
      break;
    case 'toggle-effect':
      effectTransitions.handleToggleEffect(msg.effect);
      break;
    case 'intensity-change':
      effectTransitions.handleIntensityChange(msg.effect, msg.intensity);
      break;
    case 'input-source-change':
      settings.inputSource.value = msg.source;
      break;
    case 'mute-toggle':
      settings.isMuted.value = !settings.isMuted.value;
      break;
    case 'toggle-help':
      settings.showHelp.value = !settings.showHelp.value;
      break;
    case 'bpm-change':
      bpm.value = msg.bpm;
      break;
    case 'restart-beat':
      randomize.restartBeat();
      break;
    case 'bpm-sync-change':
      effectTransitions.setBpmSyncEnabled(msg.effect, msg.enabled);
      break;
    case 'video-select':
      playlist.selectedVideoIndex.value = msg.index;
      break;
    case 'video-play':
      player.handleVideoPlay(msg.index);
      break;
    case 'video-play-pause':
      player.handleVideoPlayPause();
      break;
    case 'next-video':
      player.handleNextVideo();
      break;
    case 'previous-video':
      player.handlePreviousVideo();
      break;
    case 'add-videos':
      playlist.handleAddVideosToPlaylist(msg.paths);
      break;
    case 'remove-from-playlist':
      player.handleVideoRemoved(
        playlist.removeVideoFromList(msg.id, player.loadedVideoIndex.value)
      );
      break;
    case 'seek':
      player.handleSeek(msg.time);
      break;
    case 'seek-start':
      player.handleSeekStart();
      break;
    case 'seek-end':
      player.handleSeekEnd();
      break;
    case 'toggle-randomize':
      randomize.toggle();
      break;
  }
}

function onSpacebar(e: KeyboardEvent) {
  if (e.repeat) return;
  if (e.code !== 'Space') return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  if (settings.inputSource.value !== 'video') return;
  e.preventDefault();
  player.handleVideoPlayPause();
}

const cursorHidden = ref(false);
let cursorHideTimer: ReturnType<typeof setTimeout> | null = null;

function onMouseMove() {
  cursorHidden.value = false;
  if (cursorHideTimer !== null) clearTimeout(cursorHideTimer);
  cursorHideTimer = setTimeout(() => {
    cursorHidden.value = true;
  }, 2000);
}

onMounted(() => {
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (e: MessageEvent<FromControls>) => handleAction(e.data);
  window.addEventListener('keydown', onSpacebar);
  setTimeout(() => {
    showSplash.value = false;
  }, 800);
});

onUnmounted(() => {
  window.removeEventListener('keydown', onSpacebar);
  channel?.close();
  if (cursorHideTimer !== null) clearTimeout(cursorHideTimer);
});

watchEffect(() => {
  const state = appState.value; // always read so Vue tracks deps even when channel is null
  if (channel) {
    channel.postMessage({ type: 'state', payload: state } satisfies FromMain);
  }
});

async function openControls() {
  const existing = await WebviewWindow.getByLabel('controls');
  if (existing) {
    await existing.show();
    await existing.setFocus();
    return;
  }
  new WebviewWindow('controls', {
    url: window.location.href.split('#')[0] + '#controls',
    title: 'Performer',
    width: 900,
    height: 700,
    resizable: true
  });
}
</script>

<style scoped>
.main-view {
  position: relative;
  width: 100vw;
  height: 100vh;
  background-color: black;
  overflow: hidden;
}

.cursor-hidden,
.cursor-hidden * {
  cursor: none !important;
}

.main-canvas {
  width: 100%;
  height: 100%;
  display: block;
}

.hidden-video {
  display: none;
}

.canvas-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font, monospace);
  font-size: 13px;
  pointer-events: none;
}

.canvas-overlay--warn {
  color: rgba(255, 255, 255, 0.5);
}

.canvas-overlay--hint {
  color: rgba(255, 255, 255, 0.3);
}

.help-overlay {
  position: absolute;
  bottom: 20px;
  width: 100%;
  text-align: center;
  color: white;
  pointer-events: none;
}

.help-stats {
  font-size: 12px;
  margin-top: 5px;
  opacity: 0.8;
}

.external-connected {
  color: #a855f7;
  margin-left: 10px;
}

.midi-disconnected {
  color: #ef4444;
  margin-left: 10px;
}

.midi-sync-notification {
  font-size: 14px;
  margin-top: 10px;
  color: #ffff00;
  background-color: rgba(0, 0, 0, 0.8);
  padding: 10px 20px;
  border-radius: 4px;
  display: inline-block;
}

#splash {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: #0a0a0a;
  font-family: 'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
  gap: 14px;
  pointer-events: none;
  z-index: 10;
}

#splash-name {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.15em;
  color: #e8e8e8;
}

#splash-logo {
  width: 72px;
  height: 72px;
  animation: splash-icon 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
}

@keyframes splash-icon {
  from {
    transform: scale(1.5);
    opacity: 0;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}
</style>
