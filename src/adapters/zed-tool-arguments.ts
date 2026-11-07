import { createHash } from "node:crypto";
import { ZedJsonError, ZedJsonScanner, zedJsonTokens } from "./zed-json-tokens";

/** Ordered lexical tokens are shared by equality, incremental validation and replay hashes. */
export function zedArgumentFingerprint(text: string, custom: boolean): string {
  const hash = createHash("sha256");
  // UTF-16 hashing also distinguishes lone surrogates, which UTF-8 replacement would collapse.
  if (custom) return hash.update("custom:").update(text, "utf16le").digest("hex");
  let tokens: Uint32Array;
  try { tokens = zedJsonTokens(text); }
  catch (error) {
    if (error instanceof ZedJsonError && error.message.includes('depth limit')) throw error;
    return hash.update("raw:").update(text, "utf16le").digest("hex");
  }
  return hash.update("json:").update(Buffer.from(tokens.buffer, tokens.byteOffset, tokens.byteLength)).digest("hex");
}

/** Retained authoritative token stream; each late source unit is scanned exactly once. */
export class ZedArgumentAuthority {
  private tokens?: Uint32Array;
  private scanner?: ZedJsonScanner;
  private at = 0;
  get steps(): number { return this.scanner?.steps ?? this.at; }

  constructor(private full: string, private custom: boolean, prefix = '') {
    // The existing protocol uses an empty field for a parameter-free call (not JSON null).
    if (!custom && full !== '') {
      this.tokens = zedJsonTokens(full);
      this.scanner = new ZedJsonScanner(token => {
        if (token !== this.tokens![this.at++]) throw new ZedJsonError('conflicting arguments');
      });
    }
    this.push(prefix);
  }

  push(fragment: string): void {
    if (this.scanner) this.scanner.push(fragment);
    else {
      if (!this.full.startsWith(fragment, this.at)) throw new ZedJsonError('conflicting custom input');
      this.at += fragment.length;
    }
  }
}

/** Retained bytes cover the token buffer and the bounded incremental grammar stack. */
export function zedArgumentAuthorityBytes(text: string, custom: boolean): number {
  return custom ? 0 : text.length * 4 + Math.min(text.length, 65_536) * 8 + 64;
}

/** Keep delivered bytes; append only a suffix of the same ordered lexical JSON value. */
export function reconcileZedArguments(prefix: string, full: string, custom: boolean): string | undefined {
  if (custom) return full.startsWith(prefix) ? full : undefined;
  if (full === '') return prefix === '' ? '' : undefined;
  const positions = new Uint32Array(full.length);
  const tokens = zedJsonTokens(full, positions);
  let at = 0;
  let end = 0;
  const scanner = new ZedJsonScanner((token) => {
    if (token !== tokens[at]) throw new ZedJsonError('conflicting arguments');
    end = positions[at++]!;
  });
  try {
    scanner.push(prefix);
    if (scanner.complete) {
      scanner.finish();
      return at === tokens.length ? prefix : undefined;
    }
    const escape = scanner.escapeSuffix(tokens[at]);
    if (escape === undefined) return;
    if (escape) end = positions[at]!;
    const suffix = escape + full.slice(end);
    scanner.push(suffix);
    scanner.finish();
    return at === tokens.length ? prefix + suffix : undefined;
  } catch (error) {
    if (error instanceof ZedJsonError && !error.message.includes('depth limit')) return;
    throw error;
  }
}
