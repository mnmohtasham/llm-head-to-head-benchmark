import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { DEFAULT_AGENT_PORT } from '@duel/shared';
import { startAgent } from './server';

const HELP = `Model Duel agent: runs allowlisted commands, such as ffmpeg encodes, for Model Duel.

Usage: npm run agent -- [options]

  --port <n>        Port to listen on (default ${DEFAULT_AGENT_PORT})
  --host <addr>     Address to bind (default 127.0.0.1; use 0.0.0.0 to reach it over the network)
  --token <text>    The token Model Duel must send (or MODEL_DUEL_AGENT_TOKEN); one is made if empty
  --clips <dir>     Folder of source clips (default data/clips)
  --make-clip       Make a 20-second 1080p reference clip in the clips folder with ffmpeg, then stop
  --fake            Also offer a scripted fake encode and clip, for the demo and tests
  --no-telemetry    Do not read macmon or nvidia-smi during jobs
`;

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: String(DEFAULT_AGENT_PORT) },
    host: { type: 'string', default: '127.0.0.1' },
    token: { type: 'string' },
    clips: { type: 'string', default: path.join('data', 'clips') },
    'make-clip': { type: 'boolean', default: false },
    fake: { type: 'boolean', default: false },
    'fake-fps': { type: 'string' },
    'no-telemetry': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const clipsDir = path.resolve(values.clips);

if (values['make-clip']) {
  await mkdir(clipsDir, { recursive: true });
  const file = path.join(clipsDir, 'reference-1080p30.mp4');
  process.stdout.write(`Making ${file}…\n`);
  await promisify(execFile)(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1920x1080:rate=30',
      '-t',
      '20',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      file,
    ],
    { timeout: 10 * 60_000 },
  );
  process.stdout.write(
    'Done. Copy this same file to every machine: Model Duel compares the clips by checksum.\n',
  );
  process.exit(0);
}

const token = values.token ?? process.env.MODEL_DUEL_AGENT_TOKEN ?? randomBytes(24).toString('hex');
const agent = await startAgent({
  port: Number(values.port),
  host: values.host,
  token,
  clipsDir,
  fake: values.fake,
  ...(values['fake-fps'] ? { fakeFps: Number(values['fake-fps']) } : {}),
  telemetry: !values['no-telemetry'],
});
process.stdout.write(
  `Model Duel agent on ${values.host}:${agent.port}, clips in ${clipsDir}\n` +
    `Token: ${token}\n` +
    'Add the agent address and this token to the machine on the Machines screen.\n',
);
if (values.host !== '127.0.0.1' && values.host !== 'localhost') {
  process.stdout.write(
    'Warning: anyone on this network who has the token can run the allowlisted encodes here.\n',
  );
}
const stop = () => {
  void agent.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
