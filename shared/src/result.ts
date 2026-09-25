import { z } from 'zod';
import { metricKind, metricsFor, type MetricKind } from './compare';
import { scoreboard, setupTable } from './report';
import { publicRun, publicSession, type StoredSession } from './session';
import { sessionStats } from './stats';

/**
 * The public result file: one finished race, with every measurement Model Duel took, in a stable,
 * versioned shape meant to be shared. It is built from the stored session, so the session format
 * can change inside the app while this one only changes with a new `formatVersion`.
 *
 * Never in a result: API keys and agent tokens (they never enter a session), machine addresses,
 * machine notes, and local file paths or network addresses in messages. Prompts, answers and
 * thinking stay as they are: they are the result.
 */
export const RESULT_FORMAT = 'model-duel-result';
export const RESULT_FORMAT_VERSION = 1;

const nullableNumber = z.number().nullable();
const looseObject = z.record(z.string(), z.unknown());

const summarySchema = z.object({
  n: z.number(),
  median: nullableNumber,
  min: nullableNumber,
  max: nullableNumber,
  mean: nullableNumber,
  stdev: nullableNumber,
});

const runSchema = z.object({
  /** Index into `machines`. */
  machine: z.number().int(),
  state: z.enum(['starting', 'queued', 'streaming', 'done', 'failed', 'cancelled']),
  error: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  /** The model the machine had before and after the run, as it named it. */
  modelBefore: z.string().nullable(),
  modelAfter: z.string().nullable(),
  /** After the first machine's request, in a race run together. */
  sendOffsetMs: nullableNumber,
  rtt: z.object({ samplesMs: z.array(z.number()), medianMs: nullableNumber }).nullable(),
  loopLagMs: z.object({ max: z.number(), p99: z.number() }).nullable(),
  /** The workload's metrics for this run, by the keys in `metricDefinitions`. */
  metrics: z.record(z.string(), z.union([z.number(), z.string(), z.null()])),
  /** The full measurements of the run, by workload: client, server, transcription, image, throughput, command. */
  details: z.object({
    client: looseObject.nullable(),
    server: looseObject.nullable(),
    transcription: looseObject.nullable(),
    image: looseObject.nullable(),
    throughput: looseObject.nullable(),
    command: looseObject.nullable(),
  }),
  /** Text runs: what the model thought and answered. */
  text: z.object({ reasoning: z.string(), answer: z.string() }).nullable(),
  /** Hardware readings around the run, and the energy they add up to. */
  telemetry: looseObject.nullable(),
  /** Tokens against time: `[ms since the request, tokens so far, 1 while thinking]`. */
  timeline: z
    .array(z.tuple([z.number(), z.number(), z.union([z.literal(0), z.literal(1)])]))
    .nullable(),
  /** Every streamed event of a text run, compact: `[ms, read, 'r' | 'c', text]` or `[ms, read, event]`. */
  events: looseObject.nullable(),
});

