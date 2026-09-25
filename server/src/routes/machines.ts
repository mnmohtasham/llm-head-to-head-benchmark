import {
  classifyProbe,
  DEFAULT_AGENT_PORT,
  machineCreateSchema,
  machineUpdateSchema,
  maskApiKey,
  normalizeBaseUrl,
  PROBE_EXPORT_KIND,
  PROBE_SCHEMA_VERSION,
  type ApiErrorBody,
  type MachineView,
  type ProbeExport,
  type ProbeSummary,
} from '@duel/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { runProbe, sanitizeProbe, type ProbeTimeouts } from '../probe';
import type { MachineStore, StoredMachine, StoredProbe } from '../store';
import { agentHealth } from '../agent';
import { hostKeys } from '../hosts';

interface IdParams {
  Params: { id: string };
}

function send(reply: FastifyReply, status: number, body: ApiErrorBody) {
  return reply.code(status).send(body);
}

function notFound(reply: FastifyReply) {
  return send(reply, 404, { error: 'not_found', message: 'There is no machine with that id.' });
}

function validationError(
  reply: FastifyReply,
  issues: ReadonlyArray<{ path: readonly PropertyKey[]; message: string }>,
) {
  const fields: Record<string, string> = {};
  for (const issue of issues) {
    const field = String(issue.path[0] ?? 'form');
    fields[field] ??= issue.message;
  }
  return send(reply, 400, { error: 'validation', message: 'Some fields need attention.', fields });
}

/** An agent address as typed, with the agent's port by default; "" means none. */
function agentAddress(
  input: string | undefined,
): string | null | { path: string[]; message: string } {
  if (!input?.trim()) return null;
  const url = normalizeBaseUrl(input, DEFAULT_AGENT_PORT);
  return url.ok ? url.url : { path: ['agentUrl'], message: url.error };
}

function slug(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned || 'machine';
}

function fileStamp(iso: string): string {
  return iso.replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
}

export function toView(machine: StoredMachine, probe: StoredProbe | undefined): MachineView {
  return {
    id: machine.id,
    name: machine.name,
    baseUrl: machine.baseUrl,
    notes: machine.notes,
    color: machine.color,
    hasApiKey: machine.apiKey !== null,
    apiKeyMasked: maskApiKey(machine.apiKey),
    agentUrl: machine.agentUrl,
    hasAgentToken: machine.agentToken !== null,
    agentTokenMasked: maskApiKey(machine.agentToken),
    createdAt: machine.createdAt,
    updatedAt: machine.updatedAt,
    lastProbe: probe
      ? {
          probedAt: probe.probedAt,
          durationMs: probe.durationMs,
          report: probe.report,
          agent: probe.agent ?? null,
        }
      : null,
  };
}

