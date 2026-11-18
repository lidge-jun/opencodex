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

/** Bound lookahead, then discard a recognized long token's remaining characters as they arrive. */
export class AcpOutputRedactor {
  private pending = "";
  private previous = "";
  private continuation?: RegExp;

  push(chunk: string): string {
    let output = "";
    for (let offset = 0; offset < chunk.length; offset += BATCH_CHARS) {
      this.pending += chunk.slice(offset, offset + BATCH_CHARS);
      if (this.pending.length >= BATCH_CHARS) output += this.drain(false);
    }
    return output;
  }

  flush(): string {
    return this.drain(true);
  }

  private drain(final: boolean): string {
    if (this.continuation) {
      const tail = this.continuation.exec(this.pending)![0];
      this.pending = this.pending.slice(tail.length);
      if (tail) this.previous = tail.slice(-1);
      if (!this.pending && !final) return "";
      this.continuation = undefined;
    }

    const raw = this.previous + this.pending;
    const start = this.previous.length;
    let cut = final ? raw.length : Math.max(start, raw.length - TAIL_CHARS);
    if (!final && /[\uD800-\uDBFF]/.test(raw.charAt(cut - 1))) cut = Math.max(start, cut - 1);
    let output = "";
    let cursor = start;
    TOKEN_PATTERN.lastIndex = start;
    for (const match of raw.matchAll(TOKEN_PATTERN)) {
      if (match.index >= cut) break;
      const end = match.index + match[0].length;
      const [, bearer, bearerPrefix, key] = match;
      output += raw.slice(cursor, match.index) + (bearerPrefix ?? "") + REDACTED_SECRET;
      cursor = end;
      if (!final && end === raw.length) {
        this.continuation = bearer ? BEARER_CONTINUATION : key ? KEY_CONTINUATION : undefined;
      }
    }
    const consumed = Math.max(cut, cursor);
    this.previous = final ? "" : raw.charAt(consumed - 1);
    this.pending = raw.slice(consumed);
    return output + raw.slice(cursor, consumed);
  }
}
