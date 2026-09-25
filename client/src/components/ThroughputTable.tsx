import type { RunView } from '@duel/shared';
import { formatMsValue, formatRate } from '../format';

/** Every request of a throughput batch, and the admission queue while they ran. */
export function ThroughputTable({ run }: { run: RunView }) {
  const t = run.throughput;
  if (!t) return null;
  const q = t.queue;
  return (
    <section className="panel metrics" aria-labelledby="batch-title" data-testid="throughput-table">
      <h2 id="batch-title" className="section-title">
        {t.concurrency} requests at once
      </h2>
      <div className="table-scroll">
        <table className="metrics-table">
          <thead>
            <tr>
              <th scope="col">Request</th>
              <th scope="col">State</th>
              <th scope="col">Sent after</th>
              <th scope="col">First token</th>
              <th scope="col">Total</th>
              <th scope="col">Tokens</th>
              <th scope="col">Speed</th>
            </tr>
          </thead>
          <tbody>
            {t.requests.map((r) => (
              <tr key={r.index}>
                <th scope="row">{r.index + 1}</th>
                <td title={r.error ?? undefined}>{r.state}</td>
                <td>{formatMsValue(r.sendOffsetMs)}</td>
                <td>{formatMsValue(r.ttftMs)}</td>
                <td>{formatMsValue(r.totalMs)}</td>
                <td>{r.outputTokens ?? 'n/a'}</td>
                <td>{formatRate(r.decodeTokPerSec, 'tok/s')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="metrics-notes">
        <li>
          Together: {t.outputTokens.toLocaleString('en-US')} tokens in {formatMsValue(t.totalMs)},{' '}
          {formatRate(t.aggregateTokPerSec, 'tok/s')}. First token: median{' '}
          {formatMsValue(t.ttftMedianMs)}, 95th percentile {formatMsValue(t.ttftP95Ms)}.
        </li>
        <li>
          {q
            ? q.maxQueued > 0
              ? `Up to ${q.maxQueued} waited for a slot, for ${formatMsValue(q.queuedMs)} in all, with ${q.capacity ?? 'an unknown number of'} slots.`
              : `No request waited for a slot: up to ${q.maxActive} of ${q.capacity ?? '?'} slots were busy.`
            : 'The queue could not be read from the monitor.'}
        </li>
      </ul>
    </section>
  );
}
