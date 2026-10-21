import { z } from 'zod';
import {
  concurrencySchema,
  DEFAULT_SAMPLING,
  maxTokensSchema,
  PREFILL_MODES,
  REASONING_EFFORTS,
  TEXT_MODES,
  type ReasoningEffort,
} from './chat';
import { SERVER_METRICS, type MetricUnit } from './compare';
import { csvCell } from './csv';
import { formatValue } from './format';
import type { PreflightIssue } from './preflight';
import type { PresetId } from './presets';
import { headlineMetrics, headlineRows } from './report';
import { deviceRuns, type DeviceRunState } from './runs';
import { presetLabel } from './share';
import { machineIdsSchema, runPlanSchema, type SessionRequest, type SessionView } from './session';
import { centre, sessionStats } from './stats';

/**
 * A suite queues a text race for every combination of prompts, thinking settings and Max tokens
 * values, on the same machines with the same run plan, mode and prefill. The server runs them one
 * after another, each through the same pre-flight and race as the Text tab, and keeps each race's
 * headline numbers. `data/suites/<id>.json` holds one suite; its races are ordinary sessions.
 */
export const SUITE_SCHEMA_VERSION = 1;
/** The most races one suite may queue. */
export const MAX_SUITE_RACES = 50;

/** The prompts a suite races: the standard presets, never a custom prompt. */
export const SUITE_PRESET_IDS = [
  'short',
  'long-8k',
  'long-32k',
  'puzzle',
  'code',
  'fixed-length',
] as const satisfies readonly PresetId[];
export type SuitePresetId = (typeof SUITE_PRESET_IDS)[number];

/** One thinking setting: off, on at the model's default effort, or on at an effort level. */
export const suiteThinkingSchema = z
  .object({
    thinking: z.boolean(),
    reasoningEffort: z.enum(REASONING_EFFORTS).nullable().default(null),
  })
  .refine((t) => t.thinking || t.reasoningEffort === null, {
    message: 'An effort level needs thinking on.',
  });
export type SuiteThinking = z.infer<typeof suiteThinkingSchema>;

/** The same for the same setting, so a suite cannot ask for one twice. */
export function thinkingKey(t: { thinking: boolean; reasoningEffort: string | null }): string {
  return t.thinking ? `on:${t.reasoningEffort ?? ''}` : 'off';
}

const distinct = (items: ReadonlyArray<string | number>) => new Set(items).size === items.length;

/** How many races a suite queues: one per combination. */
export function suiteSize(axes: {
  presets: readonly unknown[];
  thinking: readonly unknown[];
  maxTokens: readonly unknown[];
}): number {
  return axes.presets.length * axes.thinking.length * axes.maxTokens.length;
}

export const suiteRequestSchema = z
  .object({
    machineIds: machineIdsSchema,
    presets: z
      .array(z.enum(SUITE_PRESET_IDS))
      .min(1, 'Pick at least one prompt.')
      .refine(distinct, 'Pick each prompt only once.'),
    thinking: z
      .array(suiteThinkingSchema)
      .min(1, 'Pick at least one thinking setting.')
      .refine(
        (settings) => distinct(settings.map(thinkingKey)),
        'Pick each thinking setting only once.',
      ),
    maxTokens: z
      .array(maxTokensSchema)
      .min(1, 'Give at least one Max tokens value.')
      .max(MAX_SUITE_RACES, `Give at most ${MAX_SUITE_RACES} Max tokens values.`)
      .refine(distinct, 'Give each Max tokens value only once.'),
    /** Fixed for every race of the suite. */
    plan: runPlanSchema.prefault({}),
    mode: z.enum(TEXT_MODES).default('latency'),
    concurrency: concurrencySchema,
    prefill: z.enum(PREFILL_MODES).default('cold'),
    /** Race even when pre-flight warns; without it, a race pre-flight warns about is skipped. */
    acknowledgeWarnings: z.boolean().default(false),
  })
  .superRefine((request, ctx) => {
    const size = suiteSize(request);
    if (size > MAX_SUITE_RACES) {
      ctx.addIssue({
        code: 'custom',
        message: `That makes ${size} races, and a suite runs at most ${MAX_SUITE_RACES}. Pick fewer prompts, thinking settings or Max tokens values.`,
      });
    }
  });
