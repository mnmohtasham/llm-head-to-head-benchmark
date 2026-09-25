import type { RoundView, SessionView } from '@duel/shared';
import { useMemo, type CSSProperties } from 'react';
import { formatMsValue } from '../format';
import type uPlot from 'uplot';
import { alignSeries, AXIS, Chart, withAlpha } from './Chart';

/**
 * Tokens against time, one line per machine, the thinking part lighter and filled. Times are
 * seconds since each machine's own request, so machines that took turns line up too.
 */
function RaceChart({ session, round }: { session: SessionView; round: RoundView }) {
  const { options, data } = useMemo(() => {
    const series: Array<Array<[number, number | null]>> = [];
    const specs: uPlot.Series[] = [{}];
    for (const machine of session.machines) {
      const run = round.runs.find((r) => r.machineId === machine.id);
      const points = run?.timeline ?? [];
      const thinking: Array<[number, number | null]> = [];
      const answer: Array<[number, number | null]> = [];
      points.forEach(([ms, tokens, reasoning], i) => {
        const x = Math.round(ms) / 1000;
        if (reasoning) thinking.push([x, tokens]);
        else {
          // Join the answer line to the end of the thinking line.
          const previous = points[i - 1];
          if (previous?.[2] === 1 && answer.length === 0)
            answer.push([previous[0] / 1000, previous[1]]);
          answer.push([x, tokens]);
        }
      });
      series.push(thinking, answer);
      specs.push(
        {
          label: `${machine.name} thinking`,
          stroke: withAlpha(machine.color, 0.55),
          fill: withAlpha(machine.color, 0.12),
          width: 1.5,
          spanGaps: true,
        },
        { label: `${machine.name} answer`, stroke: machine.color, width: 2, spanGaps: true },
      );
    }
    const options: Omit<uPlot.Options, 'width'> = {
      height: 240,
      series: specs,
      scales: { x: { time: false } },
      axes: [
        { ...AXIS, label: 'seconds since the request', labelSize: 18 },
        { ...AXIS, label: 'tokens', labelSize: 18 },
      ],
      legend: { show: true },
      cursor: { drag: { x: false, y: false } },
    };
    return { options, data: alignSeries(series) };
  }, [session, round]);
  return (
    <Chart
      options={options}
      data={data}
      label="Tokens against time for each machine"
      testId="race-chart"
    />
  );
}

/** Power and token rate over the round, on the same wall clock, from the telemetry samples. */
function TelemetryChart({ session, round }: { session: SessionView; round: RoundView }) {
  const { options, data } = useMemo(() => {
    const starts = round.runs
      .map((run) => run.requestedAtMs)
      .filter((v): v is number => v !== null);
    const origin = starts.length > 0 ? Math.min(...starts) : 0;
    const series: Array<Array<[number, number | null]>> = [];
    const specs: uPlot.Series[] = [{}];
    for (const machine of session.machines) {
      const run = round.runs.find((r) => r.machineId === machine.id);
      const samples = run?.telemetry?.samples ?? [];
      series.push(
        samples.map(
          (s) => [Math.round(s.at - origin) / 1000, s.gpuPowerW] as [number, number | null],
        ),
      );
      specs.push({
        label: `${machine.name} power`,
        stroke: machine.color,
        width: 2,
        scale: 'W',
        // Each machine has its own sample times; join its readings across the other's.
        spanGaps: true,
      });
      if (session.workload !== 'text') continue;
      // Tokens per second over the last second, every half second of the run.
      const timeline = run?.timeline ?? [];
      const start = run?.requestedAtMs ?? origin;
      const rates: Array<[number, number | null]> = [];
      const end = timeline.length > 0 ? (timeline[timeline.length - 1]?.[0] ?? 0) : 0;
      for (let t = 500; t <= end + 500; t += 500) {
        const inWindow = timeline.filter(([ms]) => ms > t - 1000 && ms <= t);
        const count =
          inWindow.length === 0
            ? 0
            : (inWindow[inWindow.length - 1]?.[1] ?? 0) - (inWindow[0]?.[1] ?? 0) + 1;
        rates.push([Math.round(start - origin + t) / 1000, count]);
      }
      series.push(rates);
      specs.push({
        label: `${machine.name} tok/s`,
        stroke: withAlpha(machine.color, 0.7),
        width: 1.5,
        dash: [4, 4],
        scale: 'rate',
        spanGaps: true,
      });
    }
    const text = session.workload === 'text';
    const options: Omit<uPlot.Options, 'width'> = {
      height: 220,
      series: specs,
      scales: text ? { x: { time: false }, W: {}, rate: {} } : { x: { time: false }, W: {} },
      axes: [
        { ...AXIS, label: 'seconds since the round started', labelSize: 18 },
        { ...AXIS, scale: 'W', label: 'watts', labelSize: 18 },
        ...(text
          ? [
              {
                ...AXIS,
                scale: 'rate',
                side: 1,
                label: 'tokens per second',
                labelSize: 18,
                grid: { show: false },
              },
            ]
          : []),
      ],
      legend: { show: true },
      cursor: { drag: { x: false, y: false } },
    };
    return { options, data: alignSeries(series) };
  }, [session, round]);
  return (
    <Chart
      options={options}
      data={data}
      label={
        session.workload === 'text'
          ? 'GPU power and token rate over the round'
          : 'GPU power over the round'
      }
      testId="telemetry-chart"
    />
  );
}

