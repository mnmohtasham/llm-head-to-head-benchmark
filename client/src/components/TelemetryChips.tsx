import type { TelemetrySample, TelemetryStatus } from '@duel/shared';
import { api, messageOf } from '../api';

const pct = (v: number | null) => (v === null ? 'n/a' : `${Math.round(v)}%`);
const watts = (v: number | null) =>
  v === null ? 'n/a' : `${v < 10 ? v.toFixed(1) : Math.round(v)} W`;
const gb = (v: number | null) => (v === null ? 'n/a' : `${v < 10 ? v.toFixed(1) : Math.round(v)}`);

/**
 * Live readings as chips: GPU load, power and temperature, VRAM on GPUs with their own memory,
 * CPU load and RAM. A reading the machine does not report shows "n/a".
 */
export function TelemetryChips({
  enabled,
  status,
  sample,
}: {
  enabled: boolean | null;
  status: TelemetryStatus | undefined;
  sample: TelemetrySample | undefined;
}) {
  if (enabled !== true || !status || status.state === 'off') return null;
  if (status.state === 'backoff') {
    return (
      <p className="telemetry-note" data-testid="telemetry">
        Telemetry: no answer, trying again in {Math.round((status.retryInMs ?? 0) / 1000)} s.
      </p>
    );
  }
  if (!sample) {
    return (
      <p className="telemetry-note" data-testid="telemetry">
        Telemetry starting…
      </p>
    );
  }
  const chips: Array<[string, string]> = [
    ['GPU', pct(sample.gpuUtilPct)],
    ['Power', watts(sample.gpuPowerW)],
    ['Temp', sample.gpuTempC === null ? 'n/a' : `${Math.round(sample.gpuTempC)} °C`],
    ...(sample.vramTotalGb !== null
      ? [['VRAM', `${gb(sample.vramUsedGb)} / ${gb(sample.vramTotalGb)} GB`] as [string, string]]
      : []),
    ['CPU', pct(sample.cpuPct)],
    ['RAM', `${gb(sample.ramUsedGb)} / ${gb(sample.ramTotalGb)} GB`],
  ];
  return (
    <ul className="telemetry-chips" aria-label="Live hardware" data-testid="telemetry">
      {chips.map(([label, value]) => (
        <li key={label} data-kind={label}>
          <span className="telemetry-label">{label}</span>{' '}
          <span className="telemetry-value">{value}</span>
        </li>
      ))}
    </ul>
  );
}

/** The global switch: polling adds a little load on every machine, so it can be turned off. */
export function TelemetrySwitch({
  enabled,
  onError,
}: {
  enabled: boolean | null;
  onError: (message: string) => void;
}) {
  const set = (on: boolean) => {
    api.setTelemetry(on).catch((error: unknown) => onError(messageOf(error)));
  };
  return (
    <div className="field">
      <span className="field-label" id="telemetry-label">
        Telemetry
      </span>
      <div className="toggle-chips" role="radiogroup" aria-labelledby="telemetry-label">
        {[true, false].map((on) => (
          <button
            key={String(on)}
            type="button"
            role="radio"
            aria-checked={enabled === on}
            className={`toggle-chip${enabled === on ? ' toggle-chip-on' : ''}`}
            onClick={() => set(on)}
            disabled={enabled === null}
          >
            {on ? 'On' : 'Off'}
          </button>
        ))}
      </div>
      <p className="field-hint">
        Reads GPU, power, CPU and RAM twice a second. Polling adds a little load, so turn it off for
        the cleanest timings.
      </p>
    </div>
  );
}
