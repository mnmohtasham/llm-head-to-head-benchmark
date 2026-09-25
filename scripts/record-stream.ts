/**
 * Streams one prompt from a machine and saves the raw stream with the arrival time of every
 * network read, the request, the metrics and Unsloth's monitor row. The key is never written.
 *
 *   npm run record -- --machine "test" --name linux-rtx3060-thinking
 *   npm run record -- --machine "test" --effort low --max-tokens 1500
 *   UNSLOTH_API_KEY=sk-unsloth-... npm run record -- --url 192.168.1.20 --name linux
 *
 * The model already loaded on the machine is used. The parser tests replay every recording.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  chatRequestBody,
  computeClientMetrics,
  normalizeBaseUrl,
  PREFILL_MODES,
  REASONING_EFFORTS,
  redactSecrets,
  textConfigSchema,
  withNonce,
  type Timings,
} from '@duel/shared';
import { streamChatCompletion } from '../server/src/chat-stream';
import { readModelStatus } from '../server/src/models';
import { readMonitorRow } from '../server/src/monitor';
import { MachineStore, type StoredMachine } from '../server/src/store';

const root = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({
  options: {
    machine: { type: 'string' },
    url: { type: 'string' },
    key: { type: 'string' },
    'data-dir': { type: 'string', default: 'data' },
    prompt: {
      type: 'string',
      default:
        'Explain in about 150 words why memory bandwidth limits how fast a local language model writes text.',
    },
    'max-tokens': { type: 'string', default: '600' },
    thinking: { type: 'string', default: 'on' },
    effort: { type: 'string' },
    prefill: { type: 'string', default: 'warm' },
    name: { type: 'string' },
    out: { type: 'string', default: 'fixtures/streams' },
  },
});

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

async function pickMachine(): Promise<StoredMachine> {
  if (values.url) {
    const url = normalizeBaseUrl(values.url);
    if (!url.ok) fail(url.error);
    const now = new Date().toISOString();
    return {
      id: '00000000-0000-4000-8000-000000000000',
      name: values.name ?? url.url,
      baseUrl: url.url,
      notes: '',
      color: '#e8a33d',
      apiKey: values.key ?? process.env.UNSLOTH_API_KEY ?? null,
      agentUrl: null,
      agentToken: null,
      createdAt: now,
      updatedAt: now,
    };
  }
  if (!values.machine) fail('Pass --machine <name or id> from the app, or --url <address>.');
  const store = new MachineStore(path.resolve(root, values['data-dir']));
  await store.init();
  const wanted = values.machine.toLowerCase();
  const machine = store
    .list()
    .find((m) => m.id === values.machine || m.name.toLowerCase() === wanted);
  if (!machine)
    fail(`No machine named "${values.machine}" in ${values['data-dir']}/machines.json.`);
  return machine;
}

const machine = await pickMachine();
const before = await readModelStatus(machine);
if (before.error) fail(before.error);
const model = before.status?.activeModel;
if (!model) fail(`No model is loaded on ${machine.name}. Load one on the Models tab first.`);

const effort = values.effort ?? null;
if (effort !== null && !(REASONING_EFFORTS as readonly string[]).includes(effort)) {
  fail(`--effort must be one of ${REASONING_EFFORTS.join(', ')}.`);
}
const levels = before.status?.reasoningEffortLevels ?? [];
if (effort !== null && levels.length > 0 && !levels.includes(effort)) {
  fail(`${model} accepts --effort ${levels.join(', ')}.`);
}
if (!(PREFILL_MODES as readonly string[]).includes(values.prefill)) {
  fail(`--prefill must be one of ${PREFILL_MODES.join(', ')}.`);
}
const request = textConfigSchema.parse({
  preset: 'custom',
  prompt: values.prompt,
  maxTokens: Number(values['max-tokens']),
  thinking: values.thinking !== 'off',
  reasoningEffort: effort,
  prefill: values.prefill,
});
const nonce = request.prefill === 'cold' ? Date.now().toString(16) : null;
const body = chatRequestBody(request, model, `record-${Date.now()}`, nonce);
const reads: Array<{ t: number; b64: string }> = [];
let requestAt = 0;
const outcome = await streamChatCompletion(machine.baseUrl, machine.apiKey, body, {
  signal: new AbortController().signal,
  idleTimeoutMs: 120_000,
  totalTimeoutMs: 30 * 60_000,
  onRead: (bytes, t) => reads.push({ t, b64: Buffer.from(bytes).toString('base64') }),
});
requestAt = outcome.timeline.requestAt;
const metrics = computeClientMetrics(outcome.timeline);
const usage = [...outcome.timeline.events].reverse().find((e) => e.event.type === 'usage')?.event;
const timings: Timings | null = usage?.type === 'usage' ? usage.timings : null;
const monitor = await readMonitorRow(machine, withNonce(request.prompt, nonce));

const name = (values.name ?? machine.name)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');
const fixture = redactSecrets(
  {
    kind: 'model-duel-stream',
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    machine: { name: machine.name, baseUrl: machine.baseUrl, notes: machine.notes },
    model,
    status: before.status,
    request: body,
    outcome: {
      status: outcome.status,
      failure: outcome.failure,
      networkError: outcome.networkError,
    },
    headersAtMs:
      outcome.timeline.headersAt === null ? null : outcome.timeline.headersAt - requestAt,
    endAtMs: outcome.timeline.endAt - requestAt,
    reads: reads.map((r) => ({ t: Math.round((r.t - requestAt) * 1000) / 1000, b64: r.b64 })),
    metrics,
    server: { timings, monitor },
  },
  [machine.apiKey],
);
const outDir = path.resolve(root, values.out);
await mkdir(outDir, { recursive: true });
const target = path.join(outDir, `${name}.json`);
await writeFile(target, `${JSON.stringify(fixture, null, 2)}\n`);

const f = (v: number | null | undefined, unit: string) =>
  v === null || v === undefined ? 'n/a' : `${v.toFixed(1)} ${unit}`;
process.stdout.write(
  [
    `Saved ${path.relative(root, target)}  (${reads.length} reads, ${outcome.failure ?? 'complete'})`,
    `  model                ${model}`,
    `  time to first token  ${f(metrics.ttftMs, 'ms')}   Unsloth ${f(monitor?.ttftMs, 'ms')}`,
    `  first answer token   ${f(metrics.firstAnswerMs, 'ms')}`,
    `  decode speed         ${f(metrics.decodeTokPerSec, 'tok/s')}   Unsloth ${f(timings?.predictedPerSecond, 'tok/s')}`,
    `  output tokens        ${metrics.outputTokens ?? 'n/a'}   chunks ${metrics.chunks}, coalesced ${metrics.coalescedChunks}`,
    '',
  ].join('\n'),
);
