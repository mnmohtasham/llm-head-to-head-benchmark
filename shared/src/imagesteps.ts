/**
 * Step timing from Unsloth's generate-progress route, polled about ten times a second. Each sample
 * says which denoising step the machine had reached when it was read, so every time here is good
 * to about one polling interval.
 */

/** One progress reading: ms since the request left, and the step it reported. */
export type StepSample = [atMs: number, step: number];

export interface StepMetrics {
  /** First reading with at least one step done. */
  firstStepMs: number | null;
  /** First reading with every step done. */
  lastStepMs: number | null;
  /** Steps done between the first and the last step readings, per second. */
  stepsPerSec: number | null;
  /** From the last step to the answer: the VAE decode and saving the image. */
  decodeTailMs: number | null;
  /** How far apart the readings were, as a median: the resolution of the numbers above. */
  resolutionMs: number | null;
}

export function stepMetrics(
  samples: readonly StepSample[],
  totalSteps: number,
  endMs: number | null,
): StepMetrics {
  const sorted = [...samples].sort((a, b) => a[0] - b[0]);
  const first = sorted.find(([, step]) => step >= 1) ?? null;
  const last = totalSteps > 0 ? (sorted.find(([, step]) => step >= totalSteps) ?? null) : null;
  // The rate runs to the last step when it was seen, else to the furthest step seen.
  const furthest = sorted.reduce<StepSample | null>(
    (best, sample) => (best === null || sample[1] > best[1] ? sample : best),
    null,
  );
  const until = last ?? furthest;
  const stepsPerSec =
    first && until && until[1] > first[1] && until[0] > first[0]
      ? (until[1] - first[1]) / ((until[0] - first[0]) / 1000)
      : null;
  const gaps = sorted
    .slice(1)
    .map((sample, i) => sample[0] - (sorted[i]?.[0] ?? sample[0]))
    .sort((a, b) => a - b);
  return {
    firstStepMs: first?.[0] ?? null,
    lastStepMs: last?.[0] ?? null,
    stepsPerSec,
    decodeTailMs: last && endMs !== null && endMs >= last[0] ? endMs - last[0] : null,
    resolutionMs: gaps.length > 0 ? (gaps[Math.floor(gaps.length / 2)] ?? null) : null,
  };
}
