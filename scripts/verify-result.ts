/**
 * Checks result files: that each follows the result format and that its checksum matches.
 *
 *   npm run verify-result -- data/results/model-duel-2026-09-25-1a2b3c4d.json [more files]
 */
import { readFile } from 'node:fs/promises';
import { resultSchema, type ResultFile } from '@duel/shared';
import { verifyResult } from '../server/src/results';

const files = process.argv.slice(2);
if (files.length === 0) {
  process.stderr.write('Usage: npm run verify-result -- <result.json> [more files]\n');
  process.exit(2);
}
let failed = 0;
for (const file of files) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    process.stdout.write(`${file}: not readable JSON (${(error as Error).message})\n`);
    failed += 1;
    continue;
  }
  const checked = resultSchema.safeParse(parsed);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    process.stdout.write(
      `${file}: not a Model Duel result (${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid'})\n`,
    );
    failed += 1;
    continue;
  }
  if (!verifyResult(parsed as ResultFile)) {
    process.stdout.write(
      `${file}: the checksum does not match; the file was changed after it was written\n`,
    );
    failed += 1;
    continue;
  }
  process.stdout.write(`${file}: valid, race ${checked.data.id} of ${checked.data.createdAt}\n`);
}
process.exit(failed > 0 ? 1 : 0);
