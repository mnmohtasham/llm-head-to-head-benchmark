/**
 * Prompt presets. The long ones are cut from the start of Mill's "On Liberty", which the server
 * holds, and end with a fixed instruction; their exact token count comes from each machine's own
 * tokenizer in pre-flight.
 */
export const PRESET_IDS = [
  'short',
  'long-8k',
  'long-32k',
  'puzzle',
  'code',
  'fixed-length',
  'custom',
] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export interface PresetInfo {
  id: PresetId;
  label: string;
  description: string;
}

export const PRESETS: readonly PresetInfo[] = [
  { id: 'short', label: 'Short', description: 'A one-line question with a one-sentence answer.' },
  {
    id: 'long-8k',
    label: '8K',
    description:
      'The opening of Mill’s On Liberty, about 7,600 tokens, then a request for a five-point summary. Fits an 8,192-token context with room for 512 tokens of output.',
  },
  {
    id: 'long-32k',
    label: '32K',
    description:
      'More of On Liberty, about 30,400 tokens, then the same summary request. Fits a 32,768-token context with room for 2,048 tokens of output.',
  },
  {
    id: 'puzzle',
    label: 'Puzzle',
    description: 'A reasoning puzzle that rewards careful thinking.',
  },
  { id: 'code', label: 'Code', description: 'A small programming task with tests.' },
  {
    id: 'fixed-length',
    label: 'Fixed length',
    description:
      'A prompt no model finishes, so every machine writes exactly Max tokens. Takes output length out of the comparison.',
  },
  { id: 'custom', label: 'Custom', description: 'Your own prompt.' },
];

export const SHORT_PROMPT =
  'In one sentence, what is the difference between latency and throughput?';

export const PUZZLE_PROMPT =
  'A farmer must take a wolf, a goat and a cabbage across a river. The boat holds the farmer and at most one of them. Left alone together, the wolf eats the goat and the goat eats the cabbage. List the crossings that get all three across safely, and explain why no plan with fewer crossings exists.';

export const CODE_PROMPT =
  'Write a Python function merge_intervals(intervals) that merges overlapping closed intervals, given as a list of [start, end] pairs, and returns them sorted by start. Include a docstring and five pytest test cases, one of them for an empty list.';

/**
 * Models decline to write out huge lists and stop at natural ends, but they keep writing a long
 * essay they were asked for; on a real machine this ran to Max tokens at 128 and 512 tokens,
 * thinking on or off.
 */
export const FIXED_LENGTH_PROMPT =
  'Write a detailed essay of at least 3,000 words on the history of the printing press, with a section for each century from the fifteenth to the twentieth. Start writing the essay straight away, with no introduction or outline.';

export const LONG_INSTRUCTION = 'Summarize the argument of the text above in five bullet points.';

/** Words of On Liberty per long preset, measured on Qwen3.8's tokenizer at about 1.2 tokens a word. */
export const LONG_PRESET_WORDS = { 'long-8k': 6300, 'long-32k': 25300 } as const;

/** The first `n` words of a text, carried on to the end of that sentence. */
export function firstWords(text: string, n: number): string {
  const parts = text.split(/(\s+)/);
  let count = 0;
  let end = parts.length;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? '';
    if (!part.trim()) continue;
    count += 1;
    if (count >= n && /[.!?]["')\]]*$/.test(part)) {
      end = i + 1;
      break;
    }
  }
  return parts.slice(0, end).join('').trim();
}

/** The prompt a preset sends. `source` is the long text; `custom` is the user's own prompt. */
export function presetPrompt(id: PresetId, source: string, custom: string): string {
  switch (id) {
    case 'short':
      return SHORT_PROMPT;
    case 'puzzle':
      return PUZZLE_PROMPT;
    case 'code':
      return CODE_PROMPT;
    case 'fixed-length':
      return FIXED_LENGTH_PROMPT;
    case 'long-8k':
    case 'long-32k':
      return `${firstWords(source, LONG_PRESET_WORDS[id])}\n\n${LONG_INSTRUCTION}`;
    default:
      return custom;
  }
}

/** Twelve random hex characters, from the platform's cryptographic random source. */
export function newNonce(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A line at the very start of a cold-prefill prompt, different every round, that no cache has seen. */
export function nonceLine(nonce: string): string {
  return `Reference ${nonce}. Ignore this line.`;
}

export function withNonce(prompt: string, nonce: string | null): string {
  return nonce ? `${nonceLine(nonce)}\n\n${prompt}` : prompt;
}
