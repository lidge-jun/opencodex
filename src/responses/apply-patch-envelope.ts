// Representation repair for top-level Codex apply_patch custom-tool payloads.
//
// Some routed models decorate the first and last lines as
// `*** Begin Patch ***` / `*** End Patch ***`. Codex rejects those otherwise
// valid custom-tool payloads. Repair of executable bodies is deliberately limited to
// unambiguous wrapper mistakes: one recognized alternate field or one complete outer
// Markdown fence. Ordinary `exec` JavaScript remains byte-identical.
//
// This is the same intent boundary as `src/lib/tool-argument-integers.ts`:
// repair the one faithful reading, leave genuine patch content alone.
//
// One accepted exception, added 2026-09-05: a body that is ITSELF one complete
// operation-bearing envelope, submitted as the `exec` body. That shape is never valid
// JavaScript — `*** Begin Patch` fails to parse at the leading `**` — so it has zero
// executable readings and exactly one faithful one. `isCompletePatchEnvelope` recognizes
// it and the CALLERS retarget it to the apply_patch helper; the repair functions here are
// unchanged and still return every exec body byte-identical. JavaScript that merely
// mentions an envelope keeps a real executable reading and is left alone.
// See devlog/_plan/260905_apply_patch_envelope_gap.

const PATCH_BEGIN = "*** Begin Patch";
const PATCH_END = "*** End Patch";
const TOP_LEVEL_PATCH_ENVELOPE = /^(\*\*\* Begin Patch(?: \*\*\*)?)(\r?\n)([\s\S]*)(\r?\n)(\*\*\* End Patch(?: \*\*\*)?)(\r?\n)?$/;
const PATCH_OPERATION_LINE = /^\*\*\* (?:Add|Update|Delete) File: .+$/m;
const OUTER_MARKDOWN_CODE_FENCE = /^```[^\r\n]*\r?\n([\s\S]*?)\r?\n```$/;
const FREEFORM_FALLBACK_KEYS: Readonly<Record<string, readonly string[]>> = {
  exec: ["code", "script", "js", "javascript", "command", "cmd", "content"],
  apply_patch: ["patch", "content"],
};

/** The field names a tool's freeform wrapper may unwrap through, besides canonical `input`. */
export function freeformFallbackKeys(toolName: string): readonly string[] {
  return FREEFORM_FALLBACK_KEYS[toolName] ?? [];
}

function stripMarkdownCodeFence(text: string, toolName: string): string {
  if (toolName !== "exec" && toolName !== "apply_patch") return text;
  const match = OUTER_MARKDOWN_CODE_FENCE.exec(text.trim());
  return match ? match[1] : text;
}

/** Unwrap the `{input:string}` function-call wrapper used for freeform tools. */
export function unwrapFreeformToolInput(argumentsText: unknown, toolName = ""): string {
  if (typeof argumentsText !== "string") return "";
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(record, "input")) {
        return typeof record.input === "string"
          ? stripMarkdownCodeFence(record.input, toolName)
          : argumentsText;
      }
      const fallbackKeys = freeformFallbackKeys(toolName);
      const candidates = fallbackKeys.filter(key => typeof record[key] === "string");
      if (candidates.length === 1) {
        return stripMarkdownCodeFence(record[candidates[0]] as string, toolName);
      }
    }
  } catch {
    // The string is the freeform body, not nested JSON.
  }
  return stripMarkdownCodeFence(argumentsText, toolName);
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
 * True when a body is one COMPLETE top-level patch envelope carrying a real file
 * operation.
 *
 * A code-mode `exec` body is JavaScript, and this shape is never valid JavaScript: a
 * leading `*** Begin Patch` fails to parse at the `**`. So a body satisfying this
 * predicate cannot be a program the caller meant to run, which is what makes reading it
 * as an apply_patch call the one faithful reading rather than a guess.
 *
 * Deliberately strict, and reusing the same two checks `normalizeApplyPatchDelimiters`
 * uses: a second, looser notion of "looks like a patch" is how a repair boundary drifts.
 * JavaScript that merely CONTAINS an envelope in a string, template, or comment fails the
 * anchored match and is left alone.
 */
export function isCompletePatchEnvelope(text: string): boolean {
  const match = TOP_LEVEL_PATCH_ENVELOPE.exec(text);
  if (!match) return false;
  return PATCH_OPERATION_LINE.test(match[3] ?? "");
}

/**
 * True when a PARTIAL buffer could still grow into a complete patch envelope.
 *
 * Streaming decides per delta, before the body is complete, while
 * `isCompletePatchEnvelope` can only answer once it is. Without this the bridge would
 * stream raw envelope bytes and then replace them with compiled helper JavaScript at
 * completion — the rewind that path explicitly refuses to perform.
 *
 * Deliberately one-sided: it holds a buffer that MIGHT become an envelope and never
 * claims one will. A held buffer that turns out to be something else still reaches the
 * client in the authoritative completed item; only the live preview is skipped.
 */
export function mayBecomePatchEnvelope(text: string): boolean {
  if (text === "") return false;
  return text.startsWith(PATCH_BEGIN) || PATCH_BEGIN.startsWith(text);
}

/**
 * Repair freeform input before Codex sees it.
 *
 * Only a bare or reserved-`functions` tool may receive fallback-field or outer-fence
 * repair, and only `apply_patch` may receive delimiter repair. Remote namespaces own
 * their grammar; those bodies and every other freeform input are unwrapped and left
 * byte-exact.
 */
export function repairFreeformToolInput(
  argumentsText: unknown,
  toolName = "",
  namespace?: string,
): string {
  const ownsApplyPatchGrammar = namespace === undefined || namespace === "functions";
  const unwrapped = unwrapFreeformToolInput(argumentsText, ownsApplyPatchGrammar ? toolName : "");
  return ownsApplyPatchGrammar && toolName === "apply_patch"
    ? normalizeApplyPatchDelimiters(unwrapped)
    : unwrapped;
}
