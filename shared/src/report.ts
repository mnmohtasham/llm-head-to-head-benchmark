import { metricKind, type MetricUnit } from './compare';
import { formatMsValue, formatSeconds, formatValue } from './format';
import { imagePrompt } from './images';
import { PRESETS } from './presets';
import { LIBRISPEECH_CLIP } from './transcribe';
import {
  audioLabel,
  backendLabel,
  speculativeOn,
  type MachineProvenance,
  type RoundView,
  type SessionView,
} from './session';
import {
  GATE_RATIO,
  runsOf,
  sessionStats,
  type StatRow,
  type Summary,
  type Verdict,
} from './stats';

/**
 * The tables of a finished session, as models every view renders: the page, the CSV and the
 * Markdown summary. Keeping one model means the three can never disagree.
 */
export interface TableCell {
  /** The raw value, for CSV; text for text columns. */
  value: number | string | null;
  /** The value as the page shows it. */
  text: string;
  /** A second line under the value, such as the spread. */
  detail?: string | null;
  best?: boolean;
}

export interface TableRow {
  key: string;
  label: string;
  /** Unit of the raw values, for CSV headers. */
  unit: MetricUnit | null;
  hint: string | null;
  cells: TableCell[];
  verdict?: Verdict['kind'];
  /** Cells that differ between machines where it changes the comparison. */
  differs?: boolean;
}

export interface TableModel {
  title: string;
  columns: string[];
  rows: TableRow[];
}

function spread(summary: Summary, unit: MetricUnit): string | null {
  if (summary.n < 2 || summary.min === null || summary.max === null) return null;
  const sd = summary.stdev === null ? '' : ` · sd ${formatValue(summary.stdev, unit)}`;
  return `${formatValue(summary.min, unit)} to ${formatValue(summary.max, unit)}${sd}`;
}

function textValues(session: SessionView, machineId: string, key: string): string {
  const values = runsOf(session, machineId).map((run) =>
    key === 'finish' ? (run.client?.finishReason ?? run.state) : run.state,
  );
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => (count > 1 ? `${value} ×${count}` : value))
    .join(', ');
}

export function verdictText(row: StatRow, session: SessionView): string {
  const { verdict } = row;
  if (verdict.kind === 'none') return '';
  if (verdict.kind === 'tie') return 'Tie';
  const leader = session.machines[verdict.leader ?? -1]?.name ?? '';
  const ratio =
    verdict.ratio === null || !Number.isFinite(verdict.ratio)
      ? ''
      : `, ${verdict.ratio.toFixed(2)}×`;
  return `${leader}${ratio}`;
}

export function comparisonTable(session: SessionView): TableModel {
  const stats = sessionStats(session);
  const multi = session.machines.length > 1;
  const rounds = session.rounds.length;
  return {
    title: rounds > 1 ? `Comparison · medians of ${rounds} rounds` : 'Comparison',
    columns: ['Metric', ...session.machines.map((m) => m.name), ...(multi ? ['Result'] : [])],
    rows: stats.map((row) => {
      const cells: TableCell[] = row.summaries.map((summary, i) => {
        if (row.unit === 'text') {
          const text = textValues(session, session.machines[i]?.id ?? '', row.key);
          return { value: text, text };
        }
        return {
          value: summary.median,
          text: formatValue(summary.median, row.unit),
          detail: spread(summary, row.unit),
          best: row.verdict.kind === 'win' && row.verdict.leader === i,
        };
      });
      if (multi) {
        const text = verdictText(row, session);
        cells.push({ value: text, text });
      }
      return {
        key: row.key,
        label: row.label,
        unit: row.unit === 'text' ? null : row.unit,
        hint:
          row.better === 'lower'
            ? 'lower is better'
            : row.better === 'higher'
              ? 'higher is better'
              : null,
        cells,
        verdict: row.verdict.kind,
      };
    }),
  };
}

