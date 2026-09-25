import type { RunView, TelemetrySample, TelemetryStatus } from '@duel/shared';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { formatRate, formatSeconds } from '../format';
import { TelemetryChips } from './TelemetryChips';

const STATE_LABEL: Record<string, string> = {
  idle: 'Ready',
  starting: 'Starting',
  queued: 'Waiting its turn',
  waiting: 'Waiting',
  thinking: 'Thinking',
  answering: 'Answering',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

interface Props {
  machine: { name: string; color: string };
  modelName: string | null;
  run: RunView | null;
  telemetry?: {
    enabled: boolean | null;
    status: TelemetryStatus | undefined;
    sample: TelemetrySample | undefined;
  };
}

/**
 * Keeps a scrolling box pinned to its newest text while it grows, unless the reader has scrolled
 * up to read something earlier.
 */
function useFollow(text: string) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    const onScroll = () => {
      pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
    };
    box.addEventListener('scroll', onScroll, { passive: true });
    return () => box.removeEventListener('scroll', onScroll);
  }, []);
  useLayoutEffect(() => {
    const box = ref.current;
    if (box && pinned.current) box.scrollTop = box.scrollHeight;
  }, [text]);
  return ref;
}

/** What the answer box says when there is no answer text. */
function emptyAnswer(run: RunView | null, running: boolean): string {
  if (!run) return 'The answer appears here.';
  if (running) {
    return run.reasoning
      ? 'Thinking… The answer starts when the model finishes thinking.'
      : 'Waiting for the first token…';
  }
  if (run.state === 'cancelled') return 'Cancelled before the answer started.';
  if (run.state === 'failed') return 'No answer: the run failed.';
  if (run.client?.finishReason === 'length') {
    return run.reasoning
      ? `No answer: the model used all ${run.maxTokens.toLocaleString('en-US')} tokens thinking and never started its answer. Raise Max tokens, lower Reasoning effort, or turn Thinking off, then run again.`
      : `No answer: the run stopped at Max tokens (${run.maxTokens.toLocaleString('en-US')}).`;
  }
  return 'The model finished without an answer.';
}

export function RunPane({ machine, modelName, run, telemetry }: Props) {
  const live = run?.live ?? null;
  const client = run?.client ?? null;
  const running = run !== null && run.finishedAt === null;
  const phase = !run
    ? 'idle'
    : running
      ? run.state === 'starting' || run.state === 'queued'
        ? run.state
        : run.answer
          ? 'answering'
          : run.reasoning
            ? 'thinking'
            : 'waiting'
      : run.state;
  const firstAnswer = client?.firstAnswerMs ?? live?.firstAnswerMs ?? null;
  const firstToken = client?.ttftMs ?? live?.ttftMs ?? null;
  const speed = client?.decodeTokPerSec ?? live?.decodeTokPerSec ?? null;
  const elapsed = client?.totalMs ?? live?.elapsedMs ?? null;
  const thinkingMs =
    client?.thinkingMs ??
    (live && live.ttftMs !== null && run?.reasoning
      ? (live.firstAnswerMs ?? live.elapsedMs) - live.ttftMs
      : null);
  const answerRef = useFollow(run?.answer ?? '');
  const cutOff = !running && client?.finishReason === 'length' && !!run?.answer;

  return (
    <article
      className="card run-pane"
      data-testid="run-pane"
      data-machine={machine.name}
      data-state={phase}
      style={{ '--machine': machine.color } as CSSProperties}
      aria-label={`${machine.name} run`}
    >
      <header className="card-head">
        <div className="card-title">
          <h2 className="machine-name">{machine.name}</h2>
          <p className="machine-notes">{run?.modelBefore ?? modelName ?? 'No model loaded'}</p>
        </div>
        <span className={`state state-run-${phase}`} data-testid="run-state" role="status">
          {STATE_LABEL[phase] ?? phase}
        </span>
      </header>

      {telemetry ? (
        <TelemetryChips
          enabled={telemetry.enabled}
          status={telemetry.status}
          sample={telemetry.sample}
        />
      ) : null}

      <div className="big-stats">
        <div className="big-stat">
          <span className="hero-label">First word</span>
          <span className="big-number" data-testid="first-word">
            {firstAnswer === null && running ? '…' : formatSeconds(firstAnswer)}
          </span>
          <span className="big-caption">
            seconds · first token {firstToken === null ? 'n/a' : `${formatSeconds(firstToken)} s`}
          </span>
        </div>
        <div className="big-stat">
          <span className="hero-label">Speed</span>
          <span className="big-number" data-testid="speed">
            {speed === null ? (running ? '…' : 'n/a') : speed.toFixed(1)}
          </span>
          <span className="big-caption">
            tokens/sec{client?.tokensEstimated ? ', estimated from chunks' : ''}
          </span>
        </div>
      </div>

      {run?.reasoning ? (
        <ThinkingBlock key={run.id} run={run} thinkingMs={thinkingMs} running={running} />
      ) : null}

      <div className="run-text" data-testid="answer" aria-live="off" ref={answerRef}>
        {run?.answer ? (
          run.answer
        ) : (
          <span
            className={!running && run && run.state === 'done' ? 'answer-missing' : 'muted-inline'}
            data-testid="answer-empty"
          >
            {emptyAnswer(run, running)}
          </span>
        )}
      </div>

      {run?.error ? (
        <p className="issue issue-error" role="alert" data-testid="run-error">
          <span className="issue-title">The run failed.</span>{' '}
          <span className="issue-hint">{run.error}</span>
        </p>
      ) : null}

      <div className="total-row">
        <span className="hero-label">Total</span>
        <span className={`total-value${running ? ' ticking' : ''}`} data-testid="elapsed">
          {elapsed === null ? (running ? '0.0s' : 'n/a') : `${(elapsed / 1000).toFixed(1)}s`}
        </span>
      </div>
      {client ? (
        <p className="run-footnote">
          {formatRate(client.endToEndTokPerSec, 'tokens/sec')} end to end ·{' '}
          {client.outputTokens ?? client.chunks} tokens
          {client.finishReason ? ` · stopped: ${client.finishReason}` : ''}
          {cutOff ? ' · the answer is cut off at Max tokens' : ''}
        </p>
      ) : null}
    </article>
  );
}

/** Open while the model thinks, folded at the first answer token; a click always wins. */
function ThinkingBlock({
  run,
  thinkingMs,
  running,
}: {
  run: RunView;
  thinkingMs: number | null;
  running: boolean;
}) {
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? run.answer.length === 0;
  const textRef = useFollow(run.reasoning);
  return (
    <details
      className="thinking"
      data-testid="thinking"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (next !== open) setChoice(next);
      }}
    >
      <summary>
        Thinking{thinkingMs !== null ? ` · ${(thinkingMs / 1000).toFixed(1)} s` : ''}
        {running && !run.answer ? ' · live' : ''}
      </summary>
      <div className="thinking-text" ref={textRef}>
        {run.reasoning}
      </div>
    </details>
  );
}
