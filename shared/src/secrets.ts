export const UNSLOTH_KEY_PREFIX = 'sk-unsloth-';

/**
 * The form of an API key that is safe to show: the public `sk-unsloth-` prefix and, for long
 * keys only, the last four characters.
 */
export function maskApiKey(key: string | null | undefined): string | null {
  if (!key) return null;
  const prefix = key.startsWith(UNSLOTH_KEY_PREFIX) ? UNSLOTH_KEY_PREFIX : '';
  const secret = key.slice(prefix.length);
  const tail = secret.length >= 12 ? secret.slice(-4) : '';
  return `${prefix}…${tail}`;
}

/** Replaces every occurrence of the given secrets in strings and object keys, at any depth. */
export function redactSecrets<T>(value: T, secrets: ReadonlyArray<string | null | undefined>): T {
  const list = secrets.filter((s): s is string => typeof s === 'string' && s.length >= 6);
  if (list.length === 0) return value;
  const scrub = (text: string): string =>
    list.reduce((acc, secret) => acc.split(secret).join(maskApiKey(secret) ?? '…'), text);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return scrub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [scrub(k), walk(x)]));
    }
    return v;
  };
  return walk(value) as T;
}