/** The three cells a machine gets in a round row, and their column names. */
const ROUND_CELLS = {
  text: {
    names: ['first word (ms)', 'speed (tok/s)', 'RTT (ms)'],
    cells: (run: RoundView['runs'][number] | undefined): TableCell[] => {
      const done = run?.state === 'done';
      const first = done ? (run?.client?.firstAnswerMs ?? null) : null;
      const speed = done ? (run?.client?.decodeTokPerSec ?? null) : null;
      const rtt = run?.rtt?.medianMs ?? null;
      const state = !run ? 'n/a' : run.state === 'queued' ? 'waiting' : run.state;
      return [
        done
          ? { value: first, text: first === null ? 'no answer' : `${formatSeconds(first)} s` }
          : { value: state, text: state },
        { value: speed, text: done ? formatValue(speed, 'tok/s') : '' },
        { value: rtt, text: rtt === null ? '' : `RTT ${formatMsValue(rtt)}` },
      ];
    },
  },
  transcribe: {
    names: ['processing (ms)', 'real-time factor', 'word error rate (%)'],
    cells: (run: RoundView['runs'][number] | undefined): TableCell[] => {
      const done = run?.state === 'done';
      const t = done ? (run?.transcription ?? null) : null;
      const state = !run ? 'n/a' : run.state === 'queued' ? 'waiting' : run.state;
      const wer = t?.wer ? t.wer.wer * 100 : null;
      return [
        done
          ? { value: t?.processingMs ?? null, text: formatMsValue(t?.processingMs ?? null) }
          : { value: state, text: state },
        {
          value: t?.rtf ?? null,
          text: done ? `${formatValue(t?.rtf ?? null, '×')} real time` : '',
        },
        { value: wer, text: wer === null ? '' : `WER ${formatValue(wer, '%')}` },
      ];
    },
  },
  throughput: {
    names: ['aggregate (tok/s)', 'median first token (ms)', 'requests done'],
    cells: (run: RoundView['runs'][number] | undefined): TableCell[] => {
      const t = run?.throughput ?? null;
      const state = !run ? 'n/a' : run.state === 'queued' ? 'waiting' : run.state;
      const done = t ? t.requests.filter((r) => r.state === 'done').length : 0;
      return [
        run?.state === 'done' && t
          ? {
              value: t.aggregateTokPerSec,
              text: `${formatValue(t.aggregateTokPerSec, 'tok/s')} together`,
            }
          : { value: state, text: state },
        {
          value: t?.ttftMedianMs ?? null,
          text:
            t?.ttftMedianMs === null || !t ? '' : `first token ${formatMsValue(t.ttftMedianMs)}`,
        },
        { value: t ? done : null, text: t ? `${done} of ${t.concurrency} done` : '' },
      ];
    },
  },
  image: {
    names: ['time (ms)', 'speed (steps/s)', 'first step (ms)'],
    cells: (run: RoundView['runs'][number] | undefined): TableCell[] => {
      const done = run?.state === 'done';
      const image = done ? (run?.image ?? null) : null;
      const state = !run ? 'n/a' : run.state === 'queued' ? 'waiting' : run.state;
      return [
        done
          ? { value: image?.totalMs ?? null, text: formatMsValue(image?.totalMs ?? null) }
          : { value: state, text: state },
        {
          value: image?.stepsPerSec ?? null,
          text: done ? formatValue(image?.stepsPerSec ?? null, 'steps/s') : '',
        },
        {
          value: image?.firstStepMs ?? null,
          text:
            image?.firstStepMs === null || !image
              ? ''
              : `first step ${formatMsValue(image.firstStepMs)}`,
        },
      ];
    },
  },
} as const;

function roundRow(session: SessionView, round: RoundView, label: string, key: string): TableRow {
  const spec = ROUND_CELLS[metricKind(session)];
  const cells: TableCell[] = [];
  for (const machine of session.machines) {
    cells.push(...spec.cells(round.runs.find((r) => r.machineId === machine.id)));
  }
  const flags = round.flags.map((flag) => flag.text).join(' ');
  cells.push({ value: flags, text: flags });
  return { key, label, unit: null, hint: null, cells };
}

/** One row per round; each machine has three cells, which depend on the workload. */
export function roundTable(session: SessionView): TableModel {
  const names = ROUND_CELLS[metricKind(session)].names;
  return {
    title: 'Rounds',
    columns: [
      'Round',
      ...session.machines.flatMap((m) => names.map((name) => `${m.name} ${name}`)),
      'Flags',
    ],
    rows: [
      ...(session.warmup
        ? [roundRow(session, session.warmup, 'Warm-up, not counted', 'warmup')]
        : []),
      ...session.rounds.map((round) =>
        roundRow(session, round, `Round ${round.index + 1}`, `round-${round.index}`),
      ),
    ],
  };
}

