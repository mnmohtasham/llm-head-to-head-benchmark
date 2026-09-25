/** Writes the JSON Schemas in docs/ from the formats' own definitions. */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resultJsonSchema, shareJsonSchema } from '@duel/shared';

for (const [name, schema] of [
  ['result-format.schema.json', resultJsonSchema()],
  ['share-format.schema.json', shareJsonSchema()],
] as const) {
  const file = fileURLToPath(new URL(`../docs/${name}`, import.meta.url));
  await writeFile(file, `${JSON.stringify(schema, null, 2)}\n`);
  process.stdout.write(`wrote ${file}\n`);
}