export type SuiteRequest = z.infer<typeof suiteRequestSchema>;
/** What every race of a suite shares, and the axes it was expanded from. */
export type SuiteSettings = Omit<SuiteRequest, 'machineIds'>;

/** One race of a suite: the prompt, thinking and Max tokens it was asked for. */
export interface SuiteCombo {
  preset: SuitePresetId;
  thinking: boolean;
  reasoningEffort: ReasoningEffort | null;
  maxTokens: number;
}

/** Every combination, prompt by prompt, then by thinking setting, then by Max tokens. */
export function expandSuite(
  axes: Pick<SuiteSettings, 'presets' | 'thinking' | 'maxTokens'>,
): SuiteCombo[] {
  const combos: SuiteCombo[] = [];
  for (const preset of axes.presets) {
    for (const t of axes.thinking) {
      for (const maxTokens of axes.maxTokens) {
        combos.push({
          preset,
          thinking: t.thinking,
          reasoningEffort: t.thinking ? t.reasoningEffort : null,
          maxTokens,
        });
      }
    }
  }
  return combos;
}

/**
 * The race request for one combination: the suite's machines, plan, mode and prefill, default
 * sampling, and the combination's prompt, thinking and Max tokens. The server fills in the
 * preset's prompt, as it does for the Text tab.
 */
export function comboRequest(
  suite: { machines: ReadonlyArray<{ id: string }>; settings: SuiteSettings },
  combo: SuiteCombo,
): SessionRequest {
  const s = suite.settings;
  return {
    workload: 'text',
    machineIds: suite.machines.map((m) => m.id),
    config: {
      preset: combo.preset,
      prompt: '',
      maxTokens: combo.maxTokens,
      thinking: combo.thinking,
      reasoningEffort: combo.reasoningEffort,
      prefill: s.prefill,
      sampling: { ...DEFAULT_SAMPLING },
      mode: s.mode,
      concurrency: s.concurrency,
    },
    plan: { ...s.plan },
    acknowledgeWarnings: s.acknowledgeWarnings,
  };
}

const promptLabel = (id: string): string => presetLabel(id) ?? id;

/** "Off", "On", or "On, low". */
export function thinkingLabel(t: { thinking: boolean; reasoningEffort: string | null }): string {
  if (!t.thinking) return 'Off';
  return t.reasoningEffort ? `On, ${t.reasoningEffort}` : 'On';
}

/** "Short · thinking on, low · 1,024 tokens". */
export function comboLabel(combo: SuiteCombo): string {
  return `${promptLabel(combo.preset)} · thinking ${thinkingLabel(combo).toLowerCase()} · ${combo.maxTokens.toLocaleString('en-US')} tokens`;
}

/** The axes of a suite in a line, for the list of suites. */
export function suiteLabel(settings: SuiteSettings): string {
  const presets = settings.presets.map(promptLabel).join(', ');
  const thinking = settings.thinking.map((t) => thinkingLabel(t).toLowerCase()).join('; ');
  const tokens = settings.maxTokens.map((n) => n.toLocaleString('en-US')).join(', ');
  const mode =
    settings.mode === 'throughput' ? ` · throughput, ${settings.concurrency} at once` : '';
  return `${presets} · thinking ${thinking} · ${tokens} tokens${mode}`;
}

export type SuiteState = 'running' | 'done' | 'cancelled' | 'failed' | 'interrupted';

/**
 * `skipped`: the race never started, because pre-flight refused it, warned without the suite
 * accepting warnings, or a machine was gone. `failed`: it ran and every machine failed.
 */
export type SuiteRaceState =
  'queued' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled' | 'interrupted';

export const SUITE_RACE_STATES: readonly SuiteRaceState[] = [
  'queued',
  'running',
  'done',
  'failed',
  'skipped',
  'cancelled',
  'interrupted',
];

