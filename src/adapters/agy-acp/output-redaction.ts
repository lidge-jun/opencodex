import { OPEN_CODEX_CREDENTIAL_PATTERN, REDACTED_SECRET } from "../../lib/redact";

const TAIL_CHARS = 512;
const BATCH_CHARS = 2 * TAIL_CHARS;
const BEARER = /\b(Bearer[ \t]{1,64})[A-Za-z0-9._~+/=-]{8,}/i;
const JWT = /\beyJ[A-Za-z0-9_-]{8}[A-Za-z0-9._-]*/;
const API_KEY = /\bsk-[A-Za-z0-9][A-Za-z0-9._-]{6,}/;
const TOKEN_PATTERN = new RegExp(
  `${OPEN_CODEX_CREDENTIAL_PATTERN.source}|(${BEARER.source})|(${JWT.source}|${API_KEY.source})`,
  "gi",
);
const BEARER_CONTINUATION = /^[A-Za-z0-9._~+/=-]*/;
const KEY_CONTINUATION = /^[A-Za-z0-9._-]*/;

// A short suffix that could start or complete a supported credential in a later frame.
const INCOMPLETE_TOKEN = new RegExp(`(?:${[
  /o(?:c(?:x(?:_[A-Za-z0-9_-]{0,51}|r(?:w(?:_[A-Za-z0-9_-]{0,42})?)?)?)?)?/,
  /\b(?:b|be|bea|bear|beare|bearer(?:[ \t]{1,64}[A-Za-z0-9._~+/=-]{0,7})?)/,
  /\b(?:e|ey|eyj[A-Za-z0-9_-]{0,7})/,
  /\b(?:s|sk|sk-[A-Za-z0-9._-]{0,6})/,
].map(pattern => pattern.source).join("|")})$`, "i");
type ConsumeSpan = (raw: string, replacement?: string) => void;

/** Bound lookahead, then discard a recognized long token's remaining characters as they arrive. */
class AcpOutputRedactor {
  private pending = "";
  private previous = "";
  private continuation?: RegExp;

  constructor(private readonly consume: ConsumeSpan) {}

  push(chunk: string): void {
    for (let offset = 0; offset < chunk.length; offset += BATCH_CHARS) {
      this.pending += chunk.slice(offset, offset + BATCH_CHARS);
      if (this.pending.length >= BATCH_CHARS) this.drain("batch");
    }
  }

  releaseSafePrefix(): void {
    this.drain("switch");
  }

  flush(): void {
    this.drain("final");
  }

  private drain(mode: "batch" | "switch" | "final"): void {
    const final = mode === "final";
    if (this.continuation) {
      const tail = this.continuation.exec(this.pending)![0];
      this.pending = this.pending.slice(tail.length);
      if (tail) {
        this.consume(tail, "");
        this.previous = tail.slice(-1);
      }
      if (!this.pending && !final) return;
      this.continuation = undefined;
    }

    const raw = this.previous + this.pending;
    const start = this.previous.length;
    const incomplete = mode === "switch" ? INCOMPLETE_TOKEN.exec(raw) : null;
    let cut = mode === "batch" ? Math.max(start, raw.length - TAIL_CHARS)
      : Math.max(start, incomplete?.index ?? raw.length);
    if (!final && /[\uD800-\uDBFF]/.test(raw.charAt(cut - 1))) cut = Math.max(start, cut - 1);
    let cursor = start;
    TOKEN_PATTERN.lastIndex = start;
    for (const match of raw.matchAll(TOKEN_PATTERN)) {
      if (match.index >= cut) break;
      const end = match.index + match[0].length;
      const [, bearer, bearerPrefix, key] = match;
      const valueStart = match.index + (bearerPrefix?.length ?? 0);
      this.consume(raw.slice(cursor, valueStart));
      this.consume(raw.slice(valueStart, end), REDACTED_SECRET);
      cursor = end;
      if (!final && end === raw.length) {
        this.continuation = bearer ? BEARER_CONTINUATION : key ? KEY_CONTINUATION : undefined;
      }
    }
    const consumed = Math.max(cut, cursor);
    this.consume(raw.slice(cursor, consumed));
    this.previous = final ? "" : raw.charAt(consumed - 1);
    this.pending = raw.slice(consumed);
  }
}

type OutputType = "text_delta" | "thinking_delta";
interface PendingChunk {
  type: OutputType;
  remaining: number;
  safe: string;
}

/** Match each channel independently while publishing safe spans in ACP arrival order. */
export class AcpTurnOutput {
  private readonly streams = new Map<OutputType, { redactor: AcpOutputRedactor; chunks: PendingChunk[] }>();
  private pending: PendingChunk[] = [];
  private head = 0;
  private previousType?: OutputType;

  constructor(private readonly emit: (type: OutputType, text: string) => void) {}

  push(type: OutputType, text: string): boolean {
    if (this.previousType && this.previousType !== type) {
      this.streams.get(this.previousType)?.redactor.releaseSafePrefix();
    }
    this.previousType = type;
    let stream = this.streams.get(type);
    if (!stream) {
      const chunks: PendingChunk[] = [];
      stream = { chunks, redactor: new AcpOutputRedactor((raw, replacement) => this.consume(chunks, raw, replacement)) };
      this.streams.set(type, stream);
    }
    const chunk = { type, remaining: text.length, safe: "" };
    this.pending.push(chunk);
    stream.chunks.push(chunk);
    stream.redactor.push(text);
    return this.emitReady();
  }

  flush(): void {
    for (const { redactor } of this.streams.values()) redactor.flush();
    this.emitReady();
  }

  private consume(chunks: PendingChunk[], raw: string, replacement?: string): void {
    if (!raw.length) return;
    if (replacement !== undefined) chunks[0]!.safe += replacement;
    for (let offset = 0; offset < raw.length;) {
      const chunk = chunks[0]!;
      const count = Math.min(chunk.remaining, raw.length - offset);
      if (replacement === undefined) chunk.safe += raw.slice(offset, offset + count);
      chunk.remaining -= count;
      offset += count;
      if (!chunk.remaining) chunks.shift();
    }
  }

  private emitReady(): boolean {
    let type: OutputType | undefined;
    let text = "";
    for (let chunk = this.pending[this.head]; chunk; chunk = this.pending[this.head]) {
      if (chunk.safe) {
        if (type && chunk.type !== type) {
          this.emit(type, text);
          text = "";
        }
        type = chunk.type;
        text += chunk.safe;
        chunk.safe = "";
      }
      if (chunk.remaining) break;
      this.head++;
    }
    if (this.head === this.pending.length || (this.head > 1024 && this.head * 2 >= this.pending.length)) {
      this.pending = this.pending.slice(this.head);
      this.head = 0;
    }
    if (type) this.emit(type, text);
    return type !== undefined;
  }
}
