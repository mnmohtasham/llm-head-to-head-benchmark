import { LONG_INSTRUCTION, presetPrompt, PRESETS, type TextConfig } from '@duel/shared';
import { ON_LIBERTY } from './on-liberty';

/** The prompt a text config sends, with the preset's text filled in. */
export function resolvePrompt(config: Pick<TextConfig, 'preset' | 'prompt'>): string {
  return presetPrompt(config.preset, ON_LIBERTY, config.prompt);
}

export interface PresetView {
  id: string;
  label: string;
  description: string;
  words: number;
  /** The prompt itself, or for the long presets its start and end. */
  preview: string;
}

export function presetViews(): PresetView[] {
  return PRESETS.filter((preset) => preset.id !== 'custom').map((preset) => {
    const prompt = resolvePrompt({ preset: preset.id, prompt: '' });
    const long = prompt.length > 1200;
    return {
      id: preset.id,
      label: preset.label,
      description: preset.description,
      words: prompt.split(/\s+/).filter(Boolean).length,
      preview: long ? `${prompt.slice(0, 600).trimEnd()} …\n\n${LONG_INSTRUCTION}` : prompt,
    };
  });
}
