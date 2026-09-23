/** Lossless physical TOML lines with lexical structural boundaries. */
export interface SourceLine {
  text: string;
  eol: "\r\n" | "\n" | "";
  /** False when this physical line began inside a TOML multiline string. */
  structural: boolean;
}


export function splitSourceLines(content: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let offset = 0;
  while (offset < content.length) {
    const lf = content.indexOf("\n", offset);
    if (lf === -1) {
      lines.push({ text: content.slice(offset), eol: "", structural: true });
      break;
    }
    const crlf = lf > offset && content[lf - 1] === "\r";
    lines.push({
      text: content.slice(offset, crlf ? lf - 1 : lf),
      eol: crlf ? "\r\n" : "\n",
      structural: true,
    });
    offset = lf + 1;
  }
  markStructuralLines(lines);
  return lines;
}

type MultilineStringKind = "basic" | "literal" | null;

/**
 * TOML table-looking text inside a multiline string is data, not syntax. Keep
 * a deliberately small lexical state machine so the format-preserving editor
 * never treats those physical lines as headers, keys, or ownership markers.
 */
function markStructuralLines(lines: SourceLine[]): void {
  let multiline: MultilineStringKind = null;
  let squareDepth = 0;
  let curlyDepth = 0;

  for (const line of lines) {
    line.structural = multiline === null && squareDepth === 0 && curlyDepth === 0;
    let single: "basic" | "literal" | null = null;

    for (let index = 0; index < line.text.length;) {
      if (multiline === "basic") {
        if (line.text.startsWith('"""', index)) {
          multiline = null;
          index += 3;
        } else if (line.text[index] === "\\") {
          index += 2;
        } else {
          index += 1;
        }
        continue;
      }
      if (multiline === "literal") {
        if (line.text.startsWith("'''", index)) {
          multiline = null;
          index += 3;
        } else {
          index += 1;
        }
        continue;
      }
      if (single === "basic") {
        if (line.text[index] === "\\") index += 2;
        else if (line.text[index] === '"') {
          single = null;
          index += 1;
        } else index += 1;
        continue;
      }
      if (single === "literal") {
        if (line.text[index] === "'") single = null;
        index += 1;
        continue;
      }

      if (line.text[index] === "#") break;
      if (line.text.startsWith('"""', index)) {
        multiline = "basic";
        index += 3;
      } else if (line.text.startsWith("'''", index)) {
        multiline = "literal";
        index += 3;
      } else if (line.text[index] === '"') {
        single = "basic";
        index += 1;
      } else if (line.text[index] === "'") {
        single = "literal";
        index += 1;
      } else if (line.text[index] === "[") {
        squareDepth += 1;
        index += 1;
      } else if (line.text[index] === "]") {
        squareDepth = Math.max(0, squareDepth - 1);
        index += 1;
      } else if (line.text[index] === "{") {
        curlyDepth += 1;
        index += 1;
      } else if (line.text[index] === "}") {
        curlyDepth = Math.max(0, curlyDepth - 1);
        index += 1;
      } else {
        index += 1;
      }
    }
  }
}