const text = (value: string | number | null | undefined) =>
  value === null || value === undefined || value === '' ? 'n/a' : String(value);

interface SetupSpec {
  key: string;
  label: string;
  /** Differences in these rows change what the race compares. */
  matters: boolean;
  pick: (p: MachineProvenance, session: SessionView, index: number) => string;
}

const SETUP: readonly SetupSpec[] = [
  { key: 'model', label: 'Model', matters: true, pick: (p) => text(p.statusBefore?.activeModel) },
  { key: 'quant', label: 'Quant', matters: true, pick: (p) => text(p.statusBefore?.quant) },
  {
    key: 'backend',
    label: 'Backend',
    matters: true,
    pick: (p) => (p.statusBefore ? backendLabel(p.statusBefore.backend) : 'n/a'),
  },
  {
    key: 'context',
    label: 'Context',
    matters: false,
    pick: (p) =>
      p.statusBefore?.contextLength
        ? `${p.statusBefore.contextLength.toLocaleString('en-US')} tokens`
        : 'n/a',
  },
  {
    key: 'slots',
    label: 'Slots',
    matters: false,
    pick: (p) => text(p.statusBefore?.parallelSlots),
  },
  {
    key: 'speculative',
    label: 'Speculative decoding',
    matters: true,
    pick: (p) => {
      const s = p.statusBefore;
      if (!s) return 'n/a';
      if (!speculativeOn(s)) return s.specFallbackReason ? `off (${s.specFallbackReason})` : 'off';
      return [s.speculativeType, s.specDrafterKind].filter(Boolean).join(' · ');
    },
  },
  {
    key: 'kv',
    label: 'KV cache',
    matters: true,
    pick: (p) => (p.statusBefore ? (p.statusBefore.cacheTypeKv ?? 'Unsloth default') : 'n/a'),
  },
  {
    key: 'gpu-memory',
    label: 'GPU memory mode',
    matters: true,
    pick: (p) => (p.statusBefore ? (p.statusBefore.gpuMemoryMode ?? 'Unsloth default') : 'n/a'),
  },
  {
    key: 'thinking',
    label: 'Thinking',
    matters: true,
    pick: (p) => {
      const body = p.request;
      if (!body) return 'n/a';
      const effort = typeof body.reasoning_effort === 'string' ? `, ${body.reasoning_effort}` : '';
      return body.enable_thinking === false ? 'off' : `on${effort}`;
    },
  },
  {
    key: 'unsloth',
    label: 'Unsloth Studio',
    matters: false,
    pick: (p) => text(p.versions.studio ?? p.versions.unsloth),
  },
  { key: 'llama', label: 'llama.cpp', matters: false, pick: (p) => text(p.versions.llamaCpp) },
  {
    key: 'gpu',
    label: 'GPU',
    matters: false,
    pick: (p) =>
      p.gpus.length === 0
        ? text(p.platform.backend)
        : p.gpus
            .map((gpu) => (gpu.memoryGb ? `${gpu.name}, ${gpu.memoryGb} GB` : gpu.name))
            .join('; '),
  },
  { key: 'os', label: 'System', matters: false, pick: (p) => text(p.platform.os) },
  {
    key: 'ram',
    label: 'Memory',
    matters: false,
    pick: (p) => (p.platform.memoryTotalGb === null ? 'n/a' : `${p.platform.memoryTotalGb} GB`),
  },
  { key: 'notes', label: 'Notes', matters: false, pick: (_p, s, i) => text(s.machines[i]?.notes) },
  {
    key: 'address',
    label: 'Address',
    matters: false,
    pick: (_p, s, i) => text(s.machines[i]?.baseUrl),
  },
];

