import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ref } from 'vue';
import { withSetup } from '@/test/utils';
import { useRandomizeMode } from './useRandomizeMode';
import { ShaderEffect } from '@/utils';
import type { VideoPlaylistItem } from '@/components/input/useVideoPlaylist';

function makePlaylist(n: number): VideoPlaylistItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `video-${i}`,
    name: `video${i}.mp4`,
    src: `asset://localhost/video${i}.mp4`,
    path: `/video${i}.mp4`
  }));
}

describe('useRandomizeMode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('calls onApply immediately when toggled on', () => {
    const onApply = vi.fn();
    const [result, cleanup] = withSetup(() =>
      useRandomizeMode(ref(120), ref(makePlaylist(2)), ref(0), onApply)
    );
    result.toggle();
    expect(onApply).toHaveBeenCalledOnce();
    cleanup();
  });

  it('calls onApply again after the beat interval', () => {
    const onApply = vi.fn();
    const [result, cleanup] = withSetup(() =>
      useRandomizeMode(ref(60), ref(makePlaylist(2)), ref(0), onApply)
    );
    result.toggle();
    onApply.mockClear();
    // at 60 bpm, max wait is 32 beats = 32 s — advance past that to guarantee firing
    vi.advanceTimersByTime(33000);
    expect(onApply).toHaveBeenCalled();
    cleanup();
  });

  it('re-anchors from now instead of rapid-firing catch-up switches after a long gap in a beat-driven clock', () => {
    const onApply = vi.fn();
    let beatNow = 0;
    const [result, cleanup] = withSetup(() =>
      useRandomizeMode(ref(120), ref(makePlaylist(2)), ref(0), onApply, undefined, () => beatNow)
    );
    result.toggle();
    onApply.mockClear();

    // Simulate a long gap (system sleep, backgrounded tab, etc.): the external beat
    // clock jumps far past the next scheduled switch target in one poll tick.
    beatNow = 10000;
    vi.advanceTimersByTime(50);
    expect(onApply).toHaveBeenCalledTimes(1);

    // Having re-anchored to "now", it must not immediately fire again on the very
    // next poll tick even though beatNow is still numerically past the old target.
    vi.advanceTimersByTime(50);
    expect(onApply).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it('calls onSchedule when the next snapshot is queued', () => {
    const onApply = vi.fn();
    const onSchedule = vi.fn();
    const [result, cleanup] = withSetup(() =>
      useRandomizeMode(ref(60), ref(makePlaylist(2)), ref(0), onApply, onSchedule)
    );
    result.toggle();
    expect(onSchedule).toHaveBeenCalled();
    cleanup();
  });

  it('stops firing after being toggled off', () => {
    const onApply = vi.fn();
    const [result, cleanup] = withSetup(() =>
      useRandomizeMode(ref(60), ref(makePlaylist(2)), ref(0), onApply)
    );
    result.toggle();
    result.toggle();
    onApply.mockClear();
    vi.advanceTimersByTime(60000);
    expect(onApply).not.toHaveBeenCalled();
    cleanup();
  });

  it('isActive reflects toggle state', () => {
    const [result, cleanup] = withSetup(() =>
      useRandomizeMode(ref(120), ref(makePlaylist(2)), ref(0), vi.fn())
    );
    expect(result.isActive.value).toBe(false);
    result.toggle();
    expect(result.isActive.value).toBe(true);
    result.toggle();
    expect(result.isActive.value).toBe(false);
    cleanup();
  });

  it('snapshot always has at least one effect active', () => {
    const onApply = vi.fn();
    const [result, cleanup] = withSetup(() =>
      useRandomizeMode(ref(120), ref(makePlaylist(2)), ref(0), onApply)
    );
    for (let i = 0; i < 30; i++) {
      result.toggle();
      result.toggle();
    }
    for (const [snapshot] of onApply.mock.calls) {
      expect(Object.values(snapshot.effects).some(Boolean)).toBe(true);
    }
    cleanup();
  });

  it('seekFraction stays within the safe 0.05–0.90 range', () => {
    const onApply = vi.fn();
    const [result, cleanup] = withSetup(() =>
      useRandomizeMode(ref(120), ref(makePlaylist(2)), ref(0), onApply)
    );
    for (let i = 0; i < 30; i++) {
      result.toggle();
      result.toggle();
    }
    for (const [snapshot] of onApply.mock.calls) {
      expect(snapshot.seekFraction).toBeGreaterThanOrEqual(0.05);
      expect(snapshot.seekFraction).toBeLessThanOrEqual(0.9);
    }
    cleanup();
  });

  it('snapshot intensities are in the 0.3–1.0 range', () => {
    const onApply = vi.fn();
    const [result, cleanup] = withSetup(() =>
      useRandomizeMode(ref(120), ref(makePlaylist(2)), ref(0), onApply)
    );
    for (let i = 0; i < 30; i++) {
      result.toggle();
      result.toggle();
    }
    for (const [snapshot] of onApply.mock.calls) {
      for (const effect of Object.values(ShaderEffect)) {
        if (snapshot.effects[effect]) {
          expect(snapshot.intensities[effect]).toBeGreaterThanOrEqual(0.3);
          expect(snapshot.intensities[effect]).toBeLessThanOrEqual(1.0);
        }
      }
    }
    cleanup();
  });

  it('picks a different video index at least some of the time with multiple videos', () => {
    const onApply = vi.fn();
    const [result, cleanup] = withSetup(() =>
      useRandomizeMode(ref(120), ref(makePlaylist(5)), ref(0), onApply)
    );
    for (let i = 0; i < 50; i++) {
      result.toggle();
      result.toggle();
    }
    const indices = onApply.mock.calls.map(([s]) => s.videoIndex);
    const unique = new Set(indices);
    expect(unique.size).toBeGreaterThan(1);
    cleanup();
  });
});
