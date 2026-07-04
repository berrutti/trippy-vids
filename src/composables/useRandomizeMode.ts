import { ref, onUnmounted, type Ref } from 'vue';
import { ShaderEffect, shaderEffects } from '@/utils';
import type { VideoPlaylistItem } from '@/components/input/useVideoPlaylist';

const WAIT_BEATS = [16, 32] as const;
const KEEP_VIDEO_PROBABILITY = 0.2;
const LATE_THRESHOLD_BEATS = 1.5;

// Per-effect probability of appearing in a random snapshot.
// Sum ~5.3 across 14 effects → ~4-5 active on average.
// REALITY_GLITCH and PALETTE_CYCLING are kept rare so they feel special.
const EFFECT_WEIGHTS: Record<ShaderEffect, number> = {
  [ShaderEffect.INVERT]: 0.35,
  [ShaderEffect.GRAYSCALE]: 0.35,
  [ShaderEffect.REALITY_GLITCH]: 0.1,
  [ShaderEffect.KALEIDOSCOPE]: 0.5,
  [ShaderEffect.DISPLACE]: 0.45,
  [ShaderEffect.SWIRL]: 0.45,
  [ShaderEffect.CHROMA]: 0.5,
  [ShaderEffect.PIXELATE]: 0.4,
  [ShaderEffect.VORONOI]: 0.5,
  [ShaderEffect.RIPPLE]: 0.45,
  [ShaderEffect.FEEDBACK_ECHO]: 0.4,
  [ShaderEffect.PALETTE_CYCLING]: 0.15,
  [ShaderEffect.CONTOUR]: 0.45,
  [ShaderEffect.AURORA]: 0.4,
  [ShaderEffect.REACTION_DIFFUSION]: 0.2
};

export interface RandomizeSnapshot {
  videoIndex: number;
  seekFraction: number;
  effects: Record<ShaderEffect, boolean>;
  intensities: Record<ShaderEffect, number>;
}

const BEAT_POLL_MS = 50;

