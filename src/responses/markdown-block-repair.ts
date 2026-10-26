/**
 * Closes unclosed markdown code fences and common paired markup in text that was cut short
 * by token limit truncation (max_output_tokens).
 */
export function closeOpenMarkdownBlocks(text: string): string {
  if (!text) return text;
  let repaired = text;

  // 1. Close unclosed code fences (``` or ~~~)
  const fenceRegex = /(?:^|\n)(```+|~~~+)[^\n]*(?:\n|$)/g;
  const fences: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(text)) !== null) {
    const marker = match[1].slice(0, 3);
    if (fences.length > 0 && fences[fences.length - 1] === marker) {
      fences.pop();
    } else {
      fences.push(marker);
    }
  }
  if (fences.length > 0) {
    if (!repaired.endsWith("\n")) repaired += "\n";
    for (let i = fences.length - 1; i >= 0; i--) {
      repaired += `${fences[i]}\n`;
    }
  }

  // 2. Close common unclosed paired tags if opened
  for (const tag of ["details", "thought"]) {
    const openCount = (repaired.match(new RegExp(`<${tag}(?:\\s[^>]*)?>`, "gi")) || []).length;
    const closeCount = (repaired.match(new RegExp(`</${tag}>`, "gi")) || []).length;
    if (openCount > closeCount) {
      if (!repaired.endsWith("\n")) repaired += "\n";
      repaired += `</${tag}>\n`.repeat(openCount - closeCount);
    }
  }

  return repaired;
}