/** One headline number of one machine in one race. */
export interface SuiteHeadline {
  /** The metric the number is: `ttftServer` where every machine's server reported it, else `ttft`. */
  key: string;
  /** The race's median or average, as its plan sums rounds up. */
  value: number | null;
  /**
   * `server` when the machines' servers reported it, `measured` when Model Duel's measurement stood
   * in for every machine; null for a metric that has only one kind.
   */
  source: 'server' | 'measured' | null;
}

/** What one machine did in one race of a suite, kept when the race ends. */
export interface SuiteMachineResult {
  machineId: string;
  name: string;
  color: string;
  state: DeviceRunState;
  rounds: number;
  roundsDone: number;
  error: string | null;
  /** By headline metric: `ttft`, `decode`, `prompt`, `tokensPerJoule`, or throughput's own. */
  headlines: Record<string, SuiteHeadline>;
}

export interface SuiteRace {
  index: number;
  combo: SuiteCombo;
  state: SuiteRaceState;
  /** The race's session, once it started. */
  sessionId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Why it was skipped, failed or stopped. */
  error: string | null;
  /** What pre-flight found when it refused the race. */
  issues: PreflightIssue[];
  /** One per machine, once the race has ended. */
  results: SuiteMachineResult[];
}

export interface Suite {
  schemaVersion: number;
  id: string;
  createdAt: string;
  finishedAt: string | null;
  state: SuiteState;
  error: string | null;
  /** The machines as they were when the suite started. */
  machines: Array<{ id: string; name: string; color: string }>;
  settings: SuiteSettings;
  races: SuiteRace[];
}

export interface SuiteSummary {
  id: string;
  createdAt: string;
  finishedAt: string | null;
  state: SuiteState;
  label: string;
  machines: Array<{ id: string; name: string; color: string }>;
  races: number;
  /** Races in each state. */
  counts: Record<SuiteRaceState, number>;
}

export function summarizeSuite(suite: Suite): SuiteSummary {
  const counts = Object.fromEntries(SUITE_RACE_STATES.map((state) => [state, 0])) as Record<
    SuiteRaceState,
    number
  >;
  for (const race of suite.races) counts[race.state] += 1;
  return {
    id: suite.id,
    createdAt: suite.createdAt,
    finishedAt: suite.finishedAt,
    state: suite.state,
    label: suiteLabel(suite.settings),
    machines: suite.machines.map((m) => ({ ...m })),
    races: suite.races.length,
    counts,
  };
}

/**
 * Each machine's headline numbers in a finished race, by the scoreboard's rule (`headlineRows`):
 * the machines' servers' own numbers where every machine in the race reported them, otherwise
 * Model Duel's measurement for all of them.
 */
export function suiteResults(session: SessionView): SuiteMachineResult[] {
  const rows = headlineRows(sessionStats(session));
  const runs = deviceRuns(session);
  return session.machines.map((machine, i) => {
    const run = runs[i];
    const headlines: Record<string, SuiteHeadline> = {};
    for (const { row, headline } of rows) {
      headlines[headline] = {
        key: row.key,
        value: centre(row.summaries[i], row.statistic),
        source: SERVER_METRICS[headline] ? (row.key === headline ? 'measured' : 'server') : null,
      };
    }
    return {
      machineId: machine.id,
      name: machine.name,
      color: machine.color,
      state: run?.state ?? 'failed',
      rounds: run?.rounds ?? 0,
      roundsDone: run?.roundsDone ?? 0,
      error: run?.error ?? null,
      headlines,
    };
  });
}

/** A row of the summary: one machine in one race. */
export interface SuiteRow {
  key: string;
  race: SuiteRace;
  machine: { id: string; name: string; color: string };
  /** Null until the race has ended, and for a race that never started. */
  result: SuiteMachineResult | null;
}

/** One row per race and machine, in the order the races run. */
export function suiteRows(suite: Suite): SuiteRow[] {
  return suite.races.flatMap((race) =>
    suite.machines.map((machine) => ({
      key: `${race.index}/${machine.id}`,
      race,
      machine,
      result: race.results.find((r) => r.machineId === machine.id) ?? null,
    })),
  );
}

