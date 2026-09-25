import { z } from 'zod';
import { CLOUD_PROVIDERS } from './cloud';
import { TEMPLATE_INFO } from './commands';
import { metricKind, metricsFor } from './compare';
import { IMAGE_PRESETS } from './images';
import { PRESETS } from './presets';
import { canonicalJson, redactText } from './result';
import { deviceRuns, type DeviceRun } from './runs';
import { publicSession, type SessionView, type StoredSession } from './session';
import { runsOf, sessionStats, statisticOf } from './stats';

/**
 * A run record: one machine's run in one race, as Model Duel sends it to a results service that
 * anyone may send to. It holds what a public table needs and nothing that identifies a person or
 * a network: no keys, machine names, addresses, notes, answers, thinking, file names or paths,
 * and a custom prompt only when the sender opts in. The service must still treat every field as
 * untrusted input; see docs/share-api.md.
 */
export const SHARE_FORMAT = 'model-duel-run';
export const SHARE_FORMAT_VERSION = 1;
/** Model Duel refuses to send a larger record, and a service should refuse one too. */
export const SHARE_MAX_BYTES = 256 * 1024;
export const DISPLAY_NAME_MAX = 60;

const text = (max: number) => z.string().max(max);
const maybe = (max: number) => text(max).nullable();
const num = z.number().finite().nullable();
const count = z.number().int().min(0).nullable();

export const shareMetricSchema = z
  .object({
    key: z.string().regex(/^[A-Za-z0-9]{1,40}$/),
    label: text(80),
    unit: text(12),
    better: z.enum(['lower', 'higher']).nullable(),
    n: z.number().int().min(0),
    median: num,
    mean: num,
    min: num,
    max: num,
    stdev: num,
    /** One value per counted round, in order; null where the round failed. */
    values: z.array(num).max(100),
  })
  .strict();

export const shareRecordSchema = z
  .object({
    format: z.literal(SHARE_FORMAT),
    formatVersion: z.literal(SHARE_FORMAT_VERSION),
    /** Stable for this machine's run and this sender: resending replaces, never duplicates. */
    submissionId: z.string().regex(/^[0-9a-f]{32}$/),
    /** The race's random id, shared by the records of its machines. */
    raceId: z.string().uuid(),
    raceDate: z.string().datetime(),
    generator: z
      .object({ app: z.literal('model-duel'), version: text(40), build: maybe(40) })
      .strict(),
    /** The name the sender chose to show, or null for none. Plain text. */
    displayName: maybe(DISPLAY_NAME_MAX),
    race: z
      .object({
        workload: z.enum(['text', 'transcribe', 'image', 'command']),
        kind: z.enum(['text', 'throughput', 'transcribe', 'image', 'command']),
        state: z.enum(['done', 'partial']),
        rounds: z.number().int().min(1).max(100),
        roundsDone: z.number().int().min(1).max(100),
        warmup: z.boolean(),
        sequencing: z.enum(['concurrent', 'sequential']),
        statistic: z.enum(['median', 'mean']),
        /** How many machines raced; the others are not named. */
        machines: z.number().int().min(1).max(8),
      })
      .strict(),
    machine: z
      .object({
        kind: z.enum(['local', 'cloud']),
        provider: z.enum(CLOUD_PROVIDERS).nullable(),
        gpus: z.array(z.object({ name: text(120), memoryGb: num }).strict()).max(16),
        gpuMemoryGb: num,
        platform: maybe(20),
        memoryGb: num,
        /** Family and version only, such as "Linux 6.17" or "macOS 15.6". */
        os: maybe(40),
        studio: maybe(40),
        llamaCpp: maybe(40),
      })
      .strict(),
    model: z
      .object({
        id: maybe(200),
        quant: maybe(40),
        engine: maybe(80),
        contextLength: count,
        kvCache: maybe(20),
        gpuLayers: z.number().int().nullable(),
        totalLayers: count,
        slots: count,
        speculative: maybe(60),
        gpuMemoryMode: maybe(40),
      })
      .strict(),
    settings: z
      .object({
        /** A preset id, or "custom". */
        prompt: maybe(40),
        /** The custom prompt, only when the sender chose to include it. */
        promptText: maybe(4000),
        promptTokens: count,
        prefill: z.enum(['cold', 'warm']).nullable(),
        thinking: maybe(40),
        maxTokens: count,
        concurrency: count,
        sampling: z
          .object({
            temperature: num,
            topP: num,
            topK: num,
            minP: num,
            repetitionPenalty: num,
            seed: num,
          })
          .strict()
          .nullable(),
        /** Transcription, image and command settings in a few words, without file names. */
        summary: maybe(300),
      })
      .strict(),
    metrics: z.array(shareMetricSchema).max(40),
    /** Finish reasons of the counted rounds, such as {"stop": 3}. */
    finish: z.record(z.string().max(40), z.number().int().min(0)).nullable(),
  })
  .strict();
export type ShareRecord = z.infer<typeof shareRecordSchema>;

