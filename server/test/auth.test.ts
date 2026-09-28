import { stat, rm, writeFile } from 'node:fs/promises';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { SESSION_COOKIE } from '../src/auth';
import { tempDir } from './helpers';

const PASSWORD = 'correct horse battery staple';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const undo of cleanup.splice(0)) await undo();
});

async function app(options: { password?: string | null; dataDir?: string; client?: boolean } = {}) {
  const dataDir = options.dataDir ?? (await tempDir());
  let clientDir: string | null = null;
  if (options.client) {
    clientDir = await tempDir();
    await writeFile(path.join(clientDir, 'index.html'), '<!doctype html><title>Model Duel</title>');
    const dir = clientDir;
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
  }
  const built = await buildApp({ dataDir, clientDir, password: options.password ?? null });
  cleanup.push(() => built.close());
  if (!options.dataDir) cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  return { app: built, dataDir };
}

/** The session cookie a sign-in set, as a Cookie header. */
function sessionOf(setCookie: string | string[] | undefined): string {
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  expect(header).toContain('HttpOnly');
  expect(header).toContain('SameSite=Strict');
  return (header ?? '').split(';', 1)[0] ?? '';
}

async function signIn(built: Awaited<ReturnType<typeof app>>['app']): Promise<string> {
  const response = await built.inject({
    method: 'POST',
    url: '/api/login',
    payload: { password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  return sessionOf(response.headers['set-cookie']);
}

describe('without a password', () => {
  it('stays open, as before', async () => {
    const { app: built } = await app();
    expect((await built.inject({ url: '/api/auth' })).json()).toEqual({
      required: false,
      signedIn: true,
    });
    expect((await built.inject({ url: '/api/machines' })).statusCode).toBe(200);
  });
});

describe('with a password', () => {
  it('answers only the health check, the page and signing in until signed in', async () => {
    const { app: built } = await app({ password: PASSWORD, client: true });
    for (const url of ['/api/machines', '/api/sessions', '/api/runs', '/api/share/settings']) {
      const response = await built.inject({ url });
      expect(response.statusCode, url).toBe(401);
      expect(response.json()).toMatchObject({ error: 'unauthorized' });
    }
    const change = await built.inject({
      method: 'POST',
      url: '/api/machines',
      payload: { name: 'x', baseUrl: '127.0.0.1:9' },
    });
    expect(change.statusCode).toBe(401);
    expect((await built.inject({ url: '/api/health' })).statusCode).toBe(200);
    expect((await built.inject({ url: '/' })).statusCode).toBe(200);
    expect((await built.inject({ url: '/api/auth' })).json()).toEqual({
      required: true,
      signedIn: false,
    });
  });

  it('signs in with the right password only, and the cookie opens every route', async () => {
    const { app: built } = await app({ password: PASSWORD });
    const wrong = await built.inject({
      method: 'POST',
      url: '/api/login',
      payload: { password: 'correct horse battery stapler' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ error: 'wrong_password' });
    expect(wrong.headers['set-cookie']).toBeUndefined();

    const cookie = await signIn(built);
    expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    const listed = await built.inject({ url: '/api/machines', headers: { cookie } });
    expect(listed.statusCode).toBe(200);
    expect((await built.inject({ url: '/api/auth', headers: { cookie } })).json()).toEqual({
      required: true,
      signedIn: true,
    });
  });

  it('refuses a changed, foreign or expired cookie', async () => {
    let now = Date.now();
    const dataDir = await tempDir();
    cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
    const built = await buildApp({ dataDir, password: PASSWORD });
    cleanup.push(() => built.close());
    const cookie = await signIn(built);
    const [name, value = ''] = cookie.split('=');
    const [expires = '', mac = ''] = value.split('.');
    const forged = [
      `${name}=${Number(expires) + 1000}.${mac}`,
      `${name}=${expires}.${mac.slice(0, -2)}AA`,
      `${name}=${expires}`,
      `${name}=`,
    ];
    for (const bad of forged) {
      expect(
        (await built.inject({ url: '/api/machines', headers: { cookie: bad } })).statusCode,
      ).toBe(401);
    }

    // Another data folder has another secret, so its cookies mean nothing here.
    const other = await app({ password: PASSWORD });
    const foreign = await signIn(other.app);
    expect(
      (await built.inject({ url: '/api/machines', headers: { cookie: foreign } })).statusCode,
    ).toBe(401);

    // Sessions end after 30 days.
    const later = await buildApp({ dataDir, password: PASSWORD, clock: () => now });
    cleanup.push(() => later.close());
    expect((await later.inject({ url: '/api/machines', headers: { cookie } })).statusCode).toBe(
      200,
    );
    now += 31 * 24 * 60 * 60 * 1000;
    expect((await later.inject({ url: '/api/machines', headers: { cookie } })).statusCode).toBe(
      401,
    );
  });

  it('keeps sessions across a restart, and a new password signs everyone out', async () => {
    const dataDir = await tempDir();
    cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
    const first = await app({ password: PASSWORD, dataDir });
    const cookie = await signIn(first.app);
    await first.app.close();

    const again = await app({ password: PASSWORD, dataDir });
    expect((await again.app.inject({ url: '/api/machines', headers: { cookie } })).statusCode).toBe(
      200,
    );
    await again.app.close();

    const changed = await app({ password: 'a different password', dataDir });
    expect(
      (await changed.app.inject({ url: '/api/machines', headers: { cookie } })).statusCode,
    ).toBe(401);

    // The secret sessions are signed with is readable by this user only.
    expect((await stat(path.join(dataDir, 'auth.json'))).mode & 0o777).toBe(0o600);
  });

  it('signs out by clearing the cookie', async () => {
    const { app: built } = await app({ password: PASSWORD });
    const response = await built.inject({ method: 'POST', url: '/api/logout' });
    expect(String(response.headers['set-cookie'])).toMatch(
      new RegExp(`^${SESSION_COOKIE}=; Max-Age=0`),
    );
  });

  it('makes an address wait after ten wrong passwords, even for the right one', async () => {
    const { app: built } = await app({ password: PASSWORD });
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await built.inject({
        method: 'POST',
        url: '/api/login',
        payload: { password: `guess ${attempt}` },
      });
      expect(response.statusCode).toBe(401);
    }
    const blocked = await built.inject({
      method: 'POST',
      url: '/api/login',
      payload: { password: PASSWORD },
    });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('holds a burst of wrong passwords sent at once to the same limit', async () => {
    const { app: built } = await app({ password: PASSWORD });
    const answers = await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        built.inject({ method: 'POST', url: '/api/login', payload: { password: `guess ${i}` } }),
      ),
    );
    const codes = answers.map((a) => a.statusCode);
    expect(codes.filter((c) => c === 401)).toHaveLength(10);
    expect(codes.filter((c) => c === 429)).toHaveLength(5);
  });

  it('cannot be skipped with an unusual spelling of a path', async () => {
    const { app: built } = await app({ password: PASSWORD, client: true });
    await built.listen({ port: 0, host: '127.0.0.1' });
    const { port } = built.server.address() as AddressInfo;
    const raw = (target: string) =>
      new Promise<string>((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.end(
            `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
          );
        });
        let text = '';
        socket.on('data', (chunk) => (text += String(chunk)));
        socket.on('end', () => resolve(text));
        socket.on('error', reject);
      });
    for (const target of [
      `http://127.0.0.1:${port}/api/machines`,
      '//api/machines',
      '/api/machines/',
      '/API/machines',
      '/api/%6dachines',
      '/api/health/../machines',
      '/./api/machines',
    ]) {
      const response = await raw(target);
      // Whatever each spelling reaches, it is never the machine list.
      expect(response, target).not.toMatch(/^HTTP\/1\.1 200[\s\S]*\r\n\r\n\[/);
    }
  });
});
