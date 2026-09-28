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

/** Longer than any line a model server sends; a line that grows past it stops the stream. */
export const SSE_MAX_LINE = 4 * 1024 * 1024;
/** The most data one event may gather over its lines. */
export const SSE_MAX_EVENT = 8 * 1024 * 1024;

/** A stream whose line or event outgrew the limits above; the reader stops instead of buffering. */
export class SseTooLargeError extends Error {
  readonly code = 'E_TOO_LARGE';

  constructor(what: 'line' | 'event') {
    super(`The stream sent a${what === 'event' ? 'n event' : ' line'} larger than any real one.`);
    this.name = 'SseTooLargeError';
  }
}

export class SseParser {
  private readonly decoder = new TextDecoder('utf-8');
  private pending = '';
  /** How much of `pending` holds no line end, so the next read scans only what is new. */
  private scanned = 0;
  /** Reads that ended no line, joined onto `pending` only once a line ends. */
  private tail: string[] = [];
  private tailLength = 0;
  private dataLines: string[] = [];
  private dataLength = 0;
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
    // A read that ends no line is only kept: touching the growing line on every read would make
    // a long line cost time in proportion to its square.
    if (!final && !/[\r\n]/.test(text) && !this.pending.endsWith('\r')) {
      this.tail.push(text);
      this.tailLength += text.length;
      if (this.pending.length + this.tailLength > SSE_MAX_LINE) throw new SseTooLargeError('line');
      return [];
    }
    if (this.tail.length > 0) {
      this.pending += this.tail.join('');
      this.scanned = this.pending.length;
      this.tail = [];
      this.tailLength = 0;
    }
    this.pending += text;
    const out: SseMessage[] = [];
    let start = 0;
    let i = this.scanned;
    for (; i < this.pending.length; i += 1) {
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
    // Scanning stopped at the end or at a CR still waiting for its LF, which is scanned again.
    this.scanned = Math.max(0, i - start);
    if (this.pending.length > SSE_MAX_LINE) throw new SseTooLargeError('line');
    return out;
  }

  private line(line: string, t: number, read: number): SseMessage | null {
    if (line === '') {
      const dispatch = this.dataLines.length > 0;
      const data = this.dataLines.join('\n');
      this.dataLines = [];
      this.dataLength = 0;
      return dispatch ? { kind: 'data', data, t, read } : null;
    }
    if (line.startsWith(':')) return { kind: 'comment', text: line.slice(1).trim(), t, read };
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      this.dataLength += value.length + 1;
      if (this.dataLength > SSE_MAX_EVENT) throw new SseTooLargeError('event');
      this.dataLines.push(value);
    }
    return null;
  }
}