/** What travels: the record, its checksum and the sender's signature over the same bytes. */
export const shareEnvelopeSchema = z
  .object({
    record: shareRecordSchema,
    /** SHA-256, hex, of the record's canonical JSON. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    signature: z
      .object({
        algorithm: z.literal('Ed25519'),
        /** The sender's public key: 32 raw bytes, base64url. */
        publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        /** Over the record's canonical JSON, UTF-8: 64 bytes, base64url. */
        value: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
      })
      .strict(),
  })
  .strict();
export type ShareEnvelope = z.infer<typeof shareEnvelopeSchema>;

/** The options the sender picks for one record. */
export const shareOptionsSchema = z
  .object({
    displayName: z.string().max(200).default(''),
    includePrompt: z.boolean().default(false),
  })
  .strict();
export type ShareOptions = z.infer<typeof shareOptionsSchema>;

/** "Linux 6.17", "macOS 15.6" or "Windows 11": enough to compare, without the build details. */
export function osFamily(platform: string | null): string | null {
  if (!platform) return null;
  const mac = /^macOS-(\d+)\.(\d+)/.exec(platform);
  if (mac) return `macOS ${mac[1]}.${mac[2]}`;
  const linux = /^Linux-(\d+)\.(\d+)/.exec(platform);
  if (linux) return `Linux ${linux[1]}.${linux[2]}`;
  const windows = /^Windows-(\d+)/.exec(platform);
  if (windows) return `Windows ${windows[1]}`;
  return platform.split(/[-\s]/)[0]?.slice(0, 20) ?? null;
}

// Control characters and the bidirectional overrides that can make text read differently.
const UNSAFE_CHARACTERS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** A display name as plain text: no control or direction characters, no keys or addresses. */
export function cleanDisplayName(name: string): string | null {
  const cleaned = redactText(name.replace(UNSAFE_CHARACTERS, ' ').replace(/\s+/g, ' ').trim());
  return cleaned === '' ? null : cleaned.slice(0, DISPLAY_NAME_MAX).trim();
}

/** Plain text for a record: unsafe characters out, keys and addresses redacted, length capped. */
function clean(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = redactText(value.replace(UNSAFE_CHARACTERS, ' ').trim());
  return cleaned === '' ? null : cleaned.slice(0, max);
}

/**
 * Where records may go: https, or http to this computer for testing. No user name or password in
 * the address, which would travel in every request, and no fragment.
 */
export function checkShareEndpoint(
  input: string,
): { ok: true; url: string } | { ok: false; error: string } {
  const typed = input.trim();
  if (typed.length > 300) return { ok: false, error: 'That address is too long.' };
  let url: URL;
  try {
    url = new URL(typed);
  } catch {
    return { ok: false, error: 'Enter the full address, starting with https://.' };
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    return {
      ok: false,
      error: 'Use https. Plain http is allowed only for a service on this computer.',
    };
  }
  if (url.username || url.password) {
    return { ok: false, error: 'Leave the user name and password out of the address.' };
  }
  if (url.hash) return { ok: false, error: 'Leave the # part out of the address.' };
  return { ok: true, url: url.href };
}