export function registerMachineRoutes(
  app: FastifyInstance,
  store: MachineStore,
  options: {
    probeTimeouts: ProbeTimeouts;
    version: string;
    /** Called after an edit or delete, so cached model lists are not reused. */
    onMachineChanged?: (id: string) => void;
  },
): void {
  const view = (machine: StoredMachine) => toView(machine, store.lastProbe(machine.id));

  app.get('/api/machines', async () => store.list().map(view));

  /** Which machines are the same computer, so a race can suggest that they take turns. */
  app.get('/api/machines/hosts', async () => ({ hosts: await hostKeys(store.list()) }));

  app.get<IdParams>('/api/machines/:id', async (request, reply) => {
    const machine = store.get(request.params.id);
    return machine ? view(machine) : notFound(reply);
  });

  app.post('/api/machines', async (request, reply) => {
    const parsed = machineCreateSchema.safeParse(request.body);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    const url = normalizeBaseUrl(parsed.data.baseUrl);
    if (!url.ok) return validationError(reply, [{ path: ['baseUrl'], message: url.error }]);
    const agent = agentAddress(parsed.data.agentUrl);
    if (agent !== null && typeof agent === 'object') return validationError(reply, [agent]);
    const machine = await store.create({
      name: parsed.data.name,
      baseUrl: url.url,
      notes: parsed.data.notes ?? '',
      color: parsed.data.color?.toLowerCase(),
      apiKey: parsed.data.apiKey ? parsed.data.apiKey : null,
      agentUrl: agent ?? null,
      agentToken: parsed.data.agentToken ? parsed.data.agentToken : null,
    });
    request.log.info({ machineId: machine.id }, 'machine added');
    return reply.code(201).send(view(machine));
  });

  app.put<IdParams>('/api/machines/:id', async (request, reply) => {
    const parsed = machineUpdateSchema.safeParse(request.body);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    const url = normalizeBaseUrl(parsed.data.baseUrl);
    if (!url.ok) return validationError(reply, [{ path: ['baseUrl'], message: url.error }]);
    const { apiKey, agentToken } = parsed.data;
    const agent =
      parsed.data.agentUrl === undefined ? undefined : agentAddress(parsed.data.agentUrl ?? '');
    if (agent !== null && typeof agent === 'object') return validationError(reply, [agent]);
    const result = await store.update(request.params.id, {
      name: parsed.data.name,
      baseUrl: url.url,
      notes: parsed.data.notes,
      color: parsed.data.color?.toLowerCase(),
      apiKey: apiKey === null ? null : apiKey ? apiKey : undefined,
      agentUrl: agent,
      agentToken: agentToken === null ? null : agentToken ? agentToken : undefined,
    });
    if (!result) return notFound(reply);
    options.onMachineChanged?.(result.machine.id);
    request.log.info(
      { machineId: result.machine.id, probeStale: result.probeStale },
      'machine updated',
    );
    return view(result.machine);
  });

  app.delete<IdParams>('/api/machines/:id', async (request, reply) => {
    if (!(await store.remove(request.params.id))) return notFound(reply);
    options.onMachineChanged?.(request.params.id);
    request.log.info({ machineId: request.params.id }, 'machine deleted');
    return reply.code(204).send();
  });

  app.post<IdParams>('/api/machines/:id/probe', async (request, reply) => {
    const machine = store.get(request.params.id);
    if (!machine) return notFound(reply);
    const raw = sanitizeProbe(
      await runProbe(machine.baseUrl, machine.apiKey, options.probeTimeouts),
      machine.apiKey,
    );
    const report = classifyProbe(raw);
    const agent = machine.agentUrl ? await agentHealth(machine) : null;
    const probe: StoredProbe = {
      schemaVersion: PROBE_SCHEMA_VERSION,
      machineId: machine.id,
      probedAt: raw.finishedAt,
      durationMs: raw.durationMs,
      raw,
      report,
      agent,
    };
    // Keep the result only if the address and key it was taken with are still the saved ones.
    const current = store.get(machine.id);
    if (current && current.baseUrl === machine.baseUrl && current.apiKey === machine.apiKey) {
      await store.saveProbe(probe);
    }
    request.log.info(
      { machineId: machine.id, overall: report.overall, durationMs: raw.durationMs },
      'machine probed',
    );
    const summary: ProbeSummary = {
      probedAt: probe.probedAt,
      durationMs: probe.durationMs,
      report,
      agent,
    };
    return summary;
  });

  /** The agent's health now: its ffmpeg, encoders, clips and extra telemetry. */
  app.get<IdParams>('/api/machines/:id/agent', async (request, reply) => {
    const machine = store.get(request.params.id);
    if (!machine) return notFound(reply);
    return { machineId: machine.id, ...(await agentHealth(machine)) };
  });

  app.get<IdParams>('/api/machines/:id/probe', async (request, reply) => {
    const machine = store.get(request.params.id);
    if (!machine) return notFound(reply);
    const probe = store.lastProbe(machine.id);
    if (!probe) {
      return send(reply, 404, {
        error: 'no_probe',
        message: 'This machine has not been probed yet.',
      });
    }
    const summary: ProbeSummary = {
      probedAt: probe.probedAt,
      durationMs: probe.durationMs,
      report: probe.report,
    };
    return summary;
  });

  app.get<IdParams>('/api/machines/:id/probe/export', async (request, reply) => {
    const machine = store.get(request.params.id);
    if (!machine) return notFound(reply);
    const probe = store.lastProbe(machine.id);
    if (!probe) {
      return send(reply, 404, {
        error: 'no_probe',
        message: 'Probe the machine before exporting.',
      });
    }
    const file: ProbeExport = {
      kind: PROBE_EXPORT_KIND,
      schemaVersion: PROBE_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      app: { name: 'model-duel', version: options.version },
      machine: {
        name: machine.name,
        baseUrl: machine.baseUrl,
        notes: machine.notes,
        keyConfigured: machine.apiKey !== null,
      },
      probedAt: probe.probedAt,
      durationMs: probe.durationMs,
      raw: probe.raw,
      report: probe.report,
    };
    const filename = `probe-${slug(machine.name)}-${fileStamp(probe.probedAt)}.json`;
    return reply
      .header('content-disposition', `attachment; filename="${filename}"`)
      .type('application/json; charset=utf-8')
      .send(`${JSON.stringify(file, null, 2)}\n`);
  });
}
