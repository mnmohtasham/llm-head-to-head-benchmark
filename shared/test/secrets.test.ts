import { describe, expect, it } from 'vitest';
import { maskApiKey, redactSecrets } from '../src/secrets';

describe('maskApiKey', () => {
  it('keeps the public prefix and at most the last four characters', () => {
    expect(maskApiKey('sk-unsloth-0123456789abcdef0123456789abcdef')).toBe('sk-unsloth-…cdef');
    expect(maskApiKey('some-other-long-secret-value')).toBe('…alue');
  });

  it('shows no characters of a short key', () => {
    expect(maskApiKey('sk-unsloth-abc')).toBe('sk-unsloth-…');
    expect(maskApiKey('short')).toBe('…');
  });

  it('returns null when there is no key', () => {
    expect(maskApiKey(null)).toBeNull();
    expect(maskApiKey(undefined)).toBeNull();
    expect(maskApiKey('')).toBeNull();
  });
});

describe('redactSecrets', () => {
  const key = 'sk-unsloth-0123456789abcdef0123456789abcdef';

  it('masks the key in strings, arrays and object keys at any depth', () => {
    const input = { a: `Bearer ${key}`, b: [{ c: key }], [key]: 1, n: 5, z: null };
    const output = redactSecrets(input, [key]);
    expect(JSON.stringify(output)).not.toContain(key);
    expect(output.a).toBe('Bearer sk-unsloth-…cdef');
    expect(output.n).toBe(5);
    expect(output.z).toBeNull();
  });

  it('leaves values alone when there is nothing to redact', () => {
    const input = { a: 'abc' };
    expect(redactSecrets(input, [null, undefined, ''])).toBe(input);
    expect(redactSecrets({ a: 'abcde' }, ['abcde'])).toEqual({ a: 'abcde' });
  });
});
