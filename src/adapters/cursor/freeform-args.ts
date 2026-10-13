import { freeformFallbackKeys } from "../../responses/apply-patch-envelope";

/**
 * Pre-emission gate for Cursor calls to request-declared freeform tools (#7049).
 *
 * Cursor carries a freeform body as a JSON object, and the canonical shape is `{input:string}`.
 * Claude models routed through Cursor also name the body after its content — `{"code": "..."}`
 * for the code-mode `exec` cell — and the shared Responses repair downstream already unwraps
 * exactly that (`unwrapFreeformToolInput`: no `input` key, ONE string-valued fallback key).
 * This gate used to accept only `input`, so it turned a payload the bridge knows how to read
 * into a fatal adapter error before any host execution. It now applies the same single faithful
 * reading and re-emits it canonically; anything ambiguous or non-string still fails closed.
 *
 * A canonical wrapper is returned byte-identical. Only the repaired shape is re-serialized.
 */
export type CursorFreeformArgs =
  | { ok: true; args: string }
  | { ok: false; reason: string };

/**
 * The only key names a diagnostic may print. They are constants written here, so the error can
 * never carry request-derived text: a model can put body text or an identifier in key position,
 * and the message is persisted to request logs. Every other key is counted, not named.
 */
const NAMEABLE_KEYS: ReadonlySet<string> = new Set([
  "input",
  "code", "script", "js", "javascript", "command", "cmd", "content", "patch",
  "source", "program", "body", "text", "args", "arguments",
]);
const MAX_LISTED_KEYS = 8;

function valueKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Shape-only description of a rejected wrapper: allowlisted key names with their value kinds,
 * then a count of every other key. Never values, never an unlisted key name.
 */
function describeKeys(record: Record<string, unknown>): string {
  const keys = Object.keys(record);
  if (keys.length === 0) return "received an empty object";
  const listed = keys.filter(key => NAMEABLE_KEYS.has(key))
    .slice(0, MAX_LISTED_KEYS)
    .map(key => `${key}:${valueKind(record[key])}`);
  const hidden = keys.length - listed.length;
  if (hidden > 0) listed.push(`+${hidden} other`);
  return `received keys [${listed.join(", ")}]`;
}

export function canonicalCursorFreeformArgs(args: string, toolName: string): CursorFreeformArgs {
  if (args.length === 0) return { ok: false, reason: "received no arguments" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return { ok: false, reason: "received arguments that are not JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: `received a JSON ${valueKind(parsed)}` };
  }
  const record = parsed as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, "input")) {
    return typeof record.input === "string"
      ? { ok: true, args }
      : { ok: false, reason: `input was ${valueKind(record.input)}` };
  }
  const candidates = freeformFallbackKeys(toolName).filter(key => typeof record[key] === "string");
  if (candidates.length === 1) {
    return { ok: true, args: JSON.stringify({ input: record[candidates[0]] as string }) };
  }
  return { ok: false, reason: describeKeys(record) };
}
