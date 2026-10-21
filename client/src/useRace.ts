import type {
  MachineView,
  RoundView,
  RunView,
  SessionRequest,
  SessionStreamMessage,
  SessionSummary,
  SessionView,
  Workload,
} from '@duel/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, messageOf } from './api';
import type { NewLogEntry } from './components/LogPanel';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function sessionIdFromHash(workload: Workload): string | null {
  return new RegExp(`^#/${workload}/(${UUID})$`).exec(window.location.hash)?.[1] ?? null;
}

/** The race named in the address, `#/<workload>/<id>`, so a reload or a shared link opens it again. */
function useRouteSessionId(workload: Workload): string | null {
  const [id, setId] = useState(() => sessionIdFromHash(workload));
  useEffect(() => {
    const onHashChange = () => setId(sessionIdFromHash(workload));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [workload]);
  return id;
}

function withRound(
  session: SessionView,
  warmup: boolean,
  index: number,
  update: (runs: RunView[]) => RunView[],
): SessionView {
  if (warmup) {
    return session.warmup
      ? { ...session, warmup: { ...session.warmup, runs: update(session.warmup.runs) } }
      : session;
  }
  return {
    ...session,
    rounds: session.rounds.map((round) =>
      round.index === index ? { ...round, runs: update(round.runs) } : round,
    ),
  };
}

function putRound(session: SessionView, warmup: boolean, round: RoundView): SessionView {
  if (warmup) return { ...session, warmup: round };
  const others = session.rounds.filter((r) => r.index !== round.index);
  return { ...session, rounds: [...others, round].sort((a, b) => a.index - b.index) };
}

function applyMessage(session: SessionView, message: SessionStreamMessage): SessionView {
  if (message.type === 'snapshot' || message.type === 'finished') return message.session;
  if (message.type === 'progress') return { ...session, progress: message.progress };
  if (message.type === 'round') return putRound(session, message.warmup, message.round);
  if (message.type === 'run') {
    return withRound(session, message.warmup, message.round, (runs) =>
      runs.map((run) => (run.machineId === message.run.machineId ? message.run : run)),
    );
  }
  return withRound(session, message.warmup, message.round, (runs) =>
    runs.map((run) => {
      const delta = message.runs.find((d) => d.machineId === run.machineId);
      if (!delta || run.finishedAt !== null) return run;
      return {
        ...run,
        state: delta.state,
        reasoning: run.reasoning + delta.reasoning,
        answer: run.answer + delta.answer,
        live: delta.live,
      };
    }),
  );
}

/** Applies stream messages in order to the race on screen; a snapshot replaces it whole. */
function applyMessages(
  session: SessionView | null,
  id: string,
  messages: readonly SessionStreamMessage[],
): SessionView | null {
  let view = session;
  for (const message of messages) {
    if (message.type === 'snapshot') view = message.session;
    else if (view && view.id === id) view = applyMessage(view, message);
  }
  return view;
}

/** The longest wait before reading a race whose stream closed again. */
const MAX_RETRY_MS = 15_000;
/** Hidden tabs get no animation frames, so text still lands this often there. */
const HIDDEN_FLUSH_MS = 250;

interface Options {
  workload: Workload;
  machines: MachineView[] | null;
  addLog: (entry: NewLogEntry) => void;
  /** The log line for a finished run. */
  describeRun: (run: RunView) => string;
  /** A race opened on purpose from the address: fill the form with its settings. */
  onOpen: (view: SessionView) => void;
}

/**
 * The race on screen for one workload: which one the address or the log names, its live stream,
 * starting, cancelling and deleting, and which round the panes show.
 */
export function useRace({ workload, machines, addLog, describeRun, onOpen }: Options) {
  const routeId = useRouteSessionId(workload);
  const [session, setSession] = useState<SessionView | null>(null);
  const [allSummaries, setAllSummaries] = useState<SessionSummary[] | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [devMode, setDevMode] = useState(false);
  const [starting, setStarting] = useState(false);
  /** The race a cancel was asked for, until it stops. */
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  /** The live stream dropped and is being opened again. */
  const [reconnecting, setReconnecting] = useState(false);
  /** A race opened from the address, waiting for the machine list before it fills the form. */
  const [toFill, setToFill] = useState<SessionView | null>(null);
  const [deleting, setDeleting] = useState<SessionSummary | null>(null);
  /** The round shown in the panes; null follows the newest. -1 is the warm-up. */
  const [shownRound, setShownRound] = useState<number | null>(null);
  /** The blind vote hides everything that could name a machine. */
  const [blind, setBlind] = useState(false);

  const refreshSummaries = useCallback(() => {
    api.listSessions().then(
      ({ sessions }) => setAllSummaries(sessions),
      (error: unknown) => setFormError(messageOf(error)),
    );
  }, []);

  useEffect(() => {
    api.health().then(
      (health) => setDevMode(health.mode === 'dev'),
      () => undefined,
    );
    refreshSummaries();
  }, [refreshSummaries]);

  const summaries = useMemo(
    () => allSummaries?.filter((s) => (s.workload ?? 'text') === workload) ?? null,
    [allSummaries, workload],
  );

  // Open the race in the address, or the latest one of this workload.
  const shownId = session?.id ?? null;
  const latestId = summaries?.[0]?.id ?? null;
  const wantedId = routeId ?? latestId;
  useEffect(() => {
    if (!wantedId || wantedId === shownId) return;
    let cancelled = false;
    api.getSession(wantedId).then(
      (view) => {
        if (cancelled) return;
        if (view.workload !== workload) {
          // A link to another kind of race: open it where it belongs.
          window.location.hash = `#/${view.workload}/${view.id}`;
          return;
        }
        setSession(view);
        setShownRound(null);
        // Opening a race on purpose loads its settings, so Start runs it again.
        if (view.id === routeId) setToFill(view);
      },
      (error: unknown) => {
        if (!cancelled) setFormError(`Could not open that race. ${messageOf(error)}`);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [wantedId, shownId, routeId, workload]);

  // The form picks the race's machines from the machine list, so it waits for the list.
  useEffect(() => {
    if (!toFill || machines === null) return;
    onOpen(toFill);
    setToFill(null);
  }, [toFill, machines, onOpen]);

  const reportRun = useCallback(
    (run: RunView, warmup: boolean) => {
      const machine = machines?.find((m) => m.id === run.machineId);
      const what = warmup ? 'Warm-up' : 'Run';
      addLog({
        machineName: machine?.name ?? run.machineName,
        color: machine?.color ?? null,
        tone: run.state === 'done' ? 'ok' : run.state === 'cancelled' ? 'info' : 'error',
        text:
          run.state === 'done'
            ? `${warmup ? 'Warm-up, not counted: ' : ''}${describeRun(run)}`
            : run.state === 'cancelled'
              ? `${what} cancelled.`
              : `${what} failed: ${run.error ?? 'unknown error'}`,
      });
    },
    [machines, addLog, describeRun],
  );
  // The stream stays open when the machine list changes; runs are reported with the latest names.
  const reportRunRef = useRef(reportRun);
  useEffect(() => {
    reportRunRef.current = reportRun;
  }, [reportRun]);

  const running = session !== null && session.finishedAt === null;
  useEffect(() => {
    if (!shownId || !running) return;
    let source: EventSource | null = null;
    let stopped = false;
    let lost = false;
    let failures = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    // Text arrives about twenty times a second; it is applied at most once a frame, in order.
    let queue: SessionStreamMessage[] = [];
    let frame: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      if (timer !== null) clearTimeout(timer);
      frame = null;
      timer = null;
      const batch = queue;
      queue = [];
      if (batch.length > 0) setSession((current) => applyMessages(current, shownId, batch));
    };
    const schedule = () => {
      if (frame !== null || timer !== null) return;
      frame = requestAnimationFrame(flush);
      timer = setTimeout(flush, HIDDEN_FLUSH_MS);
    };
    const setLost = (now: boolean) => {
      if (lost === now) return;
      lost = now;
      setReconnecting(now);
    };

    // The stream closed for good: read the race, which says whether it ended meanwhile.
    const recover = () => {
      api.getSession(shownId).then(
        (view) => {
          if (stopped) return;
          if (view.finishedAt === null) {
            retryLater();
            return;
          }
          flush();
          setLost(false);
          setSession((current) => (current?.id === view.id ? view : current));
          refreshSummaries();
        },
        (error: unknown) => {
          if (stopped) return;
          // Signed out: the sign-in screen takes over. Gone: there is nothing left to follow.
          if (error instanceof ApiError && (error.status === 401 || error.status === 404)) {
            setLost(false);
            if (error.status === 404) setFormError(`This race is gone. ${messageOf(error)}`);
            return;
          }
          retryLater();
        },
      );
    };
    const retryLater = () => {
      const wait = Math.min(1000 * 2 ** failures, MAX_RETRY_MS);
      failures += 1;
      retry = setTimeout(connect, wait);
    };

    const connect = () => {
      retry = null;
      const stream = new EventSource(api.sessionStreamUrl(shownId));
      source = stream;
      stream.onopen = () => {
        failures = 0;
      };
      // Every connection starts with a snapshot, which replaces the race whole, so text from
      // before a reconnect is never added twice.
      stream.onmessage = (event) => {
        const message = JSON.parse(event.data as string) as SessionStreamMessage;
        setLost(false);
        queue.push(message);
        if (message.type === 'delta') schedule();
        else flush();
        if (message.type === 'run') reportRunRef.current(message.run, message.warmup);
        if (message.type === 'finished') {
          stopped = true;
          stream.close();
          refreshSummaries();
        }
      };
      stream.onerror = () => {
        if (stopped) return;
        setLost(true);
        // The browser opens a dropped connection again by itself. An answer that is not a
        // stream, such as a proxy's 502 or a 401 after signing out, closes it for good.
        if (stream.readyState !== EventSource.CLOSED) return;
        stream.close();
        recover();
      };
    };

    connect();
    return () => {
      stopped = true;
      source?.close();
      if (retry !== null) clearTimeout(retry);
      if (frame !== null) cancelAnimationFrame(frame);
      if (timer !== null) clearTimeout(timer);
      setReconnecting(false);
    };
  }, [shownId, running, refreshSummaries]);

  /** Starts a race; returns the refusal so pre-flight can show what the server found. */
  const start = async (request: SessionRequest, names: string[]): Promise<ApiError | null> => {
    setFormError(null);
    setStarting(true);
    try {
      const created = await api.startSession(request);
      setSession(created);
      setShownRound(null);
      window.location.hash = `#/${workload}/${created.id}`;
      refreshSummaries();
      addLog({
        machineName: null,
        color: null,
        tone: 'info',
        text:
          (names.length === 1
            ? `Run started on ${names[0] ?? 'one machine'}`
            : `Race started: ${names.join(', ')}`) +
          (request.plan.rounds > 1 ? `, ${request.plan.rounds} rounds.` : '.'),
      });
      return null;
    } catch (error) {
      setFormError(messageOf(error));
      return error instanceof ApiError ? error : null;
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    if (!session) return;
    setCancellingId(session.id);
    try {
      setSession(await api.cancelSession(session.id));
      refreshSummaries();
    } catch (error) {
      setCancellingId(null);
      setFormError(messageOf(error));
    }
  };

  const remove = async (target: SessionSummary) => {
    await api.deleteSession(target.id);
    setDeleting(null);
    setAllSummaries((current) => current?.filter((s) => s.id !== target.id) ?? null);
    if (session?.id === target.id) {
      setSession(null);
      if (routeId) window.location.hash = `#/${workload}`;
    }
  };

  // Panes: a round of the race on screen. While a race runs they follow it; afterwards they show
  // the round picked in the round table.
  const newest =
    session === null
      ? null
      : session.progress.phase === 'warmup'
        ? session.warmup
        : (session.rounds[session.rounds.length - 1] ?? session.warmup);
  const picked =
    session === null || shownRound === null || running
      ? null
      : shownRound === -1
        ? session.warmup
        : (session.rounds.find((r) => r.index === shownRound) ?? null);
  const round = picked ?? newest;
  const roundIndex = round === null ? null : round === session?.warmup ? -1 : round.index;
  const counted = session?.rounds.some((r) => r.runs.some((run) => run.state === 'done')) ?? false;
  const manyRounds =
    (session?.rounds.length ?? 0) > 1 || (session !== null && session.warmup !== null);

  return {
    session,
    setSession,
    summaries,
    refreshSummaries,
    formError,
    setFormError,
    devMode,
    starting,
    /** Cancel was asked for and the race has not stopped yet. */
    cancelling: running && cancellingId === session?.id,
    /** The live stream dropped and is being opened again. */
    reconnecting: running && reconnecting,
    deleting,
    setDeleting,
    setShownRound,
    blind,
    setBlind,
    running,
    start,
    cancel,
    remove,
    round,
    roundIndex,
    counted,
    manyRounds,
  };
}
