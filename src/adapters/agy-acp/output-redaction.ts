import { OPEN_CODEX_CREDENTIAL_PATTERN, REDACTED_SECRET } from "../../lib/redact";

const TAIL_CHARS = 512;
const BATCH_CHARS = 2 * TAIL_CHARS;
const MAX_ORDERED_CHUNKS = 64;
const MAX_ORDERED_CHARS = 2 * BATCH_CHARS;
const BEARER = /\b(Bearer[ \t]{1,64})[A-Za-z0-9._~+/=-]{8,}/i;
const JWT = /\beyJ[A-Za-z0-9_-]{8}[A-Za-z0-9._-]*/;
const API_KEY = /\bsk-[A-Za-z0-9][A-Za-z0-9._-]{6,}/;
const OAUTH_LABELS = ["access_token", "refresh_token", "id_token", "access-token", "refresh-token", "id-token", "accessToken", "refreshToken", "idToken"];
const OAUTH_BOUNDARY = /(?<![A-Za-z0-9_-])/;
const OAUTH_KEY_END = /["']?[ \t]{0,64}/;
const OAUTH_ASSIGNMENT = /[:=][ \t]{0,64}/;
const BARE_OAUTH_CHAR = /[^\s"'`,;{}\[\]<>]/;
const OAUTH_PREFIX = OAUTH_BOUNDARY.source + "(?:" + OAUTH_LABELS.join("|") + ")" + OAUTH_KEY_END.source + OAUTH_ASSIGNMENT.source;
const OAUTH_VALUE_START = OAUTH_PREFIX + "(?:([\"'])|(?=" + BARE_OAUTH_CHAR.source + "))";
const TOKEN_PATTERN = new RegExp(
  `${OPEN_CODEX_CREDENTIAL_PATTERN.source}|(${BEARER.source})|(${JWT.source}|${API_KEY.source})|(${OAUTH_VALUE_START})`,
  "gi",
);
const BEARER_CONTINUATION = /^[A-Za-z0-9._~+/=-]*/;
const KEY_CONTINUATION = /^[A-Za-z0-9._-]*/;
const OAUTH_LABEL_PREFIXES = new Set(OAUTH_LABELS.flatMap(label =>
  Array.from({ length: label.length - 1 }, (_, index) => label.slice(0, index + 1))));
const INCOMPLETE_OAUTH = new RegExp(OAUTH_BOUNDARY.source
  + "(?:" + [...OAUTH_LABEL_PREFIXES].join("|") + "|(?:" + OAUTH_LABELS.join("|") + ")"
  + OAUTH_KEY_END.source + "(?:" + OAUTH_ASSIGNMENT.source + ")?)");

// A short suffix that could start or complete a supported credential in a later frame.
const INCOMPLETE_TOKEN = new RegExp(`(?:${[
  /o(?:c(?:x(?:_[A-Za-z0-9_-]{0,51}|r(?:w(?:_[A-Za-z0-9_-]{0,42})?)?)?)?)?/,
  /\b(?:b|be|bea|bear|beare|bearer(?:[ \t]{1,64}[A-Za-z0-9._~+/=-]{0,7})?)/,
  /\b(?:e|ey|eyj[A-Za-z0-9_-]{0,7})/,
  /\b(?:s|sk|sk-[A-Za-z0-9._-]{0,6})/,
  INCOMPLETE_OAUTH,
].map(pattern => pattern.source).join("|")})$`, "i");
type ConsumeSpan = (raw: string, replacement?: string) => void;
type OAuthValue = { quote?: string; escaped: boolean; masked: boolean };

/** Bound lookahead, then discard a recognized long token's remaining characters as they arrive. */
class AcpOutputRedactor {
  private pending = "";
  private previous = "";
  private continuation?: RegExp;
  private oauthValue?: OAuthValue;

  constructor(private readonly consume: ConsumeSpan) {}

  push(chunk: string): void {
    for (let offset = 0; offset < chunk.length; offset += BATCH_CHARS) {
      this.pending += chunk.slice(offset, offset + BATCH_CHARS);
      if (this.pending.length >= BATCH_CHARS) this.drain("batch");
    }
    this.drain("stream");
  }

  flush(): void {
    this.drain("final");
  }

  private consumeOAuthValue(raw: string, start: number, value: OAuthValue): number {
    let end = start;
    for (; end < raw.length; end++) {
      const char = raw[end]!;
      if (!value.quote) {
        if (!BARE_OAUTH_CHAR.test(char)) break;
      } else if (value.escaped) {
        value.escaped = false;
      } else if (char === value.quote) {
        break;
      } else {
        value.escaped = char === "\\";
      }
    }
    if (end > start) {
      this.consume(raw.slice(start, end), value.masked ? "" : REDACTED_SECRET);
      value.masked = true;
    }
    this.oauthValue = end === raw.length ? value : undefined;
    return end;
  }

  private drain(mode: "batch" | "stream" | "final"): void {
    const final = mode === "final";
    if (this.oauthValue) {
      const consumed = this.consumeOAuthValue(this.pending, 0, this.oauthValue);
      if (consumed) this.previous = this.pending.charAt(consumed - 1);
      this.pending = this.pending.slice(consumed);
      if (this.oauthValue) return;
    }
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
    const incomplete = mode === "stream" ? INCOMPLETE_TOKEN.exec(raw) : null;
    let cut = mode === "batch" ? Math.max(start, raw.length - TAIL_CHARS)
      : Math.max(start, incomplete?.index ?? raw.length);
    if (!final && /[\uD800-\uDBFF]/.test(raw.charAt(cut - 1))) cut = Math.max(start, cut - 1);
    let cursor = start;
    TOKEN_PATTERN.lastIndex = start;
    for (const match of raw.matchAll(TOKEN_PATTERN)) {
      if (match.index >= cut) break;
      if (match.index < cursor) continue;
      const end = match.index + match[0].length;
      const [, bearer, bearerPrefix, key, oauthPrefix, quote] = match;
      if (oauthPrefix) {
        this.consume(raw.slice(cursor, end));
        cursor = this.consumeOAuthValue(raw, end, { quote, escaped: false, masked: false });
        continue;
      }
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
  released?: boolean;
}

/** Match each channel independently while publishing safe spans in ACP arrival order. */
export class AcpTurnOutput {
  private readonly streams = new Map<OutputType, { redactor: AcpOutputRedactor; chunks: PendingChunk[] }>();
  private pending: PendingChunk[] = [];
  private head = 0;

  constructor(private readonly emit: (type: OutputType, text: string) => void) {}

  push(type: OutputType, text: string): boolean {
    if (!text) return false;
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
    let emitted = this.emitReady();
    while (this.orderedBacklogExceeded()) {
      const blocked = this.pending[this.head]!;
      // Keep the raw suffix in its channel scanner to catch an eventual continuation.
      // Release its place in the shared output order with a conservative replacement.
      blocked.released = true;
      blocked.safe = REDACTED_SECRET;
      emitted = this.emitReady() || emitted;
    }
    return emitted;
  }

  flush(): void {
    for (const { redactor } of this.streams.values()) redactor.flush();
    this.emitReady();
  }

  private consume(chunks: PendingChunk[], raw: string, replacement?: string): void {
    if (!raw.length) return;
    if (replacement !== undefined && !chunks[0]!.released) chunks[0]!.safe += replacement;
    for (let offset = 0; offset < raw.length;) {
      const chunk = chunks[0]!;
      const count = Math.min(chunk.remaining, raw.length - offset);
      if (replacement === undefined && !chunk.released) chunk.safe += raw.slice(offset, offset + count);
      chunk.remaining -= count;
      offset += count;
      if (!chunk.remaining) chunks.shift();
    }
  }

  private orderedBacklogExceeded(): boolean {
    // A live suffix alone is smaller than the lookahead. Only a queued successor can block.
    if (this.pending.length - this.head <= 1) return false;
    if (this.pending.length - this.head > MAX_ORDERED_CHUNKS) return true;
    let size = 0;
    for (let i = this.head; i < this.pending.length; i++) {
      const chunk = this.pending[i]!;
      size += chunk.remaining + chunk.safe.length;
      if (size > MAX_ORDERED_CHARS) return true;
    }
    return false;
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
      if (chunk.remaining && !chunk.released) break;
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
