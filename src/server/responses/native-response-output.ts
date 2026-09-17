import { nativeResponseFingerprint as injectionFingerprint, nativeResponseRecord as record } from "./native-response-json";
type Frame = Record<string, unknown>;

/**
 * Preserve completed wire items missing from a sparse terminal, including hosted
 * tool results and encrypted agent messages. Shared IDs must retain content and
 * relative order; conflicting transcripts fail instead of silently losing data.
 */
export function nativeResponseOutput(done: ReadonlyMap<number, Frame>, terminal: unknown): Frame[] {
  const observed = [...done.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
  if (terminal == null || (Array.isArray(terminal) && !terminal.length)) return observed;
  if (!Array.isArray(terminal) || terminal.some(item => !record(item))) throw new Error("Invalid native response output.");
  const identity = (item: Frame) => typeof item.id === "string" ? `id:${item.id}` : `body:${injectionFingerprint(item)}`;
  const positions = new Map<string, number>();
  observed.forEach((item, index) => {
    const key = identity(item);
    if (positions.has(key)) throw new Error("Duplicate native completed output identity.");
    positions.set(key, index);
  });
  const result: Frame[] = [];
  const seen = new Set<string>();
  let cursor = 0;
  for (const item of terminal as Frame[]) {
    const key = identity(item);
    if (seen.has(key)) throw new Error("Duplicate native terminal output identity.");
    seen.add(key);
    const position = positions.get(key);
    if (position === undefined) { result.push(item); continue; }
    if (position < cursor || injectionFingerprint(item) !== injectionFingerprint(observed[position])) {
      throw new Error("Native terminal output contradicts completed wire items.");
    }
    while (cursor < position) result.push(observed[cursor++]);
    result.push(item); cursor++;
  }
  while (cursor < observed.length) result.push(observed[cursor++]);
  return result;
}
