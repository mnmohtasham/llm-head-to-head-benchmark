import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  MACHINE_COLORS,
  type AgentProbe,
  type CloudConfig,
  type LoadJob,
  type ProbeRaw,
  type ProbeReport,
} from '@duel/shared';

export const MACHINES_SCHEMA_VERSION = 1;

/** A machine as stored on disk. The only place the API key lives. */
export interface StoredMachine {
  id: string;
  name: string;
  baseUrl: string;
  notes: string;
  color: string;
  apiKey: string | null;
  /** The Model Duel agent on this machine, and its token; null when there is none. */
  agentUrl: string | null;
  agentToken: string | null;
  /** A cloud reference model: the provider and model. Its key is `apiKey`, its API `baseUrl`. */
  cloud: CloudConfig | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredProbe {
  schemaVersion: number;
  machineId: string;
  probedAt: string;
  durationMs: number;
  raw: ProbeRaw;
  report: ProbeReport;
  agent?: AgentProbe | null;
}

export interface NewMachine {
  name: string;
  baseUrl: string;
  notes: string;
  color?: string | undefined;
  apiKey: string | null;
  agentUrl?: string | null;
  agentToken?: string | null;
  cloud?: CloudConfig | null;
}

export interface MachinePatch {
  name: string;
  baseUrl: string;
  notes?: string | undefined;
  color?: string | undefined;
  /** undefined keeps the saved key, null removes it, a string replaces it. */
  apiKey?: string | null | undefined;
  /** As for the key: undefined keeps, null removes, a string replaces. */
  agentUrl?: string | null | undefined;
  agentToken?: string | null | undefined;
  cloud?: CloudConfig | undefined;
}

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

function isStoredMachine(value: unknown): value is StoredMachine {
  const m = value as Partial<StoredMachine> | null;
  return (
    !!m &&
    typeof m.id === 'string' &&
    ID_PATTERN.test(m.id) &&
    typeof m.name === 'string' &&
    typeof m.baseUrl === 'string' &&
    typeof m.notes === 'string' &&
    typeof m.color === 'string' &&
    (m.apiKey === null || typeof m.apiKey === 'string') &&
    // Files from before the agent have neither field.
    (m.agentUrl === undefined || m.agentUrl === null || typeof m.agentUrl === 'string') &&
    (m.agentToken === undefined || m.agentToken === null || typeof m.agentToken === 'string') &&
    typeof m.createdAt === 'string' &&
    typeof m.updatedAt === 'string'
  );
}

/** Writes through a temporary file so a crash never leaves a half-written file behind. */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, data, { mode: 0o600 });
  await rename(temporary, file);
  await chmod(file, 0o600);
}

/**
 * Machines live in `<dataDir>/machines.json` (mode 600, because it holds API keys) and the last
 * probe of each machine in `<dataDir>/probes/<id>.json`.
 */
export class MachineStore {
  private machines: StoredMachine[] = [];
  private readonly probes = new Map<string, StoredProbe>();
  private readonly loads = new Map<string, LoadJob>();
  private writes: Promise<void> = Promise.resolve();

  constructor(readonly dataDir: string) {}

  get machinesFile(): string {
    return path.join(this.dataDir, 'machines.json');
  }

  private probeFile(id: string): string {
    if (!ID_PATTERN.test(id)) throw new Error(`Not a machine id: ${id}`);
    return path.join(this.dataDir, 'probes', `${id}.json`);
  }

  private loadFile(id: string): string {
    if (!ID_PATTERN.test(id)) throw new Error(`Not a machine id: ${id}`);
    return path.join(this.dataDir, 'loads', `${id}.json`);
  }

  async init(): Promise<void> {
    await mkdir(path.join(this.dataDir, 'probes'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.dataDir, 'loads'), { recursive: true, mode: 0o700 });
    let text: string | null = null;
    try {
      text = await readFile(this.machinesFile, 'utf8');
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    if (text !== null) {
      this.machines = this.parseMachines(text);
      // Tighten the permissions of a file created by hand or copied from elsewhere.
      await chmod(this.machinesFile, 0o600);
    }
    for (const machine of this.machines) {
      const probe = await this.readProbe(machine.id);
      if (probe) this.probes.set(machine.id, probe);
      const load = await this.readLoad(machine.id);
      if (load) this.loads.set(machine.id, load);
    }
  }

  private parseMachines(text: string): StoredMachine[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(
        `${this.machinesFile} is not valid JSON (${(error as Error).message}). Fix it or move it away, then start again.`,
        { cause: error },
      );
    }
    const file = parsed as { schemaVersion?: unknown; machines?: unknown } | null;
    if (typeof file?.schemaVersion !== 'number' || !Array.isArray(file.machines)) {
      throw new Error(`${this.machinesFile} does not look like a Model Duel machines file.`);
    }
    if (file.schemaVersion > MACHINES_SCHEMA_VERSION) {
      throw new Error(
        `${this.machinesFile} was written by a newer version of Model Duel (schema ${file.schemaVersion}).`,
      );
    }
    const bad = file.machines.findIndex((entry) => !isStoredMachine(entry));
    if (bad >= 0) throw new Error(`Machine ${bad + 1} in ${this.machinesFile} is malformed.`);
    return (file.machines as StoredMachine[]).map((m) => ({
      ...m,
      agentUrl: m.agentUrl ?? null,
      agentToken: m.agentToken ?? null,
      cloud: m.cloud ?? null,
    }));
  }

