import { findMonitorRow, type MonitorRow } from '@duel/shared';
import type { StoredMachine } from './store';
import { UnslothClient } from './unsloth';

/** Reads Unsloth's monitor row for a finished run; the row can trail the stream by a moment. */
export async function readMonitorRow(
  machine: StoredMachine,
  prompt: string,
): Promise<MonitorRow | null> {
  const client = new UnslothClient(machine.baseUrl, machine.apiKey, { connectTimeoutMs: 3000 });
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const answer = await client.getJson('/api/inference/monitor', { timeoutMs: 5000 });
      if (answer.status !== 200) return null;
      const row = findMonitorRow(answer.body, prompt);
      if (row && row.status !== 'streaming') return row;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return null;
  } finally {
    await client.close();
  }
}

/** Asks Unsloth to stop a generation by the cancel id it was sent with. */
export async function cancelOnMachine(machine: StoredMachine, cancelId: string): Promise<void> {
  const client = new UnslothClient(machine.baseUrl, machine.apiKey, { connectTimeoutMs: 3000 });
  try {
    await client.postJson('/api/inference/cancel', { cancel_id: cancelId }, { timeoutMs: 5000 });
  } finally {
    await client.close();
  }
}