/** Denoising steps against time, one line per machine, from the progress readings. */
function StepChart({ session, round }: { session: SessionView; round: RoundView }) {
  const { options, data } = useMemo(() => {
    const series: Array<Array<[number, number | null]>> = [];
    const specs: uPlot.Series[] = [{}];
    for (const machine of session.machines) {
      const run = round.runs.find((r) => r.machineId === machine.id);
      const image = run?.image ?? null;
      const points: Array<[number, number | null]> = (image?.timeline ?? []).map(([ms, step]) => [
        Math.round(ms) / 1000,
        step,
      ]);
      // The line ends when the answer came, after the decode.
      if (image && points.length > 0) points.push([image.totalMs / 1000, image.totalSteps]);
      series.push(points);
      specs.push({ label: machine.name, stroke: machine.color, width: 2, spanGaps: true });
    }
    const options: Omit<uPlot.Options, 'width'> = {
      height: 240,
      series: specs,
      scales: { x: { time: false } },
      axes: [
        { ...AXIS, label: 'seconds since the request', labelSize: 18 },
        { ...AXIS, label: 'denoising step', labelSize: 18 },
      ],
      legend: { show: true },
      cursor: { drag: { x: false, y: false } },
    };
    return { options, data: alignSeries(series) };
  }, [session, round]);
  return (
    <Chart
      options={options}
      data={data}
      label="Denoising steps against time for each machine"
      testId="step-chart"
    />
  );
}

/** Frames encoded against time, one line per machine, from ffmpeg's progress. */
function FrameChart({ session, round }: { session: SessionView; round: RoundView }) {
  const { options, data } = useMemo(() => {
    const series: Array<Array<[number, number | null]>> = [];
    const specs: uPlot.Series[] = [{}];
    for (const machine of session.machines) {
      const run = round.runs.find((r) => r.machineId === machine.id);
      series.push(
        (run?.command?.timeline ?? []).map(([ms, frame]) => [Math.round(ms) / 1000, frame]),
      );
      specs.push({ label: machine.name, stroke: machine.color, width: 2, spanGaps: true });
    }
    const options: Omit<uPlot.Options, 'width'> = {
      height: 240,
      series: specs,
      scales: { x: { time: false } },
      axes: [
        { ...AXIS, label: 'seconds since ffmpeg started', labelSize: 18 },
        { ...AXIS, label: 'frames', labelSize: 18 },
      ],
      legend: { show: true },
      cursor: { drag: { x: false, y: false } },
    };
    return { options, data: alignSeries(series) };
  }, [session, round]);
  return (
    <Chart
      options={options}
      data={data}
      label="Frames encoded against time for each machine"
      testId="frame-chart"
    />
  );
}

/**
 * Where each machine's time went in a transcription: sending the file, then processing it, on
 * one scale so the bars compare directly.
 */
function PhaseBars({ session, round }: { session: SessionView; round: RoundView }) {
  const rows = session.machines.map((machine) => {
    const t = round.runs.find((r) => r.machineId === machine.id)?.transcription ?? null;
    return { machine, upload: t?.uploadMs ?? null, processing: t?.processingMs ?? null };
  });
  const longest = Math.max(1, ...rows.map((r) => (r.upload ?? 0) + (r.processing ?? 0)));
  const width = (ms: number | null) => `${(((ms ?? 0) / longest) * 100).toFixed(2)}%`;
  return (
    <div
      className="phase-bars"
      data-testid="phase-bars"
      role="img"
      aria-label="Upload and processing time for each machine"
    >
      {rows.map(({ machine, upload, processing }) => (
        <div
          key={machine.id}
          className="phase-row"
          style={{ '--machine': machine.color } as CSSProperties}
        >
          <span className="phase-name">{machine.name}</span>
          <span className="phase-track">
            <span className="phase-upload" style={{ width: width(upload) }} />
            <span className="phase-processing" style={{ width: width(processing) }} />
          </span>
          <span className="phase-value">
            {upload === null && processing === null
              ? 'n/a'
              : `${formatMsValue(upload)} up · ${formatMsValue(processing)} processing`}
          </span>
        </div>
      ))}
      <p className="field-hint">
        Light: the file going to the machine. Solid: the machine working on it.
      </p>
    </div>
  );
}

/** The round's charts: the race, and power against token rate when telemetry was on. */
export function RaceCharts({
  session,
  round,
  label,
}: {
  session: SessionView;
  round: RoundView;
  label: string;
}) {
  const hasTelemetry = round.runs.some((run) => (run.telemetry?.samples.length ?? 0) > 0);
  return (
    <section className="panel charts" aria-labelledby="charts-title">
      <h2 id="charts-title" className="section-title">
        Charts · {label}
      </h2>
      {session.workload === 'transcribe' ? (
        <PhaseBars session={session} round={round} />
      ) : session.workload === 'image' ? (
        <StepChart session={session} round={round} />
      ) : session.workload === 'command' ? (
        <FrameChart session={session} round={round} />
      ) : (
        <RaceChart session={session} round={round} />
      )}
      {hasTelemetry ? <TelemetryChart session={session} round={round} /> : null}
    </section>
  );
}
