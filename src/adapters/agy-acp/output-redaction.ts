import { REDACTED_SECRET, redactSecretString } from "../../lib/redact";

// These are the minted management, dashboard, device/pairing and data-plane credentials.
// Match a complete value even when it is embedded in another identifier or quoted in code.
const OCX_CREDENTIAL = /ocx_(?:(?:admin|session|device|proof|pair)_[A-Za-z0-9_-]{43}|data_[0-9a-f]{40})/g;
const TAIL_CHARS = 512;
const BATCH_CHARS = 2 * TAIL_CHARS;

function redact(text: string): string {
  return redactSecretString(text.replace(OCX_CREDENTIAL, REDACTED_SECRET));
}

/** Keep lookahead across ACP frames without holding the whole answer or reasoning stream. */
export class AcpOutputRedactor {
  private pending = "";

  push(chunk: string): string {
    let output = "";
    for (let offset = 0; offset < chunk.length; offset += BATCH_CHARS) {
      this.pending += chunk.slice(offset, offset + BATCH_CHARS);
      if (this.pending.length >= BATCH_CHARS) output += this.drain();
    }
    return output;
  }

  flush(): string {
    const output = redact(this.pending);
    this.pending = "";
    return output;
  }

  private drain(): string {
    const raw = this.pending;
    const safe = redact(raw);
    let cut = raw.length - TAIL_CHARS;
    // If changes fall entirely in the tail, keep the original bytes for the next match.
    if (safe.startsWith(raw.slice(0, cut))) {
      if (/[\uD800-\uDBFF]/.test(raw[cut - 1]!)) cut--;
      this.pending = raw.slice(cut);
      return raw.slice(0, cut);
    }
    // Emit complete replacements when a match crosses the cut. Only carry unchanged suffix bytes.
    let retain = 0;
    while (retain < TAIL_CHARS && retain < safe.length
      && raw[raw.length - 1 - retain] === safe[safe.length - 1 - retain]) retain++;
    if (/[\uD800-\uDBFF]/.test(safe[safe.length - retain - 1] ?? "")) retain++;
    this.pending = raw.slice(raw.length - retain);
    return safe.slice(0, safe.length - retain);
  }
}
