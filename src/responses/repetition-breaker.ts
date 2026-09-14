/**
 * Collapse repeated assistant output before it is replayed to an upstream model.
 *
 * A degenerate generation may contain the same line or short paragraph hundreds of
 * times. Sending that history back verbatim primes the next generation to continue
 * the run. The client still receives the original response; this only changes the
 * history used for a later request.
 */
const MIN_REPETITIONS = 3;
const MAX_CYCLE_LINES = 20_000;
const MAX_CYCLE_PERIOD = 64;

const marker = (count: number): string => `[ocx: repeated ${count} times in source output]`;

function collapseConsecutiveLines(lines: string[]): string[] {
  const out: string[] = [];
  for (let start = 0; start < lines.length;) {
    const line = lines[start]!;
    let end = start + 1;
    while (end < lines.length && lines[end] === line) end += 1;
    const count = end - start;
    if (line.trim().length > 0 && count >= MIN_REPETITIONS) {
      out.push(line, marker(count));
    } else {
      out.push(...lines.slice(start, end));
    }
    start = end;
  }
  return out;
}

function collapseWholeMessageCycle(lines: string[]): string[] {
  if (lines.length > MAX_CYCLE_LINES) return lines;
  const maxPeriod = Math.min(MAX_CYCLE_PERIOD, Math.floor(lines.length / MIN_REPETITIONS));
  for (let period = 1; period <= maxPeriod; period += 1) {
    const count = Math.floor(lines.length / period);
    const block = lines.slice(0, period);
    if (block.every(line => line.trim().length === 0)) continue;
    const repeatedLength = count * period;
    if (
      lines.slice(0, repeatedLength).every((line, index) => line === block[index % period])
      && lines.slice(repeatedLength).every((line, index) => line === block[index])
    ) {
      return [...block, marker(count), ...lines.slice(repeatedLength)];
    }
  }
  return lines;
}

export function collapseRepeatedOutput(text: string): string {
  if (text.length === 0) return text;
  const hasTerminalNewline = text.endsWith("\n");
  const lines = (hasTerminalNewline ? text.slice(0, -1) : text).split("\n");
  const collapsed = collapseConsecutiveLines(lines);
  return `${collapseWholeMessageCycle(collapsed).join("\n")}${hasTerminalNewline ? "\n" : ""}`;
}
