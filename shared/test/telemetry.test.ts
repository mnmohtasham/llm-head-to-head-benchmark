import { describe, expect, it } from 'vitest';
import { integratePower, parseTelemetry, runEnergy, type TelemetrySample } from '../src/telemetry';

const device = (over: Record<string, unknown> = {}) => ({
  available: true,
  gpu_utilization_pct: 90,
  temperature_c: 60,
  vram_used_gb: 10,
  vram_total_gb: 12,
  power_draw_w: 150,
  ...over,
});
const system = { cpu: { usage_percent: 12 }, memory: { total_gb: 32, available_gb: 8 } };

describe('parseTelemetry', () => {
  it('reads a CUDA GPU and the system', () => {
    expect(parseTelemetry({ backend: 'cuda', devices: [device()] }, system, 1000)).toEqual({
      at: 1000,
      gpuUtilPct: 90,
      gpuPowerW: 150,
      gpuTempC: 60,
      vramUsedGb: 10,
      vramTotalGb: 12,
      cpuPct: 12,
      ramUsedGb: 24,
      ramTotalGb: 32,
    });
  });

  it('adds up several GPUs and reports the busiest and hottest', () => {
    const sample = parseTelemetry(
      {
        backend: 'cuda',
        devices: [
          device(),
          device({ gpu_utilization_pct: 40, temperature_c: 70, power_draw_w: 100 }),
        ],
      },
      null,
      0,
    );
    expect(sample).toMatchObject({ gpuUtilPct: 90, gpuTempC: 70, gpuPowerW: 250, vramUsedGb: 20 });
    expect(sample.cpuPct).toBeNull();
  });

  it('leaves VRAM out on unified memory, and a missing sensor as null, not zero', () => {
    const mac = parseTelemetry(
      { backend: 'mps', devices: [device({ power_draw_w: null, temperature_c: undefined })] },
      system,
      0,
    );
    expect(mac).toMatchObject({
      vramUsedGb: null,
      vramTotalGb: null,
      gpuPowerW: null,
      gpuTempC: null,
    });
    expect(parseTelemetry(null, null, 5)).toMatchObject({ gpuUtilPct: null, ramUsedGb: null });
  });
});

const watts = (points: Array<[number, number | null]>) =>
  points.map(([at, w]) => ({ at, watts: w }));

describe('integratePower', () => {
  it('gives power times time for a steady reading, with the edges interpolated', () => {
    const result = integratePower(
      watts([
        [0, 100],
        [500, 100],
        [1000, 100],
        [1500, 100],
      ]),
      250,
      1250,
    );
    expect(result.joules).toBeCloseTo(100, 6);
    expect(result.coveredMs).toBe(1000);
  });

  it('handles irregular sampling with the trapezoid rule', () => {
    // 0 W rising to 200 W over 1 s, then flat for 0.25 s: 100 J + 50 J.
    const result = integratePower(
      watts([
        [0, 0],
        [1000, 200],
        [1250, 200],
      ]),
      0,
      1250,
    );
    expect(result.joules).toBeCloseTo(150, 6);
  });

  it('skips gaps longer than two seconds and pairs with a null reading', () => {
    const result = integratePower(
      watts([
        [0, 100],
        [500, null],
        [1000, 100],
        [4000, 100],
        [4500, 100],
      ]),
      0,
      4500,
    );
    // Only 4000 to 4500 joins two readings within two seconds.
    expect(result.joules).toBeCloseTo(50, 6);
    expect(result.coveredMs).toBe(500);
  });
});

function sample(at: number, gpuPowerW: number | null, gpuUtilPct = 50): TelemetrySample {
  return {
    at,
    gpuUtilPct,
    gpuPowerW,
    gpuTempC: 50,
    vramUsedGb: 8,
    vramTotalGb: 12,
    cpuPct: 10,
    ramUsedGb: 20,
    ramTotalGb: 32,
  };
}

describe('runEnergy', () => {
  it('lines samples up with the run: energy, decode power, tokens per joule and peaks', () => {
    // Idle at 20 W before and after, 100 W prefill, 200 W while decoding from 2 s to 6 s.
    const samples = [
      sample(-1000, 20, 5),
      ...Array.from({ length: 17 }, (_, i) => {
        const t = i * 500;
        return sample(t, t < 2000 ? 100 : t <= 6000 ? 200 : 20, t === 3000 ? 97 : 80);
      }),
      sample(9000, 20, 5),
    ];
    const energy = runEnergy(
      samples,
      { start: 0, firstToken: 2000, lastToken: 6000, end: 8000 },
      400,
    );
    expect(energy.decodeEnergyJ).toBeCloseTo(800, 6);
    expect(energy.meanDecodePowerW).toBeCloseTo(200, 6);
    expect(energy.energyJ).toBeGreaterThan(800);
    expect(energy.tokensPerJoule).toBeCloseTo(400 / (energy.energyJ ?? 1), 6);
    expect(energy.coverage).toBe(1);
    expect(energy.peakGpuPct).toBe(97);
    expect(energy.samples).toBe(17);
  });

  it('reports no energy when under half the run had power readings', () => {
    const samples = [sample(0, 100), sample(500, 100), sample(1000, null), sample(4000, null)];
    const energy = runEnergy(
      samples,
      { start: 0, firstToken: 100, lastToken: 3900, end: 4000 },
      10,
    );
    expect(energy.energyJ).toBeNull();
    expect(energy.tokensPerJoule).toBeNull();
    expect(energy.coverage).toBeCloseTo(0.125, 6);
  });
});
