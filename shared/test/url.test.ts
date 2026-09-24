import { describe, expect, it } from 'vitest';
import { describeAddress, normalizeBaseUrl } from '../src/url';

const ok = (input: string) => {
  const result = normalizeBaseUrl(input);
  if (!result.ok) throw new Error(`expected ${input} to normalise, got: ${result.error}`);
  return result.url;
};
const error = (input: string) => {
  const result = normalizeBaseUrl(input);
  if (result.ok) throw new Error(`expected ${input} to fail, got ${result.url}`);
  return result.error;
};

describe('normalizeBaseUrl', () => {
  it.each([
    ['192.168.1.10', 'http://192.168.1.10:8888'],
    ['  192.168.1.10:9000  ', 'http://192.168.1.10:9000'],
    ['http://192.168.1.10:8888/', 'http://192.168.1.10:8888'],
    ['http://192.168.1.10:8888/v1', 'http://192.168.1.10:8888'],
    ['http://192.168.1.10:8888/v1/', 'http://192.168.1.10:8888'],
    ['192.168.1.10:8888/v1/chat/completions', 'http://192.168.1.10:8888'],
    ['192.168.1.10/api/health', 'http://192.168.1.10:8888'],
    ['HTTP://Mac-Studio.LOCAL:8888', 'http://mac-studio.local:8888'],
    ['localhost', 'http://localhost:8888'],
    ['http://host:80', 'http://host:80'],
    ['https://abc.trycloudflare.com/', 'https://abc.trycloudflare.com'],
    ['https://abc.trycloudflare.com:443', 'https://abc.trycloudflare.com:443'],
    ['::1', 'http://[::1]:8888'],
    ['fe80::1', 'http://[fe80::1]:8888'],
    ['[::1]:9000', 'http://[::1]:9000'],
    ['http://host:8888?x=1#y', 'http://host:8888'],
    ['host:8888/unsloth/', 'http://host:8888/unsloth'],
  ])('%s becomes %s', (input, expected) => {
    expect(ok(input)).toBe(expected);
  });

  it('gives the same result when applied twice', () => {
    for (const input of ['192.168.1.10', 'http://host:80', 'https://x.example', '::1', 'h:1/p/']) {
      const once = ok(input);
      expect(ok(once)).toBe(once);
    }
  });

  it('explains what is wrong with a bad address', () => {
    expect(error('')).toMatch(/Enter the machine address/);
    expect(error('   ')).toMatch(/Enter the machine address/);
    expect(error('ftp://host')).toMatch(/http:\/\/ or https:\/\//);
    expect(error('http://')).toMatch(/not a valid address/);
    expect(error('http://host:99999')).toMatch(/not a valid address/);
    expect(error('http://host:0')).toMatch(/Port 0/);
    expect(error('http://user:secret@host')).toMatch(/API key has its own field/);
  });
});

describe('describeAddress', () => {
  it('shows host, port and any path prefix', () => {
    expect(describeAddress('http://192.168.1.10:8888')).toBe('192.168.1.10:8888');
    expect(describeAddress('http://h:8888/unsloth')).toBe('h:8888/unsloth');
    expect(describeAddress('not a url')).toBe('not a url');
  });
});
