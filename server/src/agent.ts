import {
  SseParser,
  type AgentEvent,
  type AgentHealth,
  type AgentProbe,
  type JobRequest,
} from '@duel/shared';
import { Agent, request } from 'undici';
import type { StoredMachine } from './store';
import { toNetworkError } from './unsloth';

const headers = (machine: StoredMachine, json = false): Record<string, string> => ({
  ...(machine.agentToken ? { authorization: `Bearer ${machine.agentToken}` } : {}),
  ...(json ? { 'content-type': 'application/json' } : {}),
});

async function call(
  machine: StoredMachine,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  timeoutMs = 20_000,
): Promise<{ status: number | null; body: unknown; error: string | null }> {
  if (!machine.agentUrl) return { status: null, body: null, error: 'no agent' };
  const dispatcher = new Agent({ connect: { timeout: 3000 } });
  try {
    const response = await request(`${machine.agentUrl}${path}`, {
      method,
      headers: headers(machine, body !== undefined),
      body: body === undefined ? null : JSON.stringify(body),
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.body.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      // Keep the text.
    }
    return { status: response.statusCode, body: parsed, error: null };
  } catch (error) {
    return { status: null, body: null, error: toNetworkError(error).message };
  } finally {
    await dispatcher.destroy().catch(() => undefined);
  }
}

const messageOf = (body: unknown) =>
  typeof (body as { message?: unknown } | null)?.message === 'string'
    ? (body as { message: string }).message
    : null;

/** The agent's health with the token: its ffmpeg, encoders, clips and extra telemetry. */
export async function agentHealth(machine: StoredMachine): Promise<AgentProbe> {
  if (!machine.agentUrl) return { health: null, error: `${machine.name} has no agent.` };
  const answer = await call(machine, 'GET', '/health', undefined, 60_000);
  if (answer.error) return { health: null, error: `The agent is not answering: ${answer.error}` };
  const body = answer.body as Partial<AgentHealth> | null;
  if (answer.status !== 200 || body?.app !== 'model-duel-agent') {
    return {
      health: null,
      error: `The agent address answered HTTP ${answer.status ?? 'nothing'}.`,
    };
  }
  // Without the right token the agent names itself and nothing else.
  if (!Array.isArray(body.clips)) {
    return { health: null, error: 'The agent did not accept the token.' };
  }
  return { health: body as AgentHealth, error: null };
}

export async function startJob(
  machine: StoredMachine,
  job: JobRequest,
): Promise<{ id: string; encoder: string } | { error: string }> {
  const answer = await call(machine, 'POST', '/jobs', job);
  if (answer.status === 201) return answer.body as { id: string; encoder: string };
  return {
    error:
      messageOf(answer.body) ??
      answer.error ??
      `The agent answered HTTP ${answer.status ?? 'nothing'}.`,
  };
}

export async function cancelJob(machine: StoredMachine, id: string): Promise<void> {
  await call(machine, 'POST', `/jobs/${encodeURIComponent(id)}/cancel`, {}, 5000);
}

/** Follows a job's events until it finishes, the stream breaks, or the signal fires. */
export async function followJob(
  machine: StoredMachine,
  id: string,
  options: { signal: AbortSignal; timeoutMs: number; onEvent: (event: AgentEvent) => void },
): Promise<{ events: AgentEvent[]; error: string | null }> {
  const events: AgentEvent[] = [];
  const dispatcher = new Agent({ connect: { timeout: 3000 } });
  try {
    const response = await request(`${machine.agentUrl}/jobs/${encodeURIComponent(id)}/stream`, {
      headers: headers(machine),
      dispatcher,
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]),
      bodyTimeout: options.timeoutMs,
    });
    if (response.statusCode !== 200) {
      return { events, error: `The agent's job stream answered HTTP ${response.statusCode}.` };
    }
    const parser = new SseParser();
    for await (const chunk of response.body) {
      for (const message of parser.push(chunk as Uint8Array, performance.now())) {
        if (message.kind !== 'data') continue;
        try {
          const event = JSON.parse(message.data) as AgentEvent;
          events.push(event);
          options.onEvent(event);
        } catch {
          // Not an event: ignore it.
        }
      }
    }
    return {
      events,
      error: events.some((e) => e.type === 'finished')
        ? null
        : 'The agent stream ended before the job finished.',
    };
  } catch (error) {
    return {
      events,
      error: options.signal.aborted ? null : toNetworkError(error).message,
    };
  } finally {
    await dispatcher.destroy().catch(() => undefined);
  }
}
