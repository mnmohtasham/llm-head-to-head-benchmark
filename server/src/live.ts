import type { ServerResponse } from 'node:http';

/**
 * The live streams that are open: a race's and the telemetry's. They hold their connections, so
 * shutting down ends them; otherwise closing the server would wait for every open browser tab.
 */
export class LiveStreams {
  private readonly open = new Map<ServerResponse, () => void>();

  /** Keeps a stream until it closes; `close` is how it ends itself. */
  add(raw: ServerResponse, close: () => void): () => void {
    this.open.set(raw, close);
    return () => {
      this.open.delete(raw);
    };
  }

  get size(): number {
    return this.open.size;
  }

  endAll(): void {
    for (const [raw, close] of [...this.open]) {
      this.open.delete(raw);
      close();
      if (!raw.writableEnded) raw.end();
    }
  }
}

/** One serialization per message, however many listeners it goes to. */
const serialized = new WeakMap<object, string>();

export function sseData(message: object): string {
  let text = serialized.get(message);
  if (text === undefined) {
    text = `data: ${JSON.stringify(message)}\n\n`;
    serialized.set(message, text);
  }
  return text;
}
