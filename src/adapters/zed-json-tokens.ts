/** Containers, including the root, are bounded independently of the JS call stack. */
export const ZED_JSON_MAX_DEPTH = 65_536;

export class ZedJsonError extends Error {
  constructor(detail = 'invalid JSON') { super(`Zed tool arguments: ${detail}`); }
}

// Disjoint alphabets preserve token boundaries, exact number spelling and decoded UTF-16.
// A surrogate pair has the same two units whether literal or escaped; lone units stay distinct.
const STRING = 0x10000;
const NUMBER = 0x20000;
const LITERAL = 0x30000;
const whitespace = (c: string) => c === ' ' || c === '\t' || c === '\r' || c === '\n';
const digit = (c: string) => c >= '0' && c <= '9';

/** Single-pass, resumable JSON lexer + iterative grammar validator. No value conversion. */
export class ZedJsonScanner {
  steps = 0;
  offset = 0;
  private frames = [8]; // object: 0..4, array: 5..7, root: 8(value)/9(done)
  private mode: 'plain' | 'string' | 'number' | 'literal' = 'plain';
  private number = '';
  private literal = '';
  private literalAt = 0;
  private escape = false;
  private unicodeLeft = 0;
  private unicodeValue = 0;

  constructor(private emit: (token: number, end: number) => void) {}

  private value(): void {
    const top = this.frames.length - 1;
    const state = this.frames[top];
    if (state === 8) this.frames[top] = 9;
    else if (state === 3) this.frames[top] = 4;
    else if (state === 5 || state === 6) this.frames[top] = 7;
    else throw new ZedJsonError();
  }

  private numberEnd(): void {
    if (!['zero', 'int', 'frac', 'exp'].includes(this.number)) throw new ZedJsonError();
    this.mode = 'plain';
  }

  push(fragment: string): void {
    for (let i = 0; i < fragment.length; i++) {
      this.steps++;
      const c = fragment[i]!;
      const code = fragment.charCodeAt(i);
      this.offset++;
      if (this.mode === 'string') {
        if (this.unicodeLeft) {
          const hex = code >= 48 && code <= 57 ? code - 48
            : code >= 65 && code <= 70 ? code - 55 : code >= 97 && code <= 102 ? code - 87 : -1;
          if (hex < 0) throw new ZedJsonError();
          this.unicodeValue = this.unicodeValue * 16 + hex;
          if (--this.unicodeLeft === 0) this.emit(STRING + this.unicodeValue, this.offset);
        } else if (this.escape) {
          this.escape = false;
          if (c === 'u') { this.unicodeLeft = 4; this.unicodeValue = 0; }
          else {
            const decoded = '"\\/bfnrt'.indexOf(c);
            if (decoded < 0) throw new ZedJsonError();
            this.emit(STRING + [34, 92, 47, 8, 12, 10, 13, 9][decoded]!, this.offset);
          }
        } else if (c === '\\') this.escape = true;
        else if (c === '"') { this.mode = 'plain'; this.emit(34, this.offset); }
        else {
          if (code < 32) throw new ZedJsonError();
          this.emit(STRING + code, this.offset);
        }
        continue;
      }
      if (this.mode === 'literal') {
        if (c !== this.literal[this.literalAt++]) throw new ZedJsonError();
        this.emit(LITERAL + code, this.offset);
        if (this.literalAt === this.literal.length) this.mode = 'plain';
        continue;
      }
      if (this.mode === 'number') {
        let next = '';
        if (this.number === 'minus') next = c === '0' ? 'zero' : c >= '1' && c <= '9' ? 'int' : '';
        else if (this.number === 'zero' || this.number === 'int') {
          next = this.number === 'int' && digit(c) ? 'int' : c === '.' ? 'dot' : /[eE]/.test(c) ? 'e' : '';
        } else if (this.number === 'dot' || this.number === 'frac') {
          next = digit(c) ? 'frac' : this.number === 'frac' && /[eE]/.test(c) ? 'e' : '';
        } else if (this.number === 'e') next = c === '+' || c === '-' ? 'sign' : digit(c) ? 'exp' : '';
        else if (this.number === 'sign' || this.number === 'exp') next = digit(c) ? 'exp' : '';
        if (next) { this.number = next; this.emit(NUMBER + code, this.offset); continue; }
        this.numberEnd();
        // The delimiter belongs to the grammar, not to the numeric token.
      }
      if (whitespace(c)) continue;
      const top = this.frames.length - 1;
      const state = this.frames[top];
      if (c === '}' || c === ']') {
        if (c === '}' ? state !== 0 && state !== 4 : state !== 5 && state !== 7) throw new ZedJsonError();
        this.frames.pop();
      } else if (c === ':') {
        if (state !== 2) throw new ZedJsonError();
        this.frames[top] = 3;
      } else if (c === ',') {
        if (state !== 4 && state !== 7) throw new ZedJsonError();
        this.frames[top] = state === 4 ? 1 : 6;
      } else if (c === '"') {
        if (state === 0 || state === 1) this.frames[top] = 2;
        else this.value();
        this.mode = 'string';
      } else {
        this.value();
        if (c === '{' || c === '[') {
          if (this.frames.length > ZED_JSON_MAX_DEPTH) {
            throw new ZedJsonError(`JSON nesting depth limit exceeded (${ZED_JSON_MAX_DEPTH})`);
          }
          this.frames.push(c === '{' ? 0 : 5);
        } else if (c === '-' || digit(c)) {
          this.mode = 'number';
          this.number = c === '-' ? 'minus' : c === '0' ? 'zero' : 'int';
          this.emit(NUMBER + code, this.offset);
          continue;
        } else if (c === 't' || c === 'f' || c === 'n') {
          this.mode = 'literal';
          this.literal = c === 't' ? 'true' : c === 'f' ? 'false' : 'null';
          this.literalAt = 1;
          this.emit(LITERAL + code, this.offset);
          continue;
        } else throw new ZedJsonError();
      }
      this.emit(code, this.offset);
    }
  }

  finish(): void {
    if (this.mode === 'number') this.numberEnd();
    if (this.mode !== 'plain' || this.frames.length !== 1 || this.frames[0] !== 9) throw new ZedJsonError('incomplete JSON');
  }

  get complete(): boolean {
    return this.frames.length === 1 && this.frames[0] === 9
      && (this.mode === 'plain' || (this.mode === 'number' && ['zero', 'int', 'frac', 'exp'].includes(this.number)));
  }

  /** Complete a split escape using the next authoritative decoded string unit. */
  escapeSuffix(token: number | undefined): string | undefined {
    if (!this.escape && !this.unicodeLeft) return '';
    if (token === undefined || token < STRING || token >= NUMBER) return;
    const hex = (token - STRING).toString(16).padStart(4, '0');
    if (this.escape) return 'u' + hex;
    const read = 4 - this.unicodeLeft;
    if (parseInt(hex.slice(0, read) || '0', 16) !== this.unicodeValue) return;
    return hex.slice(read);
  }
}

export function zedJsonTokens(text: string, positions?: Uint32Array): Uint32Array {
  const tokens = new Uint32Array(text.length);
  let length = 0;
  const scanner = new ZedJsonScanner((token, end) => {
    tokens[length] = token;
    if (positions) positions[length] = end;
    length++;
  });
  scanner.push(text);
  scanner.finish();
  return tokens.subarray(0, length);
}