  private async readProbe(id: string): Promise<StoredProbe | null> {
    try {
      return JSON.parse(await readFile(this.probeFile(id), 'utf8')) as StoredProbe;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      // A damaged probe file is not worth refusing to start over: the next probe replaces it.
      return null;
    }
  }

  private async readLoad(id: string): Promise<LoadJob | null> {
    try {
      const saved = JSON.parse(await readFile(this.loadFile(id), 'utf8')) as { job?: LoadJob };
      return saved.job ?? null;
    } catch {
      return null;
    }
  }

  private persist(): Promise<void> {
    const snapshot = `${JSON.stringify(
      { schemaVersion: MACHINES_SCHEMA_VERSION, machines: this.machines },
      null,
      2,
    )}\n`;
    const write = this.writes
      .catch(() => undefined)
      .then(() => writeFileAtomic(this.machinesFile, snapshot));
    this.writes = write;
    return write;
  }

  list(): StoredMachine[] {
    return this.machines.map((machine) => ({ ...machine }));
  }

  get(id: string): StoredMachine | undefined {
    const machine = this.machines.find((m) => m.id === id);
    return machine ? { ...machine } : undefined;
  }

  lastProbe(id: string): StoredProbe | undefined {
    return this.probes.get(id);
  }

  private nextColor(): string {
    const used = new Set(this.machines.map((m) => m.color.toLowerCase()));
    return (
      MACHINE_COLORS.find((color) => !used.has(color)) ??
      MACHINE_COLORS[this.machines.length % MACHINE_COLORS.length] ??
      MACHINE_COLORS[0]
    );
  }

  async create(input: NewMachine): Promise<StoredMachine> {
    const now = new Date().toISOString();
    const machine: StoredMachine = {
      id: randomUUID(),
      name: input.name,
      baseUrl: input.baseUrl,
      notes: input.notes,
      color: input.color ?? this.nextColor(),
      apiKey: input.apiKey,
      agentUrl: input.agentUrl ?? null,
      agentToken: input.agentToken ?? null,
      cloud: input.cloud ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.machines.push(machine);
    await this.persist();
    return { ...machine };
  }

  /** Returns the updated machine and whether the change makes the last probe stale. */
  async update(
    id: string,
    patch: MachinePatch,
  ): Promise<{ machine: StoredMachine; probeStale: boolean } | undefined> {
    const index = this.machines.findIndex((m) => m.id === id);
    const current = this.machines[index];
    if (!current) return undefined;
    const apiKey = patch.apiKey === undefined ? current.apiKey : patch.apiKey;
    const next: StoredMachine = {
      ...current,
      name: patch.name,
      baseUrl: patch.baseUrl,
      notes: patch.notes ?? current.notes,
      color: patch.color ?? current.color,
      apiKey,
      agentUrl: patch.agentUrl === undefined ? current.agentUrl : patch.agentUrl,
      agentToken: patch.agentToken === undefined ? current.agentToken : patch.agentToken,
      cloud: patch.cloud === undefined ? current.cloud : patch.cloud,
      updatedAt: new Date().toISOString(),
    };
    this.machines[index] = next;
    await this.persist();
    const probeStale = next.baseUrl !== current.baseUrl || next.apiKey !== current.apiKey;
    if (probeStale) {
      await this.clearProbe(id);
      await this.clearLoad(id);
    }
    return { machine: { ...next }, probeStale };
  }

  async remove(id: string): Promise<boolean> {
    const before = this.machines.length;
    this.machines = this.machines.filter((m) => m.id !== id);
    if (this.machines.length === before) return false;
    await this.persist();
    await this.clearProbe(id);
    await this.clearLoad(id);
    return true;
  }

  async saveProbe(probe: StoredProbe): Promise<void> {
    if (!this.machines.some((m) => m.id === probe.machineId)) return;
    await writeFileAtomic(this.probeFile(probe.machineId), `${JSON.stringify(probe, null, 2)}\n`);
    this.probes.set(probe.machineId, probe);
  }

  lastLoad(id: string): LoadJob | undefined {
    return this.loads.get(id);
  }

  /** Keeps the most recent finished load of a machine, so its time survives a restart. */
  async saveLoad(job: LoadJob): Promise<void> {
    if (!this.machines.some((m) => m.id === job.machineId)) return;
    const file = `${JSON.stringify({ schemaVersion: 1, job }, null, 2)}\n`;
    await writeFileAtomic(this.loadFile(job.machineId), file);
    this.loads.set(job.machineId, job);
  }

  async clearLoad(id: string): Promise<void> {
    this.loads.delete(id);
    await rm(this.loadFile(id), { force: true });
  }

  async clearProbe(id: string): Promise<void> {
    this.probes.delete(id);
    await rm(this.probeFile(id), { force: true });
  }
}