export function useRandomizeMode(
  bpm: Ref<number>,
  videoPlaylist: Ref<VideoPlaylistItem[]>,
  loadedVideoIndex: Ref<number>,
  onApply: (snapshot: RandomizeSnapshot) => void,
  onSchedule?: (snapshot: RandomizeSnapshot) => void,
  // Continuous, phase-locked beat count from an external clock (e.g. Beatmatcher).
  // When it returns a number, phrase switches lock to real phrase boundaries instead
  // of counting from whenever randomize mode happened to be toggled on.
  getBeatNow?: () => number | null
) {
  const isActive = ref(false);
  const beatProgress = ref<{ beat: number; total: number } | null>(null);
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let progressIntervalId: ReturnType<typeof setInterval> | null = null;
  let beatPollId: ReturnType<typeof setInterval> | null = null;
  let intervalStart = 0;
  let intervalTotal = 0;
  let intervalStartBeat = 0;
  let pendingSnapshot: RandomizeSnapshot | null = null;

  // Local re-stamp of "beat 1", since Beatmatcher's beat grid can be mis-analyzed
  // or the user may simply want phrase switches to land on a different downbeat.
  let phraseOffset = 0;

  function buildEffects(): {
    effects: Record<ShaderEffect, boolean>;
    intensities: Record<ShaderEffect, number>;
  } {
    const effects = Object.values(ShaderEffect).reduce(
      (acc, e) => ({ ...acc, [e]: false }),
      {} as Record<ShaderEffect, boolean>
    );
    const intensities = Object.values(ShaderEffect).reduce(
      (acc, e) => ({ ...acc, [e]: shaderEffects[e].intensity ?? 1.0 }),
      {} as Record<ShaderEffect, number>
    );

    const selected: ShaderEffect[] = [];
    for (const e of Object.values(ShaderEffect)) {
      if (Math.random() < EFFECT_WEIGHTS[e]) {
        selected.push(e);
      }
    }

    // Guarantee at least one effect, excluding the two noisiest so a solo appearance is pleasant
    if (selected.length === 0) {
      const candidates = Object.values(ShaderEffect).filter(
        (e) => e !== ShaderEffect.REALITY_GLITCH && e !== ShaderEffect.PALETTE_CYCLING
      );
      selected.push(candidates[Math.floor(Math.random() * candidates.length)]);
    }

    for (const e of selected) {
      effects[e] = true;
      if (shaderEffects[e].intensity !== undefined) {
        intensities[e] = 0.3 + Math.random() * 0.7;
      }
    }

    return { effects, intensities };
  }

  function pickVideoIndex(): number {
    const playlist = videoPlaylist.value;
    if (playlist.length <= 1) return 0;

    if (Math.random() < KEEP_VIDEO_PROBABILITY) {
      return loadedVideoIndex.value;
    }

    const otherIndices = playlist.map((_, i) => i).filter((i) => i !== loadedVideoIndex.value);
    return otherIndices[Math.floor(Math.random() * otherIndices.length)];
  }

  function buildSnapshot(): RandomizeSnapshot {
    return {
      videoIndex: pickVideoIndex(),
      seekFraction: 0.05 + Math.random() * 0.85,
      ...buildEffects()
    };
  }

  function updateBeatProgress() {
    if (!isActive.value || intervalTotal === 0) {
      beatProgress.value = null;
      return;
    }
    const beatMs = (60 / bpm.value) * 1000;
    const elapsed = performance.now() - intervalStart;
    const beat = Math.min(Math.floor(elapsed / beatMs) + 1, intervalTotal);
    beatProgress.value = { beat, total: intervalTotal };
  }

  function nextPhraseBoundary(beatNow: number, total: number): number {
    const cyclesPassed = Math.floor((beatNow - phraseOffset) / total);
    return phraseOffset + (cyclesPassed + 1) * total;
  }

  function updateBeatProgressFromBeat(beatNow: number) {
    if (!isActive.value || intervalTotal === 0) {
      beatProgress.value = null;
      return;
    }
    const beat = Math.min(Math.max(1, Math.floor(beatNow - intervalStartBeat) + 1), intervalTotal);
    beatProgress.value = { beat, total: intervalTotal };
  }

  function scheduleNextBeatDriven(fromBeat: number) {
    const total = WAIT_BEATS[Math.floor(Math.random() * WAIT_BEATS.length)];
    const nextSwitchBeat = nextPhraseBoundary(fromBeat, total);
    intervalStartBeat = nextSwitchBeat - total;
    intervalTotal = total;

    pendingSnapshot = buildSnapshot();
    onSchedule?.(pendingSnapshot);
  }

  function pollBeatClock() {
    const beatNow = getBeatNow?.();
    if (beatNow === null || beatNow === undefined) return;
    updateBeatProgressFromBeat(beatNow);

    const targetBeat = intervalStartBeat + intervalTotal;
    if (beatNow >= targetBeat && pendingSnapshot) {
      const snapshot = pendingSnapshot;
      onApply(snapshot);
      // If the poll picked this up more than 1.5 beats past the target (tab was
      // backgrounded, system slept, etc.), re-anchor from now instead of replaying
      // every missed phrase boundary in a rapid-fire catch-up burst.
      const fireLate = beatNow - targetBeat;
      scheduleNextBeatDriven(fireLate > LATE_THRESHOLD_BEATS ? beatNow : targetBeat);
    }
  }

  // Re-stamps "beat 1" to the current instant and re-schedules the pending switch onto
  // the new phrase grid. Works whether or not an external beat clock (e.g. Beatmatcher)
  // is driving scheduling — with no external clock, it just restarts the wall-clock
  // phrase timer from now, letting the user resync switches to what they're hearing.
  function restartBeat() {
    if (!isActive.value) return;

    const beatNow = getBeatNow?.();
    if (beatNow !== null && beatNow !== undefined) {
      phraseOffset = beatNow;
      if (beatPollId !== null) scheduleNextBeatDriven(beatNow);
      return;
    }

    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      scheduleNext(performance.now());
    }
  }

  function scheduleNext(start: number) {
    const total = WAIT_BEATS[Math.floor(Math.random() * WAIT_BEATS.length)];
    const beatMs = (60 / bpm.value) * 1000;
    const nextStart = start + total * beatMs;
    const delay = Math.max(0, nextStart - performance.now());

    intervalStart = start;
    intervalTotal = total;

    const nextSnapshot = buildSnapshot();
    onSchedule?.(nextSnapshot);

    timeoutId = setTimeout(() => {
      if (!isActive.value) return;
      onApply(nextSnapshot);
      // If the timer fired more than 1.5 beats late (fullscreen transition, app suspend,
      // etc.), re-anchor from now so subsequent switches resume correctly rather than
      // cascading at zero delay trying to catch up.
      const fireLate = performance.now() - nextStart;
      scheduleNext(fireLate > beatMs * 1.5 ? performance.now() : nextStart);
    }, delay);
  }

  function toggle() {
    if (isActive.value) {
      isActive.value = false;
      beatProgress.value = null;
      pendingSnapshot = null;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (progressIntervalId !== null) {
        clearInterval(progressIntervalId);
        progressIntervalId = null;
      }
      if (beatPollId !== null) {
        clearInterval(beatPollId);
        beatPollId = null;
      }
    } else {
      isActive.value = true;
      const firstSnapshot = buildSnapshot();
      onApply(firstSnapshot);

      const beatNow = getBeatNow?.();
      if (beatNow !== null && beatNow !== undefined) {
        scheduleNextBeatDriven(beatNow);
        beatPollId = setInterval(pollBeatClock, BEAT_POLL_MS);
      } else {
        scheduleNext(performance.now());
        progressIntervalId = setInterval(updateBeatProgress, 80);
      }
    }
  }

  onUnmounted(() => {
    if (timeoutId !== null) clearTimeout(timeoutId);
    if (progressIntervalId !== null) clearInterval(progressIntervalId);
    if (beatPollId !== null) clearInterval(beatPollId);
  });

  return { isActive, beatProgress, toggle, restartBeat };
}
