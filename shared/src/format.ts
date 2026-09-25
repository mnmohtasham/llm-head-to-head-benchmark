import type { MetricUnit } from './compare';

/** Seconds with two decimals, like the big numbers of the reference tool. */
export function formatSeconds(ms: number | null): string {
  return ms === null ? 'n/a' : (ms / 1000).toFixed(2);
}

export function formatMsValue(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return 'n/a';
  return ms < 10
    ? `${ms.toFixed(1)} ms`
    : ms < 10_000
      ? `${Math.round(ms)} ms`
      : `${(ms / 1000).toFixed(1)} s`;
}

export function formatRate(value: number | null | undefined, unit: string): string {
  return value === null || value === undefined ? 'n/a' : `${value.toFixed(1)} ${unit}`;
}

/** A metric value as the tables show it, in its unit. */
export function formatValue(value: number | null, unit: MetricUnit): string {
  if (value === null) return 'n/a';
  if (unit === 'ms') return formatMsValue(value);
  if (unit === 'tokens') return Math.round(value).toLocaleString('en-US');
  if (unit === 'tok/J') return `${value.toFixed(3)} tok/J`;
  if (unit === '%') return value < 10 ? `${value.toFixed(1)}%` : `${Math.round(value)}%`;
  if (unit === '×') return `${value.toFixed(1)}×`;
  return formatRate(value, unit);
}
