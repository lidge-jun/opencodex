type ProofNode =
  | { kind: "alternate"; branches: ProofNode[] }
  | { kind: "literal"; foldCase: boolean; value: string }
  | { kind: "repeat"; child: ProofNode; min: number }
  | { kind: "sequence"; children: ProofNode[] }
  | { kind: "unknown" };

const UNKNOWN: ProofNode = { kind: "unknown" };
const REGEX_META = new Set(["(", ")", "[", "]", "{", "}", "*", "+", "?", "|", ".", "^", "$"]);
const ESCAPED_CLASSES = new Set(["A", "B", "D", "P", "S", "W", "b", "d", "p", "s", "w", "z"]);
const ESCAPED_CONTROLS = new Map<string, string>([
  ["a", "\u0007"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["v", "\v"],
]);

class Re2ProofParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): ProofNode | undefined {
    const node = this.parseExpression(undefined, false);
    return node && this.index === this.source.length ? node : undefined;
  }

  private parseExpression(stop: string | undefined, inheritedFoldCase: boolean): ProofNode | undefined {
    const flagState = this.readLeadingFlags(inheritedFoldCase);
    if (!flagState) return undefined;
    const branches: ProofNode[] = [];
    for (;;) {
      const sequence = this.parseSequence(stop, flagState.foldCase);
      if (!sequence) return undefined;
      branches.push(sequence);
      if (this.peek() !== "|") break;
      this.index += 1;
    }
    if (stop !== undefined) {
      if (this.peek() !== stop) return undefined;
      this.index += 1;
    }
    return branches.length === 1 ? branches[0] : { kind: "alternate", branches };
  }

  private parseSequence(stop: string | undefined, foldCase: boolean): ProofNode | undefined {
    const children: ProofNode[] = [];
    while (this.index < this.source.length) {
      const current = this.peek();
      if (current === "|" || current === stop) break;
      const atom = this.parseAtom(foldCase);
      if (!atom) return undefined;
      this.append(children, this.applyQuantifier(atom));
    }
    return children.length === 1 ? children[0] : { kind: "sequence", children };
  }

  private parseAtom(foldCase: boolean): ProofNode | undefined {
    const current = this.peek();
    if (current === "(") return this.parseGroup(foldCase);
    if (current === "[") return this.consumeCharacterClass() ? UNKNOWN : undefined;
    if (current === "\\") return this.parseEscape(foldCase);
    if (current === "." || current === "^" || current === "$") {
      this.index += 1;
      return UNKNOWN;
    }
    if (current === undefined || REGEX_META.has(current)) return undefined;
    this.index += 1;
    return { kind: "literal", foldCase, value: current };
  }

  private parseGroup(inheritedFoldCase: boolean): ProofNode | undefined {
    this.index += 1;
    if (this.peek() !== "?") return this.parseExpression(")", inheritedFoldCase);
    this.index += 1;
    if (this.consume(":")) return this.parseExpression(")", inheritedFoldCase);

    const scopedFlags = this.readFlagSpec();
    if (scopedFlags) {
      if (!this.consume(":")) return undefined;
      return this.parseExpression(")", scopedFlags.apply(inheritedFoldCase));
    }

    if (this.consume("P<") || this.consume("<")) {
      const end = this.source.indexOf(">", this.index);
      if (end < 0) return undefined;
      this.index = end + 1;
      return this.parseExpression(")", inheritedFoldCase);
    }
    return undefined;
  }

  private parseEscape(foldCase: boolean): ProofNode | undefined {
    this.index += 1;
    const escaped = this.peek();
    if (escaped === undefined) return undefined;
    this.index += 1;
    if (ESCAPED_CLASSES.has(escaped) || /[0-9]/.test(escaped)) return UNKNOWN;
    const control = ESCAPED_CONTROLS.get(escaped);
    if (control !== undefined) return { kind: "literal", foldCase, value: control };
    if (escaped === "Q") {
      const end = this.source.indexOf("\\E", this.index);
      if (end < 0) return undefined;
      const value = this.source.slice(this.index, end);
      this.index = end + 2;
      return { kind: "literal", foldCase, value };
    }
    if (escaped === "x") {
      const value = this.readHexEscape();
      return value === undefined ? undefined : { kind: "literal", foldCase, value };
    }
    if (escaped === "u") {
      const value = this.readFixedHex(4);
      return value === undefined ? undefined : { kind: "literal", foldCase, value };
    }
    if (escaped === "c") {
      const control = this.peek();
      if (!control || !/[A-Za-z]/.test(control)) return undefined;
      this.index += 1;
      return { kind: "literal", foldCase, value: String.fromCodePoint(control.toUpperCase().codePointAt(0)! % 32) };
    }
    return { kind: "literal", foldCase, value: escaped };
  }

  private readHexEscape(): string | undefined {
    if (this.consume("{")) {
      const end = this.source.indexOf("}", this.index);
      if (end < 0) return undefined;
      const hex = this.source.slice(this.index, end);
      if (!/^[0-9A-Fa-f]{1,6}$/.test(hex)) return undefined;
      this.index = end + 1;
      return this.codePoint(Number.parseInt(hex, 16));
    }
    const hex = this.source.slice(this.index, this.index + 2);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return undefined;
    this.index += 2;
    return this.codePoint(Number.parseInt(hex, 16));
  }

  private readFixedHex(length: number): string | undefined {
    const hex = this.source.slice(this.index, this.index + length);
    if (hex.length !== length || !/^[0-9A-Fa-f]+$/.test(hex)) return undefined;
    this.index += length;
    return this.codePoint(Number.parseInt(hex, 16));
  }

  private codePoint(value: number): string | undefined {
    if (!Number.isInteger(value) || value < 0 || value > 0x10FFFF || (value >= 0xD800 && value <= 0xDFFF)) {
      return undefined;
    }
    return String.fromCodePoint(value);
  }

  private consumeCharacterClass(): boolean {
    this.index += 1;
    let escaped = false;
    while (this.index < this.source.length) {
      const current = this.source[this.index++]!;
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === "]") {
        return true;
      }
    }
    return false;
  }

  private applyQuantifier(atom: ProofNode): ProofNode {
    const current = this.peek();
    let min: number | undefined;
    if (current === "*" || current === "?") {
      min = 0;
      this.index += 1;
    } else if (current === "+") {
      min = 1;
      this.index += 1;
    } else if (current === "{") {
      const match = this.source.slice(this.index).match(/^\{(\d+)(?:,(\d*)?)?\}/);
      if (match) {
        min = Number.parseInt(match[1]!, 10);
        this.index += match[0].length;
      }
    }
    if (min === undefined) return atom;
    if (this.peek() === "?") this.index += 1;
    return { kind: "repeat", child: atom, min };
  }

  private readLeadingFlags(inheritedFoldCase: boolean): { foldCase: boolean } | undefined {
    let foldCase = inheritedFoldCase;
    for (;;) {
      const checkpoint = this.index;
      if (!this.consume("(?")) break;
      const flags = this.readFlagSpec();
      if (!flags || !this.consume(")")) {
        this.index = checkpoint;
        break;
      }
      foldCase = flags.apply(foldCase);
    }
    return { foldCase };
  }

  private readFlagSpec(): { apply(current: boolean): boolean } | undefined {
    const match = this.source.slice(this.index).match(/^([imsU]*)(?:-([imsU]*))?/);
    if (!match || match[0].length === 0) return undefined;
    this.index += match[0].length;
    const enabled = match[1] ?? "";
    const disabled = match[2] ?? "";
    return {
      apply(current: boolean): boolean {
        if (disabled.includes("i")) return false;
        if (enabled.includes("i")) return true;
        return current;
      },
    };
  }

  private append(children: ProofNode[], node: ProofNode): void {
    const previous = children.at(-1);
    if (previous?.kind === "literal" && node.kind === "literal" && previous.foldCase === node.foldCase) {
      previous.value += node.value;
      return;
    }
    children.push(node);
  }

  private consume(value: string): boolean {
    if (!this.source.startsWith(value, this.index)) return false;
    this.index += value.length;
    return true;
  }

  private peek(): string | undefined {
    return this.source[this.index];
  }
}

