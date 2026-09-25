import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

/** A uPlot chart that fills its container's width and follows it when it resizes. */
export function Chart({
  options,
  data,
  label,
  testId,
}: {
  options: Omit<uPlot.Options, 'width'>;
  data: uPlot.AlignedData;
  label: string;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    const plot = new uPlot({ ...options, width: Math.max(280, box.clientWidth) }, data, box);
    const observer = new ResizeObserver(() =>
      plot.setSize({ width: Math.max(280, box.clientWidth), height: options.height }),
    );
    observer.observe(box);
    return () => {
      observer.disconnect();
      plot.destroy();
    };
  }, [options, data]);
  return <div ref={ref} className="chart" role="img" aria-label={label} data-testid={testId} />;
}

/** Axis and grid colours that read on the dark theme. */
export const AXIS: uPlot.Axis = {
  stroke: '#a3a29e',
  grid: { stroke: '#2a2c30', width: 1 },
  ticks: { stroke: '#2a2c30', width: 1 },
  font: '11px system-ui, sans-serif',
};

/** Merges several series with their own x values into uPlot's shared x axis. */
export function alignSeries(
  series: ReadonlyArray<ReadonlyArray<[number, number | null]>>,
): uPlot.AlignedData {
  const xs = [...new Set(series.flatMap((points) => points.map(([x]) => x)))].sort((a, b) => a - b);
  const index = new Map(xs.map((x, i) => [x, i]));
  const ys = series.map((points) => {
    const column: Array<number | null> = xs.map(() => null);
    for (const [x, y] of points) column[index.get(x) ?? 0] = y;
    return column;
  });
  return [xs, ...ys] as uPlot.AlignedData;
}

/** A colour with transparency, for the lighter thinking series. */
export function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.replace(/./g, (c) => c + c) : value;
  const n = Number.parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
