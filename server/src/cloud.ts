import {
  CLOUD_INFO,
  cloudErrorMessage,
  cloudHeaders,
  CloudStreamReader,
  modelListPath,
  parseModelList,
  type CloudModel,
  type CloudProvider,
} from '@duel/shared';
import { Agent, request } from 'undici';
import { streamSse, type StreamOptions, type StreamOutcome } from './chat-stream';
import { toNetworkError } from './unsloth';

async function getJson(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number | null; body: unknown; error: string | null }> {
  const agent = new Agent({ connect: { timeout: 10_000 } });
  try {
    const response = await request(url, {
      headers: { accept: 'application/json', ...headers },
      dispatcher: agent,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.body.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      // Keep the text for the error.
    }
    return { status: response.statusCode, body, error: null };
  } catch (error) {
    return { status: null, body: null, error: toNetworkError(error).message };
  } finally {
    await agent.destroy().catch(() => undefined);
  }
}

/** A provider's answer to a bad request, in words a person can act on. */
export function cloudFailure(
  provider: CloudProvider,
  status: number | null,
  body: unknown,
): string {
  const label = CLOUD_INFO[provider].label;
  const said = cloudErrorMessage(body);
  if (
    status === 401 ||
    status === 403 ||
    (provider === 'gemini' && /API key not valid/i.test(said ?? ''))
  ) {
    return `${label} did not accept the API key${said ? `: ${said}` : '.'}`;
  }
  if (status === 429) return `${label} is rate-limiting this key${said ? `: ${said}` : '.'}`;
  if (status === 529 || status === 503)
    return `${label} is overloaded; try again later${said ? ` (${said})` : '.'}`;
  return `${label} answered HTTP ${status ?? 'nothing'}${said ? `: ${said}` : '.'}`;
}

/** The text models a provider offers this key, following its pages. */
export async function listCloudModels(
  provider: CloudProvider,
  baseUrl: string,
  apiKey: string | null,
): Promise<{ models: CloudModel[] | null; error: string | null }> {
  if (!apiKey)
    return { models: null, error: `Enter the ${CLOUD_INFO[provider].label} API key first.` };
  const headers = cloudHeaders(provider, apiKey);
  const models: CloudModel[] = [];
  let path = modelListPath(provider);
  for (let page = 0; page < 10; page += 1) {
    const answer = await getJson(`${baseUrl}${path}`, headers);
    if (answer.error)
      return {
        models: null,
        error: `${CLOUD_INFO[provider].label} is not answering: ${answer.error}`,
      };
    if (answer.status !== 200)
      return { models: null, error: cloudFailure(provider, answer.status, answer.body) };
    models.push(...parseModelList(provider, answer.body));
    const b = (answer.body ?? {}) as {
      has_more?: unknown;
      last_id?: unknown;
      nextPageToken?: unknown;
    };
    if (provider === 'anthropic' && b.has_more === true && typeof b.last_id === 'string') {
      path = `${modelListPath(provider)}&after_id=${encodeURIComponent(b.last_id)}`;
    } else if (provider === 'gemini' && typeof b.nextPageToken === 'string' && b.nextPageToken) {
      path = `${modelListPath(provider)}&pageToken=${encodeURIComponent(b.nextPageToken)}`;
    } else break;
  }
  const unique = new Map(models.map((m) => [m.id, m]));
  return { models: [...unique.values()].sort((a, b) => a.id.localeCompare(b.id)), error: null };
}

/** Streams one run from a provider, read into the same events as Unsloth's stream. */
export async function streamCloud(
  provider: CloudProvider,
  baseUrl: string,
  apiKey: string | null,
  path: string,
  body: Record<string, unknown>,
  options: StreamOptions,
): Promise<StreamOutcome & { usage: Record<string, unknown> | null }> {
  const reader = new CloudStreamReader(provider);
  const outcome = await streamSse(
    {
      url: `${baseUrl}${path}`,
      headers: cloudHeaders(provider, apiKey),
      interpret: (message) => reader.push(message),
      end: () => reader.end(),
    },
    body,
    options,
  );
  return { ...outcome, usage: reader.raw };
}
