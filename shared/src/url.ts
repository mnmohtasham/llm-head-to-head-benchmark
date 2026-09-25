/** The port Unsloth Studio listens on unless it was started with another one. */
export const DEFAULT_UNSLOTH_PORT = 8888;

export type NormalizedUrl = { ok: true; url: string } | { ok: false; error: string };

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

function isBareIpv6(text: string): boolean {
  return !text.includes('[') && (text.match(/:/g) ?? []).length >= 2 && /^[0-9a-f:.]+$/i.test(text);
}

/** Whether the authority part of the address names a port, even one the URL parser would drop. */
function hasExplicitPort(withScheme: string): boolean {
  const afterScheme = withScheme.slice(withScheme.indexOf('://') + 3);
  const authority = afterScheme.split(/[/?#]/, 1)[0] ?? '';
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  if (hostPort.startsWith('[')) return /^\[[^\]]*\]:\d+$/.test(hostPort);
  return /:\d+$/.test(hostPort);
}

/**
 * Turns an address as a person types it into the base URL the controller calls.
 *
 * - `192.168.1.10` becomes `http://192.168.1.10:8888`
 * - `http://mac.local:8888/v1/` becomes `http://mac.local:8888`
 * - `https://abc.trycloudflare.com/` becomes `https://abc.trycloudflare.com`
 *
 * The result is stable: normalising it again returns the same string.
 */
export function normalizeBaseUrl(
  input: string,
  defaultPort: number = DEFAULT_UNSLOTH_PORT,
): NormalizedUrl {
  const typed = input.trim();
  if (!typed) return { ok: false, error: 'Enter the machine address, for example 192.168.1.10.' };

  let text = typed;
  if (!HAS_SCHEME.test(text) && isBareIpv6(text)) text = `[${text}]`;
  if (!HAS_SCHEME.test(text)) text = `http://${text}`;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: `"${typed}" is not a valid address.` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Use an http:// or https:// address.' };
  }
  if (!url.hostname) return { ok: false, error: 'The address has no host.' };
  if (url.username || url.password) {
    return {
      ok: false,
      error: 'Leave user names and passwords out of the address. The API key has its own field.',
    };
  }

  let port: string;
  if (hasExplicitPort(text)) {
    port = url.port || (url.protocol === 'http:' ? '80' : '443');
  } else {
    port = url.protocol === 'http:' ? String(defaultPort) : '';
  }
  if (port === '0') return { ok: false, error: 'Port 0 is not a usable port.' };

  // Keep a reverse-proxy prefix, but drop pasted API paths such as /v1 or /api/health.
  const path = url.pathname.replace(/\/(v1|api)(\/.*)?$/i, '').replace(/\/+$/, '');
  return { ok: true, url: `${url.protocol}//${url.hostname}${port ? `:${port}` : ''}${path}` };
}

/** `host:port` plus any path prefix, for messages. */
export function describeAddress(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    const path = url.pathname === '/' ? '' : url.pathname;
    return `${url.host}${path}`;
  } catch {
    return baseUrl;
  }
}