const roundSchema = z.object({
  index: z.number().int(),
  warmup: z.boolean(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  sendSkewMs: nullableNumber,
  /** Machine indexes in the order their requests left. */
  order: z.array(z.number().int()),
  nonce: z.string().nullable(),
  loopLagMs: z.object({ max: z.number(), p99: z.number() }).nullable(),
  flags: z.array(
    z.object({ machine: z.number().int().nullable(), kind: z.string(), text: z.string() }),
  ),
  runs: z.array(runSchema),
});

export const resultSchema = z.object({
  format: z.literal(RESULT_FORMAT),
  formatVersion: z.literal(RESULT_FORMAT_VERSION),
  /** The race's id, the same in the app and in every copy of the file. */
  id: z.string().uuid(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  state: z.enum(['running', 'done', 'failed', 'cancelled', 'interrupted']),
  error: z.string().nullable(),
  generator: z.object({
    app: z.literal('Model Duel'),
    version: z.string(),
    build: z.string().nullable(),
    sessionSchemaVersion: z.number().int(),
  }),
  workload: z.enum(['text', 'transcribe', 'image', 'command']),
  /** The metric set: the workload, with text split into latency and throughput. */
  kind: z.enum(['text', 'throughput', 'transcribe', 'image', 'command']),
  settings: z.object({
    /** The workload's settings as sent, prompt included. */
    config: looseObject,
    plan: z.object({
      rounds: z.number().int(),
      warmup: z.boolean(),
      settleMs: z.number(),
      sequencing: z.enum(['concurrent', 'sequential']),
    }),
    telemetry: z.object({ enabled: z.boolean() }),
  }),
  machines: z.array(
    z.object({
      index: z.number().int(),
      label: z.string(),
      color: z.string(),
      /** `local` runs Unsloth on the user's machine; `cloud` is a provider's model, as a reference. */
      kind: z.enum(['local', 'cloud']).optional(),
      /** For a cloud model: the provider and model id. */
      cloud: z.object({ provider: z.string(), model: z.string().nullable() }).nullable().optional(),
      hardware: z.object({
        os: z.string().nullable(),
        backend: z.string().nullable(),
        memoryTotalGb: nullableNumber,
        gpus: z.array(z.object({ name: z.string(), memoryGb: nullableNumber })),
      }),
      software: z.object({
        unsloth: z.string().nullable(),
        studio: z.string().nullable(),
        llamaCpp: z.string().nullable(),
      }),
      /** What the machine ran, from its own status routes, before and after. */
      state: z.object({
        textBefore: looseObject.nullable(),
        textAfter: looseObject.nullable(),
        sttBefore: looseObject.nullable(),
        sttAfter: looseObject.nullable(),
        imageBefore: looseObject.nullable(),
        imageAfter: looseObject.nullable(),
        restore: looseObject.nullable(),
        agent: looseObject.nullable(),
      }),
      /** The exact request body the machine received, without keys. */
      request: looseObject.nullable(),
      /** The setup table as the report shows it, with the settings that differ marked. */
      setup: z.array(
        z.object({ key: z.string(), label: z.string(), value: z.string(), differs: z.boolean() }),
      ),
    }),
  ),
  metricDefinitions: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      unit: z.string(),
      better: z.enum(['lower', 'higher']).nullable(),
    }),
  ),
  rounds: z.array(roundSchema),
  summary: z.object({
    stats: z.array(
      z.object({
        key: z.string(),
        machines: z.array(summarySchema),
        verdict: z.object({
          kind: z.enum(['win', 'tie', 'none']),
          leader: z.number().int().nullable(),
          runnerUp: z.number().int().nullable(),
          ratio: nullableNumber,
          reason: z.enum(['ranges', 'gap']).nullable(),
        }),
      }),
    ),
    scoreboard: z.array(
      z.object({
        key: z.string(),
        kind: z.enum(['win', 'tie']),
        text: z.string(),
        winner: z.number().int().nullable(),
      }),
    ),
    votes: z.array(looseObject),
  }),
  privacy: z.object({ removed: z.array(z.string()) }),
  /** SHA-256 of the canonical JSON of everything else, to spot a damaged or edited copy. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ResultFile = z.infer<typeof resultSchema>;

/** A result before its checksum is added. */
export type UnsignedResult = Omit<ResultFile, 'sha256'>;

/**
 * JSON with object keys sorted at every depth and no spaces, so the same result always gives the
 * same text and the same checksum.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

const HOME = /(\/home\/|\/Users\/|[A-Za-z]:\\Users\\)[^/\\\s"']+/g;
const URL_OR_ADDRESS =
  /\bhttps?:\/\/[^\s"'<>)]+|\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b|\[[0-9a-f:]+\](?::\d+)?/gi;
/** API keys a provider might echo in an error, even masked. */
const API_KEY = /\b(?:sk-(?:ant-|proj-|unsloth-)?[\w*.…-]{6,}|AIza[\w-]{20,})/g;
const ABSOLUTE_PATH = /(?:^|(?<=[\s="'(]))(?:\/[\w.@+-]+){2,}/g;

/**
 * Takes local paths and network addresses out of a message or setting: home folders become `~`,
 * other absolute paths keep only their last part, and URLs and IP addresses become `<address>`.
 */
export function redactText(text: string): string {
  return text
    .replace(API_KEY, '<key>')
    .replace(URL_OR_ADDRESS, '<address>')
    .replace(HOME, '~')
    .replace(ABSOLUTE_PATH, (path) => `<path>/${path.split('/').pop() ?? ''}`);
}

/** `redactText` on every string inside a value, keys included. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v as unknown)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        redactText(k),
        redactDeep(v),
      ]),
    ) as T;
  }
  return value;
}

const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (structuredClone(value) as Record<string, unknown>) : null;

/** The metric value a run shows for each metric of its session's kind. */
function runMetrics(kind: MetricKind, run: StoredSession['rounds'][number]['runs'][number]) {
  const view = publicRun(run);
  return Object.fromEntries(
    metricsFor(kind).map((spec) => {
      const v = spec.pick(view);
      return [spec.key, typeof v === 'number' || typeof v === 'string' ? v : null];
    }),
  );
}

/** Builds the public result of a stored session; the server adds the checksum. */
export function buildResult(
  session: StoredSession,
  generator: { version: string; build: string | null },
): UnsignedResult {
  const view = publicSession(structuredClone(session));
  const kind = metricKind(session);
  const machineIndex = new Map(session.machines.map((m, i) => [m.id, i]));
  const index = (id: string | null) => (id === null ? null : (machineIndex.get(id) ?? null));
  const setup = setupTable(view);
  const text = session.workload === 'text';

  const round = (r: StoredSession['rounds'][number], warmup: boolean) => ({
    index: r.index,
    warmup,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    sendSkewMs: r.sendSkewMs,
    order: r.order.map((id) => index(id)).filter((i): i is number => i !== null),
    nonce: r.nonce,
    loopLagMs: r.loopLagMs,
    flags: r.flags.map((f) => ({
      machine: index(f.machineId),
      kind: f.kind,
      text: redactText(f.text),
    })),
    runs: r.runs.map((run) => ({
      machine: index(run.machineId) ?? -1,
      state: run.state,
      error: run.error === null ? null : redactText(run.error),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      modelBefore: run.modelBefore === null ? null : redactText(run.modelBefore),
      modelAfter: run.modelAfter === null ? null : redactText(run.modelAfter),
      sendOffsetMs: run.sendOffsetMs,
      rtt: run.rtt,
      loopLagMs: run.loopLagMs,
      metrics: runMetrics(kind, run),
      details: redactDeep({
        client: asObject(run.client),
        server: asObject(run.server),
        transcription: asObject(run.transcription),
        image: asObject(run.image),
        throughput: asObject(run.throughput),
        command: asObject(run.command),
      }),
      text: text ? { reasoning: run.reasoning, answer: run.answer } : null,
      telemetry: asObject(run.telemetry),
      timeline: run.timeline,
      events: asObject(run.raw),
    })),
  });

  const stats = sessionStats(view);
  const byMachine = (id: string | null) => index(id);
  return {
    format: RESULT_FORMAT,
    formatVersion: RESULT_FORMAT_VERSION,
    id: session.id,
    createdAt: session.createdAt,
    finishedAt: session.finishedAt,
    state: session.state,
    error: session.error === null ? null : redactText(session.error),
    generator: {
      app: 'Model Duel',
      version: generator.version,
      build: generator.build,
      sessionSchemaVersion: session.schemaVersion,
    },
    workload: session.workload,
    kind,
    settings: {
      config: structuredClone(session.config) as unknown as Record<string, unknown>,
      plan: { ...session.plan },
      telemetry: { ...session.telemetry },
    },
    machines: session.machines.map((machine, i) => {
      const p = session.provenance.find((x) => x.machineId === machine.id) ?? null;
      return {
        index: i,
        label: machine.name,
        color: machine.color,
        kind: p?.cloud ? ('cloud' as const) : ('local' as const),
        cloud: p?.cloud ? { provider: p.cloud.provider, model: p.cloud.model?.id ?? null } : null,
        hardware: {
          os: p?.platform.os ?? null,
          backend: p?.platform.backend ?? null,
          memoryTotalGb: p?.platform.memoryTotalGb ?? null,
          gpus: p?.gpus.map((g) => ({ name: g.name, memoryGb: g.memoryGb })) ?? [],
        },
        software: {
          unsloth: p?.versions.unsloth ?? null,
          studio: p?.versions.studio ?? null,
          llamaCpp: p?.versions.llamaCpp ?? null,
        },
        state: redactDeep({
          textBefore: asObject(p?.statusBefore),
          textAfter: asObject(p?.statusAfter),
          sttBefore: asObject(p?.sttBefore),
          sttAfter: asObject(p?.sttAfter),
          imageBefore: asObject(p?.imageBefore),
          imageAfter: asObject(p?.imageAfter),
          restore: asObject(p?.restore),
          agent: asObject(p?.agent),
        }),
        request: p?.request ? redactDeep(asObject(p.request)) : null,
        setup: setup.rows
          .filter((row) => row.key !== 'address' && row.key !== 'notes')
          .map((row) => ({
            key: row.key,
            label: row.label,
            value: redactText(String(row.cells[i]?.text ?? '')),
            differs: row.differs === true,
          })),
      };
    }),
    metricDefinitions: metricsFor(kind).map((spec) => ({
      key: spec.key,
      label: spec.label,
      unit: spec.unit,
      better: spec.better,
    })),
    rounds: [
      ...(session.warmup ? [round(session.warmup, true)] : []),
      ...session.rounds.map((r) => round(r, false)),
    ],
    summary: {
      stats: stats.map((row) => ({
        key: row.key,
        machines: row.summaries.map((s) => ({ ...s })),
        verdict: { ...row.verdict },
      })),
      scoreboard: scoreboard(view).map((line) => ({
        key: line.key,
        kind: line.kind,
        text: line.text,
        winner: byMachine(line.winnerId),
      })),
      votes: session.votes.map((v) => ({
        round: v.round,
        left: index(v.left),
        right: index(v.right),
        choice: v.choice,
        at: v.at,
      })),
    },
    privacy: {
      removed: [
        'API keys and agent tokens',
        'machine addresses',
        'machine notes',
        'local file paths and network addresses in messages and settings',
      ],
    },
  };
}

/** The result format as JSON Schema (draft 2020-12), for anyone reading or checking result files. */
export function resultJsonSchema(): Record<string, unknown> {
  return {
    $id: `urn:model-duel:schema:result:${RESULT_FORMAT_VERSION}`,
    title: 'Model Duel result',
    description:
      'One benchmark race between machines running Unsloth Studio, and cloud models as references: settings, machines, every round and run with its measurements, and the statistics. See docs/result-format.md.',
    ...z.toJSONSchema(resultSchema),
  };
}
