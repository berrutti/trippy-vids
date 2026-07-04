import { onMounted, onUnmounted, ref } from 'vue';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface BeatmatcherDeck {
  id: string;
  isPlaying: boolean;
  bpm: number | null;
  beatOffsetSec: number;
  positionSec: number;
  playbackRate: number;
  nudgeFactor: number;
  effectiveBpm: number | null;
  currentBeat: number | null;
}

interface BeatmatcherStatePayload {
  schemaVersion: number;
  epochMs: number;
  sampleRate: number;
  decks: BeatmatcherDeck[];
}

const STALE_THRESHOLD_MS = 500;

export function useBeatmatcherLink() {
  const connected = ref(false);
  const decks = ref<BeatmatcherDeck[]>([]);

  let latest: BeatmatcherStatePayload | null = null;
  let unlisteners: UnlistenFn[] = [];

  function isStale(): boolean {
    return !latest || Date.now() - latest.epochMs > STALE_THRESHOLD_MS;
  }

  // There's no master deck in the protocol, so we auto-follow whatever is
  // currently playing: tempo is the average across playing decks (in practice
  // beatmatched DJ decks already share close to the same tempo), and phase
  // locks to one reference deck's own beat grid, since phase can't be averaged
  // across decks with different downbeats.
  function playingDecks(): BeatmatcherDeck[] {
    if (isStale() || !latest) return [];
    return latest.decks.filter(
      (d) => d.isPlaying && d.effectiveBpm !== null && d.currentBeat !== null
    );
  }

  // Extrapolates the reference deck's continuous beat count forward from the last
  // snapshot so playback stays sample-accurate between 50ms updates (see the phase
  // extrapolation formula in the Beatmatcher broadcast spec).
  function getBeatNow(): number | null {
    const reference = playingDecks()[0];
    if (!reference || !latest) return null;

    return (
      reference.currentBeat! +
      ((Date.now() - latest.epochMs) / 1000) * (reference.effectiveBpm! / 60)
    );
  }

  function getAverageBpm(): number | null {
    const playing = playingDecks();
    if (playing.length === 0) return null;
    return playing.reduce((sum, d) => sum + d.effectiveBpm!, 0) / playing.length;
  }

  // Returns time/bpm values that, fed into the existing beatPeriod/beatPhase shader
  // math in place of the free-running clock, land beat 0 exactly on the reference
  // deck's real downbeat (the bpm/time pair cancels out in that math regardless of
  // which bpm value is used, so feeding the average here doesn't shift the phase).
  function getBeatClock(): { time: number; bpm: number } | null {
    const beatNow = getBeatNow();
    const bpm = getAverageBpm();
    if (beatNow === null || bpm === null) return null;

    return { time: (beatNow * 60) / bpm, bpm };
  }

  onMounted(async () => {
    unlisteners = await Promise.all([
      listen<BeatmatcherStatePayload>('beatmatcher:state', (event) => {
        latest = event.payload;
        decks.value = event.payload.decks;
        connected.value = true;
      }),
      listen('beatmatcher:disconnected', () => {
        latest = null;
        decks.value = [];
        connected.value = false;
      })
    ]);
  });

  onUnmounted(() => {
    unlisteners.forEach((unlisten) => unlisten());
    unlisteners = [];
  });

  return { connected, decks, getBeatClock, getBeatNow, getAverageBpm };
}
