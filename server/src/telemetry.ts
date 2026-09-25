import {
  parseTelemetry,
  type TelemetrySample,
  type TelemetryStatus,
  type TelemetryStreamMessage,
} from '@duel/shared';
import type { SettingsStore } from './settings';
import type { MachineStore } from './store';
import { UnslothClient } from './unsloth';

export interface TelemetryOptions {
  intervalMs: number;
  minBackoffMs: number;
  maxBackoffMs: number;
  /** How long samples are kept, so a long session can still find its own. */
  bufferMs: number;
  timeoutMs: number;
}

export const DEFAULT_TELEMETRY: TelemetryOptions = {
  intervalMs: 500,
  minBackoffMs: 1000,
  maxBackoffMs: 30_000,
  bufferMs: 3 * 60 * 60 * 1000,
  timeoutMs: 2000,
};

/** Epoch milliseconds on the same clock as the run timings. */
export const epochNow = () => performance.timeOrigin + performance.now();

type Listener = (message: TelemetryStreamMessage) => void;

/** Polls one machine; it runs only while someone needs it and telemetry is on. */
class Poller {
  refs = 0;
  status: TelemetryStatus;
  buffer: TelemetrySample[] = [];
  private timer: NodeJS.Timeout | null = null;
  private active = false;
  private backoff = 0;

  constructor(
    readonly machineId: string,
    private readonly hub: TelemetryHub,
  ) {
    this.status = { machineId, state: 'off', error: null, retryInMs: null, latest: null };
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.backoff = 0;
    this.setStatus({ state: 'waiting', error: null, retryInMs: null });
    this.schedule(0);
  }

  stop() {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.setStatus({ state: 'off', error: null, retryInMs: null });
  }

  private schedule(delay: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.poll(), delay);
  }

  private setStatus(patch: Partial<TelemetryStatus>) {
    const next = { ...this.status, ...patch };
    const changed =
      next.state !== this.status.state ||
      next.error !== this.status.error ||
      next.retryInMs !== this.status.retryInMs;
    this.status = next;
    if (changed) this.hub.statusChanged();
  }

  /** One poll; the next one is scheduled only when this one is over, so they never overlap. */
  private async poll() {
    this.timer = null;
    if (!this.active) return;
    const machine = this.hub.machine(this.machineId);
    if (!machine) {
      this.stop();
      return;
    }
    const { intervalMs, timeoutMs, minBackoffMs, maxBackoffMs, bufferMs } = this.hub.options;
    const sent = epochNow();
    // Fresh connections: Unsloth's answers on a reused connection stall for about 40 ms.
    const hwClient = new UnslothClient(machine.baseUrl, machine.apiKey, {
      connectTimeoutMs: timeoutMs,
    });
    const sysClient = new UnslothClient(machine.baseUrl, machine.apiKey, {
      connectTimeoutMs: timeoutMs,
    });
    const [hardware, system] = await Promise.all([
      hwClient.getJson('/api/train/hardware', { timeoutMs }),
      sysClient.getJson('/api/system', { timeoutMs }),
    ]).finally(() => Promise.all([hwClient.close(), sysClient.close()]));
    const received = epochNow();
    if (!this.active) return;
    if (hardware.status === 200 || system.status === 200) {
      const sample = parseTelemetry(
        hardware.status === 200 ? hardware.body : null,
        system.status === 200 ? system.body : null,
        (sent + received) / 2,
      );
      this.buffer.push(sample);
      const oldest = sample.at - bufferMs;
      while ((this.buffer[0]?.at ?? Infinity) < oldest) this.buffer.shift();
      this.backoff = 0;
      this.status = { ...this.status, latest: sample };
      this.setStatus({ state: 'ok', error: null, retryInMs: null });
      this.hub.sampled(this.machineId, sample);
      this.schedule(Math.max(0, intervalMs - (received - sent)));
      return;
    }
    this.backoff = this.backoff === 0 ? minBackoffMs : Math.min(maxBackoffMs, this.backoff * 2);
    const failure = hardware.error?.message ?? `it answered HTTP ${hardware.status ?? 'nothing'}`;
    this.setStatus({ state: 'backoff', error: failure, retryInMs: this.backoff });
    this.schedule(this.backoff);
  }
}

/**
 * One poller per machine at 2 Hz, shared by the Machines screen and races. A machine is polled
 * while at least one of them needs it and telemetry is switched on.
 */
export class TelemetryHub {
  private readonly pollers = new Map<string, Poller>();
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly machines: MachineStore,
    private readonly settings: SettingsStore,
    readonly options: TelemetryOptions = DEFAULT_TELEMETRY,
  ) {}

  get enabled(): boolean {
    return this.settings.get().telemetry;
  }

  machine(id: string) {
    return this.machines.get(id);
  }

  async setEnabled(on: boolean): Promise<void> {
    await this.settings.update({ telemetry: on });
    for (const poller of this.pollers.values()) {
      if (on && poller.refs > 0) poller.start();
      else poller.stop();
    }
    this.statusChanged();
  }

  /** Starts polling these machines until the returned function is called. */
  acquire(machineIds: readonly string[]): () => void {
    const held: Poller[] = [];
    for (const id of new Set(machineIds)) {
      // Cloud models have no hardware to read.
      if (this.machines.get(id)?.cloud) continue;
      let poller = this.pollers.get(id);
      if (!poller) {
        poller = new Poller(id, this);
        this.pollers.set(id, poller);
      }
      poller.refs += 1;
      if (this.enabled) poller.start();
      held.push(poller);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const poller of held) {
        poller.refs -= 1;
        if (poller.refs <= 0) poller.stop();
      }
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  statuses(machineIds?: readonly string[]): TelemetryStatus[] {
    const ids = machineIds ?? this.machines.list().map((m) => m.id);
    return ids.map(
      (id) =>
        this.pollers.get(id)?.status ?? {
          machineId: id,
          state: 'off',
          error: null,
          retryInMs: null,
          latest: null,
        },
    );
  }

  samplesBetween(machineId: string, from: number, to: number): TelemetrySample[] {
    return (this.pollers.get(machineId)?.buffer ?? []).filter((s) => s.at >= from && s.at <= to);
  }

  statusChanged() {
    const message: TelemetryStreamMessage = {
      type: 'status',
      enabled: this.enabled,
      statuses: this.statuses(),
    };
    for (const listener of this.listeners) listener(message);
  }

  sampled(machineId: string, sample: TelemetrySample) {
    for (const listener of this.listeners) listener({ type: 'sample', machineId, sample });
  }

  close() {
    for (const poller of this.pollers.values()) poller.stop();
    this.listeners.clear();
  }
}
