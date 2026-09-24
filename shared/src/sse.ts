/**
 * A byte-level parser for Server-Sent Events that keeps the arrival time of every event. Each
 * network read is stamped when it arrives; an event takes the time of the read that completed
 * it. Follows the WHATWG event-stream rules: lines end with CRLF, LF or CR, a blank line ends an
 * event, lines starting with ":" are comments, and an event cut off by the end of the stream is
 * dropped.
 */

export type SseMessage =
  | { kind: 'data'; data: string; t: number; read: number }
  | { kind: 'comment'; text: string; t: number; read: number };

export class SseParser {
  private readonly decoder = new TextDecoder('utf-8');
  private pending = '';
  private dataLines: string[] = [];
  private reads = 0;

  /** Feeds one network read, stamped with its arrival time, and returns the events it completed. */
  push(bytes: Uint8Array, t: number): SseMessage[] {
    const read = this.reads;
    this.reads += 1;
    return this.consume(this.decoder.decode(bytes, { stream: true }), t, read, false);
  }

  /** Ends the stream. Only a CR that was waiting for a possible LF can still finish a line. */
  end(t: number): SseMessage[] {
    return this.consume(this.decoder.decode(), t, this.reads, true);
  }

  /** How many reads the parser has seen. */
  get readCount(): number {
    return this.reads;
  }

  private consume(text: string, t: number, read: number, final: boolean): SseMessage[] {
    this.pending += text;
    const out: SseMessage[] = [];
    let start = 0;
    for (let i = 0; i < this.pending.length; i += 1) {
      const ch = this.pending[i];
      if (ch !== '\n' && ch !== '\r') continue;
      if (ch === '\r' && i === this.pending.length - 1 && !final) break; // a LF may follow in the next read
      const line = this.pending.slice(start, i);
      if (ch === '\r' && this.pending[i + 1] === '\n') i += 1;
      start = i + 1;
      const message = this.line(line, t, read);
      if (message) out.push(message);
    }
    this.pending = this.pending.slice(start);
    return out;
  }

  private line(line: string, t: number, read: number): SseMessage | null {
    if (line === '') {
      const dispatch = this.dataLines.length > 0;
      const data = this.dataLines.join('\n');
      this.dataLines = [];
      return dispatch ? { kind: 'data', data, t, read } : null;
    }
    if (line.startsWith(':')) return { kind: 'comment', text: line.slice(1).trim(), t, read };
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.dataLines.push(value);
    return null;
  }
}
