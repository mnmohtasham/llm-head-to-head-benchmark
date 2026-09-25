import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The images a race produced, one PNG per run in `<dataDir>/images/<session>/<run>.png`, so the
 * session file stays small and a report still shows them after the machines' galleries change.
 */
export class ImageStore {
  constructor(readonly dataDir: string) {}

  private file(sessionId: string, runId: string): string | null {
    if (!ID.test(sessionId) || !ID.test(runId)) return null;
    return path.join(this.dataDir, 'images', sessionId, `${runId}.png`);
  }

  async save(sessionId: string, runId: string, png: Uint8Array): Promise<boolean> {
    const file = this.file(sessionId, runId);
    if (!file) return false;
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, png, { mode: 0o600 });
    return true;
  }

  async load(sessionId: string, runId: string): Promise<Buffer | null> {
    const file = this.file(sessionId, runId);
    if (!file) return null;
    try {
      return await readFile(file);
    } catch {
      return null;
    }
  }

  async removeSession(sessionId: string): Promise<void> {
    if (!ID.test(sessionId)) return;
    await rm(path.join(this.dataDir, 'images', sessionId), { recursive: true, force: true });
  }
}
