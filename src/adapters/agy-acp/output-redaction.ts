import { redactSecretString } from "../../lib/redact";

const TAIL_CHARS = 512;
const BATCH_CHARS = 2 * TAIL_CHARS;

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
    const output = redactSecretString(this.pending);
    this.pending = "";
    return output;
  }

  private drain(): string {
    const raw = this.pending;
    const safe = redactSecretString(raw);
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
