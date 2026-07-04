<template>
  <div class="tab-content">
    <div class="bpm-row">
      <span class="bpm-label">BPM</span>
      <input
        type="number"
        class="bpm-input"
        :value="localBpm"
        min="40"
        max="300"
        step="0.1"
        :disabled="beatmatcherFollowing"
        @focus="bpmFocused = true"
        @blur="bpmFocused = false"
        @input="localBpm = Number(($event.target as HTMLInputElement).value)"
        @change="onBpmChange"
        @keydown.enter="($event.target as HTMLInputElement).blur()"
      />
      <span v-if="randomizeBeat" class="beat-counter">
        {{ randomizeBeat.beat }}&thinsp;/&thinsp;{{ randomizeBeat.total }}
      </span>
    </div>

    <div class="beat-source-row">
      <span
        class="beatmatcher-status"
        :class="beatmatcherConnected ? 'beatmatcher-status--on' : 'beatmatcher-status--off'"
      >
        {{ beatmatcherStatusText }}
      </span>
      <button
        v-if="randomizeBeat"
        class="restart-beat-btn"
        title="Restart randomize's phrase count from now. Use this if a Beatmatcher deck's grid is mis-analyzed, or to resync manual-BPM switches to what you're hearing."
        @click="emit('restart-beat')"
      >
        Restart beat
      </button>
    </div>

    <div v-if="midiConnected" class="midi-status">
      <div class="midi-indicator">MIDI: {{ midiDeviceName }}</div>
      <p class="control-description">
        Pads toggle effects. Knobs control the highlighted intensities. Press Shift to switch knob
        bank ({{ midiActiveBank + 1 }}/{{ KNOB_BANK_COUNT }}).
      </p>
    </div>

    <div class="effects-grid">
      <div
        v-for="effect in orderedEffects"
        :key="effect"
        :class="[
          'effect-btn',
          activeEffects[effect] ? 'effect-btn--on' : '',
          midiControlledEffects.has(effect) ? 'effect-btn--midi' : ''
        ]"
      >
        <button class="effect-btn__toggle" @click="emit('toggle-effect', effect)">
          <span class="effect-btn__name">{{ formatName(effect) }}</span>
          <span
            v-if="midiConnected"
            class="effect-btn__midi-dot"
            :class="{ 'effect-btn__midi-dot--inactive': !midiControlledEffects.has(effect) }"
          />
        </button>
        <input
          v-if="shaderEffects[effect].intensity !== undefined"
          type="range"
          class="effect-btn__slider"
          min="0"
          max="1"
          step="0.01"
          :value="effectIntensities[effect]"
          :disabled="midiConnected && midiControlledEffects.has(effect)"
          @input="
            emit('intensity-change', effect, parseFloat(($event.target as HTMLInputElement).value))
          "
        />
        <button
          v-if="shaderEffects[effect].bpmSync"
          class="effect-btn__sync"
          :class="{ 'effect-btn__sync--on': bpmSyncEnabled[effect] }"
          :title="
            bpmSyncEnabled[effect]
              ? 'BPM sync on - click to disable'
              : 'BPM sync off - click to enable'
          "
          @click="emit('bpm-sync-change', effect, !bpmSyncEnabled[effect])"
        >
          {{ bpmSyncEnabled[effect] ? '▶ BPM' : '○ BPM' }}
        </button>
      </div>
    </div>

    <div class="checkbox-group">
      <input
        id="show-help"
        type="checkbox"
        class="control-checkbox"
        :checked="helpVisible"
        @change="emit('toggle-help')"
      />
      <label for="show-help" class="checkbox-label">Show help overlay</label>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ShaderEffect, shaderEffects } from '@/utils';
import { KNOB_EFFECT_ORDER, KNOB_BANK_SIZE, KNOB_BANK_COUNT } from '@/composables/useMidi';
import type { BeatmatcherDeck } from '@/composables/useBeatmatcherLink';

const props = withDefaults(
  defineProps<{
    activeEffects: Record<ShaderEffect, boolean>;
    effectIntensities: Record<ShaderEffect, number>;
    bpmSyncEnabled: Record<ShaderEffect, boolean>;
    helpVisible: boolean;
    midiConnected?: boolean;
    midiDeviceName?: string;
    midiActiveBank?: number;
    bpm: number;
    randomizeBeat?: { beat: number; total: number } | null;
    beatmatcherAvgBpm: number | null;
    beatmatcherConnected: boolean;
    beatmatcherDecks: BeatmatcherDeck[];
    beatmatcherFollowing: boolean;
  }>(),
  {
    midiConnected: false,
    midiDeviceName: '',
    midiActiveBank: 0,
    randomizeBeat: null
  }
);

const emit = defineEmits<{
  'toggle-effect': [effect: ShaderEffect];
  'intensity-change': [effect: ShaderEffect, intensity: number];
  'bpm-sync-change': [effect: ShaderEffect, enabled: boolean];
  'toggle-help': [];
  'bpm-change': [bpm: number];
  'restart-beat': [];
}>();

const beatmatcherStatusText = computed(() => {
  if (!props.beatmatcherConnected) return 'Beatmatcher: not connected';
  if (!props.beatmatcherFollowing) return 'Beatmatcher: connected, no deck playing';
  const playing = props.beatmatcherDecks.filter((d) => d.isPlaying && d.effectiveBpm !== null);
  const deckIds = playing.map((d) => d.id).join(', ');
  return `Following ${deckIds}: ${props.beatmatcherAvgBpm?.toFixed(1)} BPM`;
});

const midiControlledEffects = computed<ReadonlySet<ShaderEffect>>(() => {
  if (!props.midiConnected) return new Set();
  const start = props.midiActiveBank * KNOB_BANK_SIZE;
  return new Set(KNOB_EFFECT_ORDER.slice(start, start + KNOB_BANK_SIZE));
});

const orderedEffects: ShaderEffect[] = [
  ...KNOB_EFFECT_ORDER,
  ...Object.values(ShaderEffect).filter((effect) => !KNOB_EFFECT_ORDER.includes(effect))
];

const localBpm = ref(props.bpm);
const bpmFocused = ref(false);

watch(
  () => props.bpm,
  (val) => {
    if (!bpmFocused.value) localBpm.value = val;
  }
);

function formatName(effect: ShaderEffect): string {
  return effect.replace(/_/g, ' ');
}

function onBpmChange(e: Event) {
  const val = parseFloat((e.target as HTMLInputElement).value);
  if (!isNaN(val) && val >= 40 && val <= 300) {
    localBpm.value = val;
    emit('bpm-change', val);
  }
}
</script>
