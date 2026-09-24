import {
  isUnslothHealth,
  PROBE_ROUTES,
  PROBE_SCHEMA_VERSION,
  redactSecrets,
  type ProbeRaw,
  type RouteKey,
  type RouteResult,
} from '@duel/shared';
import { UnslothClient } from './unsloth';

export interface ProbeTimeouts {
  connectMs: number;
  requestMs: number;
  /** For routes that scan disks or shell out: the model catalog and hardware details. */
  slowRequestMs: number;
}

export const DEFAULT_PROBE_TIMEOUTS: ProbeTimeouts = {
  connectMs: 4000,
  requestMs: 8000,
  slowRequestMs: 20000,
};

const SLOW_ROUTES: ReadonlySet<RouteKey> = new Set<RouteKey>(['models', 'hardware']);
const AFTER_KEY_CHECK: readonly RouteKey[] = [
  'system',
  'hardware',
  'models',
  'props',
  'stt',
  'image',
  'telemetry',
];
const RTT_SAMPLES = 3;

/**
 * Reads every route the report needs. Stops early when the machine is not Unsloth or the key
 * is refused, since every later route would fail the same way.
 */
export async function runProbe(
  baseUrl: string,
  apiKey: string | null,
  timeouts: ProbeTimeouts = DEFAULT_PROBE_TIMEOUTS,
): Promise<ProbeRaw> {
  const client = new UnslothClient(baseUrl, apiKey, { connectTimeoutMs: timeouts.connectMs });
  const startedAt = new Date();
  const started = performance.now();
  const routes: Partial<Record<RouteKey, RouteResult>> = {};
  const rttMs: number[] = [];
  const get = (key: RouteKey) =>
    client.getJson(PROBE_ROUTES[key], {
      timeoutMs: SLOW_ROUTES.has(key) ? timeouts.slowRequestMs : timeouts.requestMs,
    });

  try {
    routes.health = await get('health');
    if (isUnslothHealth(routes.health)) {
      routes.status = await get('status');
      const refused = routes.status.status === 401 || routes.status.status === 403;
      if (!refused) {
        const results = await Promise.all(AFTER_KEY_CHECK.map((key) => get(key)));
        AFTER_KEY_CHECK.forEach((key, index) => {
          routes[key] = results[index];
        });
      }
      // Round trips on the warm keep-alive connection, without the key.
      for (let i = 0; i < RTT_SAMPLES; i += 1) {
        const ping = await client.getJson(PROBE_ROUTES.health, {
          auth: false,
          timeoutMs: timeouts.requestMs,
        });
        if (ping.status === 200 && ping.ms !== null) rttMs.push(ping.ms);
      }
    }
  } finally {
    await client.close();
  }

  return {
    schemaVersion: PROBE_SCHEMA_VERSION,
    baseUrl,
    keyConfigured: Boolean(apiKey),
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    routes,
    rttMs,
  };
}

/** Opaque host identifiers that have no use in a report but would identify the install. */
const SCRUBBED_FIELDS = new Set(['studio_root_id', 'token_sha256', 'cloudflare_url']);

function scrubFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubFields);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        SCRUBBED_FIELDS.has(key) && inner !== null ? '<redacted>' : scrubFields(inner),
      ]),
    );
  }
  return value;
}

/** Makes a probe safe to store and export: the key is masked wherever it appears. */
export function sanitizeProbe(raw: ProbeRaw, apiKey: string | null): ProbeRaw {
  return redactSecrets(scrubFields(raw) as ProbeRaw, [apiKey]);
}
