import type {
  ApiErrorBody,
  LoadJob,
  LoadRequest,
  LoadStartResult,
  MachineCreateInput,
  MachineModelsView,
  MachineStatusView,
  MachineUpdateInput,
  MachineView,
  PairTally,
  PreflightIssue,
  PreflightResult,
  ProbeSummary,
  SessionRequest,
  SessionSummary,
  SessionView,
  TextConfig,
  Vote,
} from '@duel/shared';

export interface PresetView {
  id: string;
  label: string;
  description: string;
  words: number;
  preview: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly fields: Record<string, string> = {},
    /** Pre-flight findings, when pre-flight refused a race. */
    readonly issues: PreflightIssue[] | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const STALE_SERVER_MESSAGE =
  'The running Model Duel server does not know this request, so it is probably older than this page. Stop the server and start it again with npm start.';

/** A 404 for a route the server lacks, as opposed to a machine or run it does not have. */
function isMissingRoute(status: number, error: Partial<ApiErrorBody>): boolean {
  if (status !== 404) return false;
  // Servers before phase 3 answered every unknown route with this exact body.
  return (
    error.error === 'no_route' || (error.error === 'not_found' && error.message === 'Not found.')
  );
}

export interface HealthInfo {
  ok: boolean;
  version: string;
  /** Missing on servers older than phase 3. */
  mode?: 'dev' | 'production';
  /** The id of the page build the server found when it started; missing on older servers. */
  build?: string | null;
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? null : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('The Model Duel server is not answering. Is it still running?', 0);
  }
  if (response.status === 204) return undefined as T;
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (data ?? {}) as Partial<ApiErrorBody>;
    if (isMissingRoute(response.status, error)) throw new ApiError(STALE_SERVER_MESSAGE, 404);
    throw new ApiError(
      error.message ?? `The request failed with HTTP ${response.status}.`,
      response.status,
      error.fields ?? {},
      error.issues ?? null,
    );
  }
  return data as T;
}

const machineUrl = (id: string) => `/api/machines/${encodeURIComponent(id)}`;
const sessionUrl = (id: string) => `/api/sessions/${encodeURIComponent(id)}`;

export const api = {
  listMachines: () => call<MachineView[]>('GET', '/api/machines'),
  createMachine: (input: MachineCreateInput) => call<MachineView>('POST', '/api/machines', input),
  updateMachine: (id: string, input: MachineUpdateInput) =>
    call<MachineView>('PUT', machineUrl(id), input),
  deleteMachine: (id: string) => call<void>('DELETE', machineUrl(id)),
  probeMachine: (id: string) => call<ProbeSummary>('POST', `${machineUrl(id)}/probe`),
  exportUrl: (id: string) => `${machineUrl(id)}/probe/export`,

  listModels: (id: string, refresh = false) =>
    call<MachineModelsView>('GET', `${machineUrl(id)}/models${refresh ? '?refresh=1' : ''}`),
  machineStatus: (id: string) => call<MachineStatusView>('GET', `${machineUrl(id)}/status`),
  machineHosts: () => call<{ hosts: Record<string, string> }>('GET', '/api/machines/hosts'),
  settings: () => call<{ telemetry: boolean }>('GET', '/api/settings'),
  setTelemetry: (on: boolean) =>
    call<{ telemetry: boolean }>('PUT', '/api/settings', { telemetry: on }),
  telemetryStreamUrl: (ids: readonly string[]) =>
    `/api/telemetry/stream?machines=${ids.map(encodeURIComponent).join(',')}`,
  listLoads: () => call<{ jobs: LoadJob[]; serverTime: string }>('GET', '/api/loads'),
  startLoad: (request: LoadRequest) =>
    call<{ results: LoadStartResult[] }>('POST', '/api/models/load', request),
  cancelLoad: (id: string) => call<{ job: LoadJob }>('POST', `${machineUrl(id)}/load/cancel`),
  unload: (id: string) => call<MachineStatusView>('POST', `${machineUrl(id)}/unload`),

  health: () => call<HealthInfo>('GET', '/api/health'),
  startSession: (request: SessionRequest) => call<SessionView>('POST', '/api/sessions', request),
  presets: () => call<{ presets: PresetView[] }>('GET', '/api/presets'),
  preflight: (machineIds: string[], config: TextConfig) =>
    call<PreflightResult>('POST', '/api/preflight', { machineIds, config }),
  listSessions: () => call<{ sessions: SessionSummary[] }>('GET', '/api/sessions'),
  getSession: (id: string) => call<SessionView>('GET', sessionUrl(id)),
  cancelSession: (id: string) => call<SessionView>('POST', `${sessionUrl(id)}/cancel`),
  deleteSession: (id: string) => call<void>('DELETE', sessionUrl(id)),
  vote: (
    id: string,
    vote: { round: number; left: string; right: string; choice: Vote['choice'] },
  ) => call<SessionView>('POST', `${sessionUrl(id)}/vote`, vote),
  voteTally: () => call<{ tally: PairTally[] }>('GET', '/api/votes/tally'),
  sessionStreamUrl: (id: string) => `${sessionUrl(id)}/stream`,
};

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
