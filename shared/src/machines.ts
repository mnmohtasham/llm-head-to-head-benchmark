import type { PreflightIssue } from './preflight';
import { z } from 'zod';
import type { ProbeReport } from './probe';

/** Accent colours for machines, in the order new machines receive them. */
export const MACHINE_COLORS = [
  '#e8a33d',
  '#c6dbe0',
  '#86c98f',
  '#b49cf0',
  '#ef8fb0',
  '#e3d160',
] as const;

export const MACHINE_COLOR_NAMES: Record<(typeof MACHINE_COLORS)[number], string> = {
  '#e8a33d': 'Amber',
  '#c6dbe0': 'Ice',
  '#86c98f': 'Green',
  '#b49cf0': 'Violet',
  '#ef8fb0': 'Pink',
  '#e3d160': 'Yellow',
};

const name = z
  .string()
  .trim()
  .min(1, 'Give the machine a name.')
  .max(60, 'Keep the name under 60 characters.');
const baseUrl = z
  .string()
  .trim()
  .min(1, 'Enter the machine address.')
  .max(300, 'That address is too long.');
const notes = z.string().trim().max(500, 'Keep the notes under 500 characters.');
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Pick one of the colours.');
const apiKey = z.string().trim().max(500, 'That key is too long.');

export const machineCreateSchema = z.object({
  name,
  baseUrl,
  apiKey: apiKey.optional(),
  notes: notes.optional(),
  color: color.optional(),
});
export type MachineCreateInput = z.infer<typeof machineCreateSchema>;

export const machineUpdateSchema = z.object({
  name,
  baseUrl,
  /** Leave it out or send "" to keep the saved key. Send null to remove it. */
  apiKey: apiKey.nullable().optional(),
  notes: notes.optional(),
  color: color.optional(),
});
export type MachineUpdateInput = z.infer<typeof machineUpdateSchema>;

export interface ProbeSummary {
  probedAt: string;
  durationMs: number;
  report: ProbeReport;
}

/** A machine as the API returns it. The key itself never leaves the controller. */
export interface MachineView {
  id: string;
  name: string;
  baseUrl: string;
  notes: string;
  color: string;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  createdAt: string;
  updatedAt: string;
  lastProbe: ProbeSummary | null;
}

export interface ApiErrorBody {
  error: string;
  message: string;
  fields?: Record<string, string>;
  /** Pre-flight findings, when pre-flight refused a race. */
  issues?: PreflightIssue[];
}
