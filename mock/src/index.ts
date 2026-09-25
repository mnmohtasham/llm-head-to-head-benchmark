import { parseArgs } from 'node:util';
import { startCloudMock, type CloudMockProvider } from './cloud';
import { PROFILE_NAMES, type ProfileName } from './profiles';
import { startMockServer } from './server';

const HELP = `Fake Unsloth Studio backend for tests and the no-GPU demo.

Usage: npm run mock -- [options]

  --port <n>        Port to listen on (default 18881)
  --host <addr>     Address to bind (default 127.0.0.1)
  --profile <name>  ${PROFILE_NAMES.join(' or ')} (default linux-cuda)
  --api-key <key>   Key the mock accepts (default sk-unsloth-mock-key-0000000000000000)
  --keyless         Accept requests without a key
  --name <text>     Name shown in the startup line
  --cloud <name>    Be a fake cloud provider instead: openai, anthropic or gemini

Control it at runtime:
  curl -X POST http://127.0.0.1:18881/__mock/config -H 'content-type: application/json' \\
       -d '{"rejectKey": true}'
  curl -X POST http://127.0.0.1:18881/__mock/reset
`;

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '18881' },
    host: { type: 'string', default: '127.0.0.1' },
    profile: { type: 'string', default: 'linux-cuda' },
    'api-key': { type: 'string' },
    keyless: { type: 'boolean', default: false },
    name: { type: 'string' },
    cloud: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const CLOUDS: readonly string[] = ['openai', 'anthropic', 'gemini'];
if (values.cloud !== undefined) {
  if (!CLOUDS.includes(values.cloud)) {
    process.stderr.write(`Unknown cloud "${values.cloud}". Use ${CLOUDS.join(', ')}.\n`);
    process.exit(2);
  }
  const apiKey = values['api-key'] ?? `mock-${values.cloud}-key-000000000000000000`;
  const cloud = await startCloudMock({
    provider: values.cloud as CloudMockProvider,
    apiKey,
    port: Number(values.port),
    host: values.host,
  });
  process.stdout.write(`Mock ${values.cloud} API on ${cloud.url}, key ${apiKey}\n`);
  const stopCloud = () => {
    void cloud.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stopCloud);
  process.on('SIGTERM', stopCloud);
} else {
  await startUnsloth();
}

async function startUnsloth() {
  const profile = values.profile as ProfileName;
  if (!PROFILE_NAMES.includes(profile)) {
    process.stderr.write(
      `Unknown profile "${values.profile}". Use ${PROFILE_NAMES.join(' or ')}.\n`,
    );
    process.exit(2);
  }

  const mock = await startMockServer({
    port: Number(values.port),
    host: values.host,
    profile,
    apiKey: values.keyless ? null : values['api-key'],
    ...(values.name ? { name: values.name } : {}),
  });
  const key = mock.config().apiKey;
  process.stdout.write(
    `Mock Unsloth "${mock.name}" (${profile}) on ${mock.url}, ${key ? `key ${key}` : 'no key needed'}\n`,
  );

  const stop = () => {
    void mock.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
