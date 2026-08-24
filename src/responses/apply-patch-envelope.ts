// Representation repair for top-level Codex apply_patch custom-tool payloads.
//
// Some routed models decorate the first and last lines as
// `*** Begin Patch ***` / `*** End Patch ***`. Codex rejects those otherwise
// valid custom-tool payloads. Repair is deliberately limited to a complete,
// structurally recognizable top-level patch: arbitrary `exec` JavaScript is
// caller-authored executable input and must remain byte-identical.
//
// This is the same intent boundary as `src/lib/tool-argument-integers.ts`:
// repair the one faithful reading, leave genuine patch content alone.

const PATCH_BEGIN = "*** Begin Patch";
const PATCH_END = "*** End Patch";
const TOP_LEVEL_PATCH_ENVELOPE = /^(\*\*\* Begin Patch(?: \*\*\*)?)(\r?\n)([\s\S]*)(\r?\n)(\*\*\* End Patch(?: \*\*\*)?)(\r?\n)?$/;
const PATCH_OPERATION_LINE = /^\*\*\* (?:Add|Update|Delete) File: .+$/m;

/** Unwrap the `{input:string}` function-call wrapper used for freeform tools. */
export function unwrapFreeformToolInput(argumentsText: unknown): string {
  if (typeof argumentsText !== "string") return "";
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const input = (parsed as { input?: unknown }).input;
      if (typeof input === "string") return input;
    }
  } catch {
    // The string is the freeform body, not nested JSON.
  }
  return argumentsText;
}

/**
 * Strip trailing `***` only from the outer lines of one complete patch.
 * Internal patch content, incomplete envelopes, and non-patch text are exact
 * pass-throughs.
 */
export function normalizeApplyPatchDelimiters(text: string): string {
  const match = TOP_LEVEL_PATCH_ENVELOPE.exec(text);
  if (!match) return text;
  const [, begin, beginBreak, body, endBreak, end, trailingBreak = ""] = match;
  if (!PATCH_OPERATION_LINE.test(body)) return text;
  if (begin === PATCH_BEGIN && end === PATCH_END) return text;
  return `${PATCH_BEGIN}${beginBreak}${body}${endBreak}${PATCH_END}${trailingBreak}`;
}

/**
 * Repair freeform input before Codex sees it.
 *
 * Only a bare or reserved-`functions` `apply_patch` payload may receive delimiter
 * repair. Remote namespaces own their grammar; those bodies and every other
 * freeform input are unwrapped and left byte-exact.
 */
export function repairFreeformToolInput(
  argumentsText: unknown,
  toolName = "",
  namespace?: string,
): string {
  const unwrapped = unwrapFreeformToolInput(argumentsText);
  const ownsApplyPatchGrammar = namespace === undefined || namespace === "functions";
  return ownsApplyPatchGrammar && toolName === "apply_patch"
    ? normalizeApplyPatchDelimiters(unwrapped)
    : unwrapped;
}