/** Speech-to-text setup: what was asked for, and what actually served. */
const STT_SETUP: readonly SetupSpec[] = [
  {
    key: 'stt-model',
    label: 'Model',
    matters: true,
    pick: (p, s) =>
      text(p.sttAfter?.loadedModel ?? (s.workload === 'transcribe' ? s.config.model : null)),
  },
  {
    key: 'stt-engine',
    label: 'Engine that served',
    matters: true,
    pick: (p) => text(p.sttAfter?.loadedEngine),
  },
  {
    key: 'stt-device',
    label: 'Device that served',
    matters: true,
    pick: (p) => text(p.sttAfter?.device),
  },
  {
    key: 'whisper-cpp',
    label: 'whisper.cpp (gguf engine)',
    matters: false,
    pick: (p) =>
      p.sttBefore ? (p.sttBefore.engines.gguf.available ? 'available' : 'not built') : 'n/a',
  },
  ...SETUP.filter((spec) =>
    ['unsloth', 'llama', 'gpu', 'os', 'ram', 'notes', 'address'].includes(spec.key),
  ),
];

const image = (p: MachineProvenance) => p.imageAfter;

/** Image setup: what was asked for, and the settings Unsloth resolved to. */
const IMAGE_SETUP: readonly SetupSpec[] = [
  {
    key: 'image-model',
    label: 'Model',
    matters: true,
    pick: (p, s) => text(image(p)?.repoId ?? (s.workload === 'image' ? s.config.model : null)),
  },
  {
    key: 'image-file',
    label: 'File',
    matters: true,
    pick: (p, s) =>
      text(
        image(p)?.ggufFilename?.split('/').pop() ??
          (s.workload === 'image' ? (s.config.ggufFilename ?? 'diffusers pipeline') : null),
      ),
  },
  { key: 'image-engine', label: 'Engine', matters: true, pick: (p) => text(image(p)?.engine) },
  {
    key: 'image-fallback',
    label: 'Why this engine',
    matters: false,
    pick: (p) =>
      text(image(p)?.fallbackReason ?? (image(p)?.engine === 'sd_cpp' ? 'native sd.cpp' : null)),
  },
  { key: 'image-device', label: 'Device', matters: true, pick: (p) => text(image(p)?.device) },
  { key: 'image-dtype', label: 'Precision', matters: true, pick: (p) => text(image(p)?.dtype) },
  {
    key: 'image-speed',
    label: 'Speed mode that ran',
    matters: true,
    pick: (p) => {
      const s = image(p);
      if (!s) return 'n/a';
      const optims = s.speedOptims.length > 0 ? ` (${s.speedOptims.join(', ')})` : '';
      return `${text(s.speedMode)}${optims}`;
    },
  },
  {
    key: 'image-quant',
    label: 'Transformer quantisation',
    matters: true,
    pick: (p) => (image(p) ? (image(p)?.transformerQuant ?? 'none, as stored') : 'n/a'),
  },
  {
    key: 'image-te-quant',
    label: 'Text encoder quantisation',
    matters: true,
    pick: (p) => (image(p) ? (image(p)?.textEncoderQuant ?? 'none') : 'n/a'),
  },
  {
    key: 'image-offload',
    label: 'Memory mode and offload',
    matters: true,
    pick: (p) =>
      image(p) ? `${text(image(p)?.memoryMode)}, offload ${text(image(p)?.offloadPolicy)}` : 'n/a',
  },
  {
    key: 'image-attention',
    label: 'Attention',
    matters: false,
    pick: (p) => (image(p) ? (image(p)?.attentionBackend ?? 'default') : 'n/a'),
  },
  {
    key: 'image-restore',
    label: 'Chat model afterwards',
    matters: false,
    pick: (p) => {
      const r = p.restore;
      if (!r) return p.statusBefore?.activeModel ? 'left unloaded' : 'none was loaded';
      return r.state === 'loaded'
        ? `${r.model} loaded again`
        : r.state === 'failed'
          ? `reload failed: ${r.error ?? 'unknown'}`
          : `${r.model} left unloaded`;
    },
  },
  ...SETUP.filter((spec) => ['unsloth', 'gpu', 'os', 'ram', 'notes', 'address'].includes(spec.key)),
];

