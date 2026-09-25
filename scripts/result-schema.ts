/** Writes docs/result-format.schema.json from the result format's own definition. */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resultJsonSchema } from '@duel/shared';

const file = fileURLToPath(new URL('../docs/result-format.schema.json', import.meta.url));
await writeFile(file, `${JSON.stringify(resultJsonSchema(), null, 2)}\n`);
process.stdout.write(`wrote ${file}\n`);
