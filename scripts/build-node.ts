/**
 * Bundles the controller, the mock and the agent into single ESM files. Workspace packages (@duel/*) are
 * compiled in; third-party packages stay external and load from node_modules.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));

function dependenciesOf(pkg: string): string[] {
  const manifest = JSON.parse(readFileSync(path.join(root, pkg, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  return Object.keys(manifest.dependencies ?? {});
}

for (const pkg of ['server', 'mock', 'agent']) {
  const external = [...new Set([...dependenciesOf(pkg), ...dependenciesOf('shared')])].filter(
    (name) => !name.startsWith('@duel/'),
  );
  await build({
    entryPoints: [path.join(root, pkg, 'src', 'index.ts')],
    outfile: path.join(root, pkg, 'dist', 'index.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: true,
    external,
    logLevel: 'warning',
  });
  process.stdout.write(`built ${pkg}/dist/index.js\n`);
}