/** What each machine ran, from the snapshot taken with the race. */
export function setupTable(session: SessionView): TableModel {
  const provenance = session.machines.map(
    (machine) => session.provenance.find((p) => p.machineId === machine.id) ?? null,
  );
  const specs =
    session.workload === 'transcribe'
      ? STT_SETUP
      : session.workload === 'image'
        ? IMAGE_SETUP
        : SETUP;
  return {
    title: 'Setup',
    columns: ['Setting', ...session.machines.map((m) => m.name)],
    rows: specs.map((spec) => {
      const values = provenance.map((p, i) => (p ? spec.pick(p, session, i) : 'n/a'));
      return {
        key: spec.key,
        label: spec.label,
        unit: null,
        hint: null,
        cells: values.map((value) => ({ value, text: value })),
        differs: spec.matters && session.machines.length > 1 && new Set(values).size > 1,
      };
    }),
  };
}

export interface ScoreLine {
  key: string;
  kind: 'win' | 'tie';
  text: string;
  winnerId: string | null;
}

/** Only metrics that do not depend on how much each model chose to write get a headline. */
const HEADLINES: Record<string, { noun: string; win: (winner: string, ratio: string) => string }> =
  {
    ttft: {
      noun: 'Time to first token',
      win: (w, r) => `${w} reaches its first token ${r}× sooner`,
    },
    decode: { noun: 'Decode speed', win: (w, r) => `${w} decodes ${r}× faster` },
    chars: {
      noun: 'Characters per second',
      win: (w, r) => `${w} writes ${r}× more characters per second`,
    },
    prompt: { noun: 'Prompt processing', win: (w, r) => `${w} processes the prompt ${r}× faster` },
    tokensPerJoule: {
      noun: 'Energy efficiency',
      win: (w, r) => `${w} gets ${r}× more tokens per joule`,
    },
    rtf: { noun: 'Transcription speed', win: (w, r) => `${w} transcribes ${r}× faster` },
    wer: { noun: 'Accuracy', win: (w, r) => `${w} makes ${r}× fewer word errors` },
    joulesPerMinute: {
      noun: 'Energy per audio minute',
      win: (w, r) => `${w} uses ${r}× less energy per audio minute`,
    },
    imageTime: { noun: 'Time per image', win: (w, r) => `${w} makes an image ${r}× faster` },
    aggregate: {
      noun: 'Aggregate output speed',
      win: (w, r) => `${w} delivers ${r}× more tokens per second in total`,
    },
    ttftMedian: {
      noun: 'Time to first token under load',
      win: (w, r) => `${w} reaches the first token ${r}× sooner under load`,
    },
    stepsPerSec: {
      noun: 'Denoising speed',
      win: (w, r) => `${w} runs ${r}× more denoising steps per second`,
    },
    energyPerImage: {
      noun: 'Energy per image',
      win: (w, r) => `${w} uses ${r}× less energy per image`,
    },
  };

/** Sentences for the scoreboard: a winner only where the gate names one, otherwise a tie. */
export function scoreboard(session: SessionView): ScoreLine[] {
  if (session.machines.length < 2) return [];
  const lines: ScoreLine[] = [];
  for (const row of sessionStats(session)) {
    const headline = HEADLINES[row.key];
    const { verdict } = row;
    if (
      !headline ||
      verdict.kind === 'none' ||
      verdict.leader === null ||
      verdict.runnerUp === null
    ) {
      continue;
    }
    const leader = session.machines[verdict.leader];
    const runnerUp = session.machines[verdict.runnerUp];
    const a = formatValue(row.summaries[verdict.leader]?.median ?? null, row.unit);
    const b = formatValue(row.summaries[verdict.runnerUp]?.median ?? null, row.unit);
    const against = session.machines.length > 2 ? ` for ${runnerUp?.name ?? ''}` : '';
    if (verdict.kind === 'win') {
      const ratio =
        verdict.ratio !== null && Number.isFinite(verdict.ratio) ? verdict.ratio.toFixed(2) : '∞';
      lines.push({
        key: row.key,
        kind: 'win',
        text: `${headline.win(leader?.name ?? '', ratio)}: ${a} against ${b}${against}.`,
        winnerId: leader?.id ?? null,
      });
    } else {
      lines.push({
        key: row.key,
        kind: 'tie',
        text: `${headline.noun} is a tie: ${a} against ${b}${against}, within the noise.`,
        winnerId: null,
      });
    }
  }
  return lines;
}

