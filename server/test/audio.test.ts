import { rm } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { AudioStore } from '../src/audio';
import { tempDir } from './helpers';

it('keeps uploaded audio within its limits, removing the oldest first', async () => {
  const dataDir = await tempDir();
  try {
    const store = new AudioStore(dataDir, { bytes: 10_000, files: 2 });
    const saved = [];
    for (const fill of [1, 2, 3]) {
      saved.push(await store.save(`clip ${fill}.wav`, 'audio/wav', new Uint8Array(100).fill(fill)));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await store.meta(saved[0]!.id)).toBeNull();
    expect(await store.meta(saved[1]!.id)).not.toBeNull();
    expect(await store.meta(saved[2]!.id)).not.toBeNull();
    // Past the size limit, even the one before goes; the one just saved always stays.
    const big = await store.save('big.wav', 'audio/wav', new Uint8Array(20_000).fill(9));
    expect(await store.meta(big.id)).not.toBeNull();
    expect(await store.meta(saved[2]!.id)).toBeNull();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
