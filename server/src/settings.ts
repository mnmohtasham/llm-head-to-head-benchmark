import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from './store';

export interface Settings {
  /** Poll each machine's hardware during races and on the Machines screen. */
  telemetry: boolean;
}

const DEFAULTS: Settings = { telemetry: true };

/** App-wide settings in `<dataDir>/settings.json`. */
export class SettingsStore {
  private current: Settings = { ...DEFAULTS };

  constructor(readonly dataDir: string) {}

  get file(): string {
    return path.join(this.dataDir, 'settings.json');
  }

  async init(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8')) as Partial<Settings>;
      this.current = {
        telemetry: typeof saved.telemetry === 'boolean' ? saved.telemetry : DEFAULTS.telemetry,
      };
    } catch {
      this.current = { ...DEFAULTS };
    }
  }

  get(): Settings {
    return { ...this.current };
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    this.current = { ...this.current, ...patch };
    await writeFileAtomic(
      this.file,
      `${JSON.stringify({ schemaVersion: 1, ...this.current }, null, 2)}\n`,
    );
    return this.get();
  }
}