function foldSafeForToLower(value: string, foldCase: boolean): boolean {
  if (!foldCase) return true;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint > 0x7F) return false;
    const lower = character.toLowerCase();
    if (lower === "k" || lower === "s") return false;
  }
  return true;
}

function guaranteesKeyword(node: ProofNode, keywords: readonly string[]): boolean {
  if (node.kind === "literal") {
    if (!foldSafeForToLower(node.value, node.foldCase)) return false;
    const literal = node.value.toLowerCase();
    return keywords.some(keyword => literal.includes(keyword));
  }
  if (node.kind === "sequence") {
    return node.children.some(child => guaranteesKeyword(child, keywords));
  }
  if (node.kind === "alternate") {
    return node.branches.length > 0 && node.branches.every(branch => guaranteesKeyword(branch, keywords));
  }
  if (node.kind === "repeat") {
    return node.min > 0 && guaranteesKeyword(node.child, keywords);
  }
  return false;
}

/**
 * Return lowercased keywords only when the RE2 source proves that every match
 * contains at least one of them. Unsupported syntax is deliberately ineligible:
 * false negatives cost scanner work, while a false positive would lose recall.
 */
export function provenGuardrailsPrefilterKeywords(
  regex: string,
  keywords: readonly string[],
): readonly string[] {
  if (keywords.length === 0) return [];
  const lowered = keywords.map(keyword => keyword.toLowerCase());
  const parsed = new Re2ProofParser(regex).parse();
  return parsed && guaranteesKeyword(parsed, lowered) ? lowered : [];
}
