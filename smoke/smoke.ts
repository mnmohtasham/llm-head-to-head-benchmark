/**
 * Smoke test for a running Model Duel: is it up, serving the page and the API, and holding its
 * security settings? It only reads, so it is safe against a real install with real machines.
 *
 *   npm run smoke                                  checks http://127.0.0.1:3000
 *   npm run smoke -- --url http://my-pc:3000       checks another address
 *   SMOKE_PASSWORD=… npm run smoke                 signs in first when the app has a password
 */
import http from 'node:http';
import https from 'node:https';
import { parseArgs } from 'node:util';

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.SMOKE_URL ?? 'http://127.0.0.1:3000' },
    help: { type: 'boolean', default: false },
  },
});
if (values.help) {
  process.stdout.write(
    'Usage: npm run smoke -- [--url http://127.0.0.1:3000]\nSet SMOKE_PASSWORD when the app has a password.\n',
  );
  process.exit(0);
}

const base = new URL(values.url);
const password = process.env.SMOKE_PASSWORD ?? '';

/** One request with full control of the headers, which fetch() would not allow for Host. */
function request(
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<Answer> {
  const body = options.body === undefined ? null : JSON.stringify(options.body);
  const client = base.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const outgoing = client.request(
      new URL(path, base),
      {
        method,
        headers: {
          ...(body === null ? {} : { 'content-type': 'application/json' }),
          ...options.headers,
        },
        timeout: 10_000,
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (text += chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }),
        );
      },
    );
    outgoing.on('timeout', () => outgoing.destroy(new Error('no answer within 10 s')));
    outgoing.on('error', reject);
    outgoing.end(body ?? undefined);
  });
}

const json = (answer: Answer): unknown => {
  try {
    return JSON.parse(answer.body) as unknown;
  } catch {
    return null;
  }
};

let failures = 0;
/** Set when the app has a password the smoke test was not given: the API cannot be checked. */
let locked = false;
async function check(
  name: string,
  test: () => Promise<string | void>,
  options: { needsApi?: boolean } = {},
): Promise<void> {
  if (options.needsApi && locked) {
    process.stdout.write(`  skip  ${name} (needs SMOKE_PASSWORD)\n`);
    return;
  }
  try {
    const note = await test();
    process.stdout.write(`  ok    ${name}${note ? ` (${note})` : ''}\n`);
  } catch (error) {
    failures++;
    process.stdout.write(`  FAIL  ${name}: ${(error as Error).message}\n`);
  }
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

process.stdout.write(`Smoke test of ${base.origin}\n`);
let session = '';

await check('the health check answers', async () => {
  const answer = await request('GET', '/api/health');
  expect(answer.status === 200, `HTTP ${answer.status}`);
  const health = json(answer) as { ok?: boolean; app?: string; version?: string; mode?: string };
  expect(health?.ok === true && health.app === 'model-duel', 'not a Model Duel health answer');
  expect(health.mode === 'production', `mode is ${health.mode}; measure with the production build`);
  return `version ${health.version}`;
});

await check('the page loads with its scripts and styles', async () => {
  const page = await request('GET', '/');
  expect(page.status === 200, `HTTP ${page.status}`);
  expect(String(page.headers['content-type']).startsWith('text/html'), 'not HTML');
  expect(page.body.includes('<div id="root">'), 'no #root in the page');
  const assets = [...page.body.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
  expect(assets.length > 0, 'the page names no built assets; is the client built?');
  for (const asset of assets) {
    const answer = await request('GET', asset ?? '');
    expect(answer.status === 200, `${asset} answered HTTP ${answer.status}`);
  }
  return `${assets.length} assets`;
});

await check('security headers come with the page and the API', async () => {
  for (const path of ['/', '/api/health']) {
    const { headers } = await request('GET', path);
    const csp = String(headers['content-security-policy'] ?? '');
    expect(csp.includes("default-src 'self'"), `${path}: no Content-Security-Policy`);
    expect(csp.includes("frame-ancestors 'none'"), `${path}: the page could be framed`);
    expect(headers['x-content-type-options'] === 'nosniff', `${path}: no X-Content-Type-Options`);
    expect(headers['referrer-policy'] === 'no-referrer', `${path}: no Referrer-Policy`);
  }
});

await check('requests addressed to an unknown host name are refused', async () => {
  const answer = await request('GET', '/api/health', { headers: { host: 'attacker.example' } });
  expect(answer.status === 403, `HTTP ${answer.status}, so DNS rebinding would reach the app`);
});

await check('changes asked for by another web site are refused', async () => {
  const answer = await request('POST', '/api/machines', {
    headers: { origin: 'https://attacker.example' },
    body: { name: 'smoke', baseUrl: '127.0.0.1:9' },
  });
  expect(answer.status === 403, `HTTP ${answer.status}`);
});

await check('the password is enforced when there is one', async () => {
  const auth = json(await request('GET', '/api/auth')) as { required?: boolean } | null;
  if (!auth?.required) return 'no password set';
  const closed = await request('GET', '/api/machines');
  expect(
    closed.status === 401,
    `the machine list answered HTTP ${closed.status} without signing in`,
  );
  locked = password === '';
  expect(!locked, 'the app has a password: set SMOKE_PASSWORD to check the API too');
  const signIn = await request('POST', '/api/login', { body: { password } });
  expect(signIn.status === 200, `signing in answered HTTP ${signIn.status}`);
  const cookie = String(signIn.headers['set-cookie'] ?? '');
  expect(
    /HttpOnly/i.test(cookie) && /SameSite=Strict/i.test(cookie),
    'the session cookie is not HttpOnly and SameSite=Strict',
  );
  session = cookie.split(';', 1)[0] ?? '';
  return 'signed in';
});

await check(
  'the API answers, uncached and without API keys',
  async () => {
    const answer = await request(
      'GET',
      '/api/machines',
      session ? { headers: { cookie: session } } : {},
    );
    expect(answer.status === 200, `HTTP ${answer.status}`);
    expect(answer.headers['cache-control'] === 'no-store', 'API answers may be cached');
    const machines = json(answer);
    expect(Array.isArray(machines), 'the machine list is not a list');
    for (const machine of machines as Array<Record<string, unknown>>) {
      expect(!('apiKey' in machine), `the machine list shows ${String(machine.name)}'s API key`);
    }
    return `${(machines as unknown[]).length} machines`;
  },
  { needsApi: true },
);

await check(
  'an unknown API route is a clean 404',
  async () => {
    const answer = await request(
      'GET',
      '/api/no-such-route',
      session ? { headers: { cookie: session } } : {},
    );
    expect(answer.status === 404, `HTTP ${answer.status}`);
    expect((json(answer) as { error?: string } | null)?.error === 'no_route', 'not a JSON 404');
  },
  { needsApi: true },
);

if (session) {
  await request('POST', '/api/logout', { headers: { cookie: session } }).catch(() => undefined);
}
process.stdout.write(
  failures === 0 ? 'Smoke test passed.\n' : `Smoke test failed: ${failures} checks.\n`,
);
process.exit(failures === 0 ? 0 : 1);
