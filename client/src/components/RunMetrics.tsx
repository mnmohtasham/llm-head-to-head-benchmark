import { thinkingMissing, type RunView } from '@duel/shared';
import { formatMsValue, formatRate } from '../format';

type Row = [label: string, measured: string, reported: string];

export function RunMetrics({ run }: { run: RunView }) {
  const c = run.client;
  if (!c) return null;
  const t = run.server?.timings ?? null;
  const m = run.server?.monitor ?? null;
  const serverDecode = t?.predictedPerSecond ?? m?.tokPerSec ?? null;
  const tokens = (value: number | null | undefined) =>
    value === null || value === undefined ? 'n/a' : value.toLocaleString('en-US');
  const gaps = c.interChunk
    ? `${formatMsValue(c.interChunk.meanMs)} / ${formatMsValue(c.interChunk.medianMs)} / ${formatMsValue(c.interChunk.p95Ms)} / ${formatMsValue(c.interChunk.maxMs)}`
    : 'n/a';

  // llama-server counts only the prompt tokens it had to process; the cached ones are separate.
  const serverPrompt =
    t?.promptN !== null && t?.promptN !== undefined
      ? t.promptN + (t.cacheN ?? 0)
      : (m?.promptTokens ?? null);
  const draftN = t?.draftN ?? null;
  const draftAccepted = t?.draftAccepted ?? 0;
  const drafts =
    draftN === null
      ? 'n/a'
      : draftN === 0
        ? 'none drafted'
        : `${tokens(draftAccepted)} of ${tokens(draftN)} (${Math.round((draftAccepted / draftN) * 100)}%)`;
  const cached = c.cachedTokens ?? t?.cacheN ?? 0;

  const rows: Row[] = [
    ['Time to first token', formatMsValue(c.ttftMs), formatMsValue(m?.ttftMs)],
    ['First thinking token', formatMsValue(c.firstReasoningMs), 'n/a'],
    ['First answer token', formatMsValue(c.firstAnswerMs), 'n/a'],
    ['Thinking time', formatMsValue(c.thinkingMs), 'n/a'],
    [
      'Decode speed',
      formatRate(c.decodeTokPerSec, 'tok/s') + (c.tokensEstimated ? ' (estimated)' : ''),
      formatRate(serverDecode, 'tok/s'),
    ],
    ['End-to-end speed', formatRate(c.endToEndTokPerSec, 'tok/s'), 'n/a'],
    ['Characters per second', formatRate(c.charsPerSec, 'chars/s'), 'n/a'],
    [
      'Prompt processing',
      'n/a',
      t ? `${formatRate(t.promptPerSecond, 'tok/s')} in ${formatMsValue(t.promptMs)}` : 'n/a',
    ],
    ['Total time', formatMsValue(c.totalMs), formatMsValue(m?.durationMs)],
    ['Prompt tokens', tokens(c.promptTokens), tokens(serverPrompt)],
    [
      'Output tokens',
      `${tokens(c.outputTokens ?? c.chunks)}${c.outputTokens === null ? ' chunks' : ''}`,
      tokens(t?.predictedN ?? m?.completionTokens),
    ],
    ['Cached prompt tokens', tokens(c.cachedTokens), tokens(t?.cacheN)],
    ['Speculative drafts accepted', 'n/a', drafts],
    ['Chunk gaps: mean / median / p95 / max', gaps, 'n/a'],
    ['Chunks', `${c.chunks}, of which ${c.coalescedChunks} arrived together`, 'n/a'],
    ['Finish reason', c.finishReason ?? 'n/a', m?.stopReason ?? 'n/a'],
    ['Keep-alives received', String(c.keepalives), 'n/a'],
    ['Headers arrived (diagnostic)', formatMsValue(c.ttfbMs), 'n/a'],
  ];

  const network =
    c.ttftMs !== null && m?.ttftMs !== null && m?.ttftMs !== undefined ? c.ttftMs - m.ttftMs : null;
  const decodeGap =
    c.decodeTokPerSec !== null && serverDecode
      ? ((c.decodeTokPerSec - serverDecode) / serverDecode) * 100
      : null;
  const lag = run.loopLagMs;
  const modelChanged =
    run.modelBefore !== null && run.modelAfter !== null && run.modelBefore !== run.modelAfter;

  return (
    <section className="panel metrics" aria-labelledby="metrics-title" data-testid="run-metrics">
      <h2 id="metrics-title" className="section-title">
        Measurements
      </h2>
      <div className="table-scroll">
        <table className="metrics-table">
          <thead>
            <tr>
              <th scope="col">Metric</th>
              <th scope="col">Measured by Model Duel</th>
              <th scope="col">Reported by Unsloth</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, measured, reported]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td data-column="measured">{measured}</td>
                <td data-column="reported">{reported}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="metrics-notes">
        <li>
          Model Duel measures from the moment the request leaves this computer, so its times include
          the network. Unsloth measures on the machine itself.
        </li>
        {network !== null ? (
          <li data-testid="network-share">
            The network and request handling add {formatMsValue(network)} to the first token.
          </li>
        ) : (
          <li>
            Unsloth&apos;s monitor row for this run was not found, so its time to first token is
            missing.
          </li>
        )}
        {decodeGap !== null ? (
          <li data-testid="decode-gap">
            Decode speeds differ by {Math.abs(decodeGap).toFixed(1)} percent
            {Math.abs(decodeGap) > 10 ? ', more than the 10 percent the plan allows' : ''}.
          </li>
        ) : null}
        {lag ? (
          <li className={lag.max > 50 ? 'note-warn' : undefined}>
            The controller&apos;s event loop was late by up to {formatMsValue(lag.max)} during the
            run
            {lag.max > 50
              ? ', enough to blur the timings. Close other work on this computer and run again.'
              : '.'}
          </li>
        ) : null}
        {modelChanged ? (
          <li className="note-warn">
            The loaded model changed during the run, from {run.modelBefore} to {run.modelAfter}.
            Discard this run.
          </li>
        ) : null}
        {c.truncated ? (
          <li className="note-warn">Unsloth cut the prompt to fit the context window.</li>
        ) : null}
        {c.finishReason === 'length' ? (
          <li className="note-warn" data-testid="hit-max-tokens">
            The run stopped at Max tokens ({run.maxTokens.toLocaleString('en-US')})
            {run.answer ? ', so the answer is cut off.' : ' before the answer started.'}
          </li>
        ) : null}
        {draftN !== null && draftN > 0 ? (
          <li className="note-warn" data-testid="speculative">
            Speculative decoding was on: Unsloth kept {tokens(draftAccepted)} of {tokens(draftN)}{' '}
            drafted tokens. Kept drafts arrive together, so the gaps between chunks are uneven. To
            compare machines like for like, load the model with speculative decoding off.
          </li>
        ) : null}
        {cached > 0 ? (
          <li data-testid="prompt-cache">
            {tokens(cached)} of {tokens(c.promptTokens ?? serverPrompt)} prompt tokens came from
            Unsloth&apos;s prompt cache, so the first token came sooner than it would for a new
            prompt.
          </li>
        ) : null}
        {thinkingMissing(run.thinking, c) ? (
          <li className="note-warn" data-testid="thinking-missing">
            Thinking was on, but no thinking arrived on its own. If the answer opens with the
            model&apos;s reasoning, the model skipped its thinking block, so the first answer token
            came too early to compare.
          </li>
        ) : null}
      </ul>
    </section>
  );
}