const STATE_TEXT: Record<DeviceRunState | SuiteRaceState, string> = {
  queued: 'waiting',
  running: 'running',
  done: 'done',
  partial: 'partly failed',
  failed: 'failed',
  skipped: 'skipped',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
};

/** The machine's state in the race, or the race's own when it never ran. */
export function suiteRowState(row: SuiteRow): string {
  return STATE_TEXT[row.result?.state ?? row.race.state];
}

/** A column of the summary: the raw value to export and the text to show. */
export interface SuiteColumn {
  id: string;
  label: string;
  numeric: boolean;
  unit?: MetricUnit;
  value: (row: SuiteRow) => number | string | null;
  text: (row: SuiteRow) => string;
  /** Whose number it is, for a metric the machines' servers also report: "server" or "Model Duel". */
  source?: (row: SuiteRow) => string | null;
}

const SOURCE_TEXT = { server: 'server', measured: 'Model Duel' } as const;

/** The summary's columns: the combination, the machine, its state and the headline numbers. */
export function suiteColumns(suite: Suite): SuiteColumn[] {
  const kind = suite.settings.mode === 'throughput' ? 'throughput' : 'text';
  const columns: SuiteColumn[] = [
    {
      id: 'prompt',
      label: 'Prompt',
      numeric: false,
      value: (row) => promptLabel(row.race.combo.preset),
      text: (row) => promptLabel(row.race.combo.preset),
    },
    {
      id: 'thinking',
      label: 'Thinking',
      numeric: false,
      value: (row) => thinkingLabel(row.race.combo),
      text: (row) => thinkingLabel(row.race.combo),
    },
    {
      id: 'maxTokens',
      label: 'Max tokens',
      numeric: true,
      value: (row) => row.race.combo.maxTokens,
      text: (row) => row.race.combo.maxTokens.toLocaleString('en-US'),
    },
    {
      id: 'machine',
      label: 'Machine',
      numeric: false,
      value: (row) => row.machine.name,
      text: (row) => row.machine.name,
    },
    {
      id: 'state',
      label: 'State',
      numeric: false,
      value: suiteRowState,
      text: suiteRowState,
    },
    {
      id: 'rounds',
      label: 'Rounds done',
      numeric: true,
      value: (row) => row.result?.roundsDone ?? null,
      text: (row) => (row.result ? `${row.result.roundsDone} of ${row.result.rounds}` : '—'),
    },
  ];
  for (const spec of headlineMetrics(kind)) {
    const pick = (row: SuiteRow) => row.result?.headlines[spec.key] ?? null;
    columns.push({
      id: `metric:${spec.key}`,
      label: spec.label,
      numeric: true,
      unit: spec.unit,
      value: (row) => pick(row)?.value ?? null,
      text: (row) => {
        const found = pick(row);
        return found ? formatValue(found.value, spec.unit) : '—';
      },
      ...(SERVER_METRICS[spec.key]
        ? {
            source: (row: SuiteRow) => {
              const found = pick(row);
              return found?.source && found.value !== null ? SOURCE_TEXT[found.source] : null;
            },
          }
        : {}),
    });
  }
  columns.push({
    id: 'race',
    label: 'Race',
    numeric: false,
    value: (row) => row.race.sessionId,
    text: (row) => (row.race.sessionId ? 'Open' : '—'),
  });
  return columns;
}

/**
 * The summary as CSV, with raw numbers and units in the headers, and after each metric that has a
 * server and a measured kind, whose number it is.
 */
export function suiteCsv(suite: Suite): string {
  const columns = suiteColumns(suite);
  const header: string[] = [];
  for (const column of columns) {
    header.push(
      column.unit && column.unit !== 'text' ? `${column.label} (${column.unit})` : column.label,
    );
    if (column.source) header.push(`${column.label}, from`);
  }
  const body = suiteRows(suite).map((row) => {
    const cells: Array<string | number | null> = [];
    for (const column of columns) {
      cells.push(column.value(row));
      if (column.source) cells.push(column.source(row));
    }
    return cells.map(csvCell).join(',');
  });
  return `${[header.map(csvCell).join(','), ...body].join('\n')}\n`;
}
