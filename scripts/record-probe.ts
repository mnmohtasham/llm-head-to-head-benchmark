/**
 * Probes one Unsloth machine and saves the result as a fixture, in the same format as
 * "Export probe" in the app. The key is masked in the file.
 *
 *   UNSLOTH_API_KEY=sk-unsloth-... npm run record:probe -- --url http://192.168.1.20 --name linux-5090
 *   npm run record:probe -- --url 127.0.0.1 --name real-linux-no-key       (no key: records the 401)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  classifyProbe,
  normalizeBaseUrl,
  PROBE_EXPORT_KIND,
  PROBE_SCHEMA_VERSION,
  type ProbeExport,
} from '@duel/shared';
import { runProbe, sanitizeProbe } from '../server/src/probe';

const root = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    name: { type: 'string' },
    notes: { type: 'string', default: '' },
    key: { type: 'string' },
    out: { type: 'string', default: 'fixtures/probe' },
  },
});

if (!values.url || !values.name) {
  process.stderr.write('Usage: npm run record:probe -- --url <address> --name <fixture-name>\n');
  process.exit(2);
}
const url = normalizeBaseUrl(values.url);
if (!url.ok) {
  process.stderr.write(`${url.error}\n`);
  process.exit(2);
}
const apiKey = values.key ?? process.env.UNSLOTH_API_KEY ?? null;

const raw = sanitizeProbe(await runProbe(url.url, apiKey), apiKey);
const report = classifyProbe(raw);
const file: ProbeExport = {
  kind: PROBE_EXPORT_KIND,
  schemaVersion: PROBE_SCHEMA_VERSION,
  exportedAt: new Date().toISOString(),
  app: { name: 'model-duel', version: 'record-probe' },
  machine: {
    name: values.name,
    baseUrl: url.url,
    notes: values.notes,
    keyConfigured: apiKey !== null,
  },
  probedAt: raw.finishedAt,
  durationMs: raw.durationMs,
  raw,
  report,
};
const outDir = path.resolve(root, values.out);
await mkdir(outDir, { recursive: true });
const target = path.join(outDir, `${values.name}.json`);
await writeFile(target, `${JSON.stringify(file, null, 2)}\n`);

process.stdout.write(`Saved ${path.relative(root, target)}  (overall: ${report.overall})\n`);
for (const [key, capability] of Object.entries(report.capabilities)) {
  process.stdout.write(
    `  ${key.padEnd(10)} ${capability.status.padEnd(8)} ${capability.summary}\n`,
  );
}