function finishCounts(values: string[]): Record<string, number> | null {
  if (values.length === 0) return null;
  const counts: Record<string, number> = {};
  for (const value of values) {
    const key = value.slice(0, 40);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** The settings of non-text races in a few words, leaving out file and clip names. */
function summaryOf(view: SessionView): string | null {
  if (view.workload === 'transcribe') {
    const c = view.config;
    const audio =
      c.audio.kind === 'clip'
        ? 'LibriSpeech clip'
        : c.audio.kind === 'long'
          ? `LibriSpeech clip repeated, ${c.audio.minutes}+ min`
          : c.audio.reference
            ? 'uploaded audio, with a reference'
            : 'uploaded audio';
    return `${audio}, ${c.language}, requested ${c.engine} on ${c.device}`;
  }
  if (view.workload === 'image') {
    const c = view.config;
    const preset = IMAGE_PRESETS.find((option) => option.id === c.preset)?.label ?? 'Custom prompt';
    return `${preset}, ${c.width}×${c.height}, ${c.steps} steps, guidance ${c.guidance}, seed ${c.seed}, memory ${c.memoryMode}`;
  }
  if (view.workload === 'command') {
    const c = view.config;
    const quality =
      c.template === 'x265' ? `CRF ${c.crf}, ${c.x265Preset}` : `${c.bitrateMbps} Mb/s`;
    return `${TEMPLATE_INFO[c.template].label}, ${quality}${c.maxSeconds ? `, first ${c.maxSeconds} s` : ''}`;
  }
  return null;
}

/** The part of a submission id and a signature that identifies the sender: the public key. */
export function submissionIdFor(
  digest: (text: string) => string,
  publicKey: string,
  raceId: string,
  machineId: string,
): string {
  return digest(`${publicKey}:${raceId}:${machineId}`).slice(0, 32);
}

/**
 * The record for one machine's run in a finished race. Null when the machine has no counted round
 * that finished, since there is nothing to show. `digest` is SHA-256 in hex, passed in so this
 * module runs in the browser too.
 */
export function buildShareRecord(
  session: StoredSession | SessionView,
  machineId: string,
  options: ShareOptions,
  sender: { publicKey: string; version: string; build: string | null },
  digest: (text: string) => string,
): ShareRecord | null {
  const view = publicSession(session);
  const index = view.machines.findIndex((m) => m.id === machineId);
  const row: DeviceRun | undefined = deviceRuns(view)[index];
  if (index < 0 || !row || (row.state !== 'done' && row.state !== 'partial')) return null;
  const p = view.provenance[index] ?? null;
  const kind = metricKind(view);
  const stats = sessionStats(view);
  const runs = runsOf(view, machineId);
  const textConfig = view.workload === 'text' ? view.config : null;

  const metrics = metricsFor(kind)
    .filter((spec) => spec.unit !== 'text')
    .map((spec) => {
      const summary = stats.find((s) => s.key === spec.key)?.summaries[index];
      const values = runs.map((run) => {
        const v = run.state === 'done' ? spec.pick(run) : null;
        return typeof v === 'number' && Number.isFinite(v) ? v : null;
      });
      return {
        key: spec.key,
        label: spec.label,
        unit: spec.unit,
        better: spec.better,
        n: summary?.n ?? 0,
        median: summary?.median ?? null,
        mean: summary?.mean ?? null,
        min: summary?.min ?? null,
        max: summary?.max ?? null,
        stdev: summary?.stdev ?? null,
        values,
      };
    })
    .filter((metric) => metric.n > 0);

  const custom = textConfig?.preset === 'custom';
  const record: ShareRecord = {
    format: SHARE_FORMAT,
    formatVersion: SHARE_FORMAT_VERSION,
    submissionId: submissionIdFor(digest, sender.publicKey, view.id, machineId),
    raceId: view.id,
    raceDate: new Date(view.createdAt).toISOString(),
    generator: {
      app: 'model-duel',
      version: sender.version.slice(0, 40),
      build: sender.build?.slice(0, 40) ?? null,
    },
    displayName: cleanDisplayName(options.displayName),
    race: {
      workload: view.workload,
      kind,
      state: row.state,
      rounds: row.rounds,
      roundsDone: row.roundsDone,
      warmup: view.plan.warmup,
      sequencing: view.plan.sequencing,
      statistic: statisticOf(view.plan),
      machines: view.machines.length,
    },
    machine: {
      kind: row.cloud ? 'cloud' : 'local',
      provider: row.cloud,
      gpus: (p?.gpus ?? []).slice(0, 16).map((gpu) => ({
        name: clean(gpu.name, 120) ?? 'unknown',
        memoryGb: gpu.memoryGb,
      })),
      gpuMemoryGb: row.gpuMemoryGb,
      platform: clean(row.platform, 20),
      memoryGb: row.memoryGb,
      os: osFamily(row.os),
      studio: clean(row.studio, 40),
      llamaCpp: clean(row.llamaCpp, 40),
    },
    model: {
      id: clean(row.model, 200),
      quant: clean(row.quant, 40),
      engine: clean(row.engine, 80),
      contextLength: row.contextLength,
      kvCache: row.chatModel ? clean(row.kvCache ?? 'default', 20) : null,
      gpuLayers: row.gpuLayers,
      totalLayers: row.totalLayers,
      slots: row.slots,
      speculative: clean(row.speculative, 60),
      gpuMemoryMode: clean(row.gpuMemoryMode, 40),
    },
    settings: {
      prompt: textConfig ? textConfig.preset : null,
      promptText: custom && options.includePrompt ? clean(textConfig?.prompt, 4000) : null,
      promptTokens: row.promptTokens === null ? null : Math.round(row.promptTokens),
      prefill: row.prefill,
      thinking: clean(row.thinking, 40),
      maxTokens: row.maxTokens,
      concurrency: row.concurrency,
      sampling: textConfig ? { ...textConfig.sampling } : null,
      summary: summaryOf(view),
    },
    metrics,
    finish:
      view.workload === 'text'
        ? finishCounts(
            runs
              .filter((run) => run.state === 'done')
              .map((run) => run.client?.finishReason ?? 'unknown'),
          )
        : null,
  };
  // The schema is the last word on what may leave: anything it does not allow stops here.
  return shareRecordSchema.parse(record);
}

/** The bytes that are hashed and signed: the record's canonical JSON. */
export function shareSigningText(record: ShareRecord): string {
  return canonicalJson(record);
}

/** Preset labels, for showing a record's prompt. */
export function presetLabel(id: string | null): string | null {
  if (id === null) return null;
  return PRESETS.find((preset) => preset.id === id)?.label ?? id;
}

/** The JSON Schema of the envelope a service receives, for docs/share-format.schema.json. */
export function shareJsonSchema(): Record<string, unknown> {
  return {
    $id: `urn:model-duel:schema:run:${SHARE_FORMAT_VERSION}`,
    title: 'Model Duel run record',
    description:
      "One machine's run in one race, as Model Duel sends it to a results service: the record, its SHA-256 and the sender's Ed25519 signature. See docs/share-api.md.",
    ...z.toJSONSchema(shareEnvelopeSchema),
  };
}