function csvField(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'number' ? String(Math.round(value * 1000) / 1000) : value;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Tables as CSV: each table's own header row, a blank line between tables. */
export function toCsv(tables: readonly TableModel[]): string {
  return tables
    .map((table) => {
      const header = [table.columns[0] ?? '', 'Unit', ...table.columns.slice(1)];
      const rows = table.rows.map((row) => [
        row.label,
        row.unit ?? '',
        ...row.cells.map((cell) => cell.value),
      ]);
      return [header, ...rows].map((cells) => cells.map(csvField).join(',')).join('\r\n');
    })
    .join('\r\n\r\n')
    .concat('\r\n');
}

function mdEscape(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function mdTable(table: TableModel, withDetail: boolean): string {
  const lines = [
    `| ${table.columns.map(mdEscape).join(' | ')} |`,
    `| ${table.columns.map(() => '---').join(' | ')} |`,
  ];
  for (const row of table.rows) {
    const label = row.hint ? `${row.label} (${row.hint})` : row.label;
    const cells = row.cells.map((cell) => {
      const main = cell.best ? `**${cell.text}**` : cell.text;
      return withDetail && cell.detail ? `${main}<br>${cell.detail}` : main;
    });
    lines.push(`| ${[label, ...cells].map(mdEscape).join(' | ')} |`);
  }
  return lines.join('\n');
}

/** The round table with each machine's three cells joined, as on the page. */
function mdRounds(session: SessionView): string {
  const table = roundTable(session);
  const joined: TableModel = {
    title: table.title,
    columns: ['Round', ...session.machines.map((m) => m.name), 'Flags'],
    rows: table.rows.map((row) => {
      const cells: TableCell[] = [];
      for (let i = 0; i < session.machines.length; i += 1) {
        const [first, speed, rtt] = row.cells.slice(i * 3, i * 3 + 3);
        const parts = [first?.text, speed?.text, rtt?.text].filter((part) => part);
        cells.push({ value: null, text: parts.join(' · ') });
      }
      cells.push(row.cells[row.cells.length - 1] ?? { value: '', text: '' });
      return { ...row, cells };
    }),
  };
  return mdTable(joined, false);
}

/** A summary that stands on its own: what ran, how, the results and what they mean. */
export function toMarkdown(session: SessionView): string {
  const when = new Date(session.createdAt).toISOString().replace('T', ' ').slice(0, 16);
  const names = session.machines.map((m) => m.name);
  const plan = session.plan;
  const lines: string[] = [
    `# Model Duel: ${names.join(' against ')}`,
    '',
    `Race of ${when} UTC, ${session.rounds.length} ${session.rounds.length === 1 ? 'round' : 'rounds'}, state ${session.state}.`,
    '',
  ];
  const scores = scoreboard(session);
  if (scores.length > 0) {
    lines.push('## Scoreboard', '', ...scores.map((line) => `- ${line.text}`), '');
  }
  lines.push(
    `## ${comparisonTable(session).title}`,
    '',
    mdTable(comparisonTable(session), true),
    '',
  );
  lines.push('## Rounds', '', mdRounds(session), '');
  lines.push('## Setup', '', mdTable(setupTable(session), false), '');
  if (session.workload === 'text') {
    const cfg = session.config;
    const preset = PRESETS.find((p) => p.id === cfg.preset)?.label ?? cfg.preset;
    const sampling = cfg.sampling;
    lines.push(
      '## Settings',
      '',
      `- Prompt: ${preset}, ${cfg.prompt.split(/\s+/).filter(Boolean).length.toLocaleString('en-US')} words, starting "${mdEscape(cfg.prompt.slice(0, 160))}${cfg.prompt.length > 160 ? '…' : ''}"`,
      `- Max tokens ${cfg.maxTokens}, thinking ${cfg.thinking ? 'on' : 'off'}${cfg.reasoningEffort ? `, effort ${cfg.reasoningEffort}` : ''}`,
      `- ${cfg.prefill === 'cold' ? 'Cold' : 'Warm'} prefill: ${cfg.prefill === 'cold' ? "a fresh line started each round's prompt and the seed was sent, so no cached prompt helped" : 'the same prompt every round without a seed, so later rounds could reuse the cache'}`,
      `- Sampling: temperature ${sampling.temperature}, top-p ${sampling.topP}, top-k ${sampling.topK}, min-p ${sampling.minP}, repetition penalty ${sampling.repetitionPenalty}${cfg.prefill === 'cold' ? `, seed ${sampling.seed}` : ''}`,
    );
    if (cfg.mode === 'throughput') {
      lines.push(
        `- Throughput: ${cfg.concurrency} identical requests sent at once to each machine every round. The aggregate speed is every finished request's output tokens over the time from the first sent to the last done, so it includes each request's prompt processing and any wait for a slot.`,
      );
    }
  } else if (session.workload === 'image') {
    const cfg = session.config;
    const prompt = imagePrompt(cfg);
    lines.push(
      '## Settings',
      '',
      `- Prompt: "${mdEscape(prompt)}"${cfg.negativePrompt ? `, negative "${mdEscape(cfg.negativePrompt)}"` : ''}`,
      `- Model ${cfg.model}${cfg.ggufFilename ? `, file ${cfg.ggufFilename}` : ', diffusers pipeline'}`,
      `- ${cfg.width}×${cfg.height}, ${cfg.steps} steps, guidance ${cfg.guidance}, seed ${cfg.seed}, one image per run`,
      `- Memory mode ${cfg.memoryMode}, speed mode ${cfg.speedMode} asked for${cfg.speedMode === 'off' ? ', the bit-identical baseline' : ''}`,
      '- Step times come from polling Unsloth ten times a second, so they are good to about 100 ms. The decode time runs from the last step to the answer and includes saving the image.',
      '- The same seed gives different pixels on Apple Silicon and on CUDA, so the images are a sanity check, not a comparison.',
    );
  } else {
    const cfg = session.config;
    lines.push(
      '## Settings',
      '',
      `- Audio: ${audioLabel(cfg)}`,
      `- Model ${cfg.model}, engine ${cfg.engine} asked for, device ${cfg.device}, language ${cfg.language}`,
      '- Processing time runs from the last byte of the file sent to the first byte of the answer; Unsloth measures its own from the end of the upload.',
      '- Real-time factor is audio seconds per processing second: 20× transcribes a minute in three seconds.',
      '- Word error rate compares lower-cased words with punctuation removed and numbers spelled out.',
    );
    if (cfg.audio.kind !== 'upload') lines.push(`- Audio source: ${LIBRISPEECH_CLIP.attribution}`);
  }
  lines.push(
    `- Plan: ${plan.rounds} ${plan.rounds === 1 ? 'round' : 'rounds'}, warm-up ${plan.warmup ? 'on' : 'off'}, ${plan.settleMs / 1000} s between rounds, machines ${plan.sequencing === 'concurrent' ? 'together' : 'taking turns in ABBA order'}`,
    `- Telemetry: ${session.telemetry.enabled ? 'on, read twice a second' : 'off'}`,
    '',
    '## How to read this',
    '',
    '- Times are measured by Model Duel from the moment a request left it, so they include the network. "Unsloth" rows are what Unsloth measured on the machine itself.',
    `- A machine wins a row only when its median is more than ${Math.round((GATE_RATIO - 1) * 100)} percent better than the runner-up's, or its round-to-round range does not overlap the runner-up's. Otherwise the row is a tie. Failed rounds and the warm-up never count.`,
    metricKind(session) === 'throughput'
      ? '- Ratio headlines cover aggregate output speed, time to first token under load and tokens per joule, for the same number of requests at once on every machine.'
      : session.workload === 'image'
        ? '- Ratio headlines cover time per image, denoising speed and energy per image, all for the same prompt, size, steps and seed.'
        : session.workload === 'transcribe'
          ? '- Ratio headlines cover real-time factor, word error rate and energy per audio minute, which do not depend on how long the audio is.'
          : '- Ratio headlines cover only time to first token, speeds, prompt processing and tokens per joule, which do not depend on how much each model chose to write.',
    '- Energy is approximate: GPU board power on NVIDIA and the GPU rail on Apple, read twice a second and added up over the run.',
    '',
    'Made with Model Duel.',
    '',
  );
  return lines.join('\n');
}
