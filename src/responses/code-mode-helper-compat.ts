import {
  isCompletePatchEnvelope,
  normalizeApplyPatchDelimiters,
  unwrapFreeformToolInput,
} from "./apply-patch-envelope";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function unwrapPatchInput(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (isPlainObject(parsed)) {
      if (typeof parsed.input === "string") return parsed.input;
      if (typeof parsed.patch === "string") return parsed.patch;
    }
  } catch {
    // Native custom calls carry the patch body directly.
  }
  return value;
}

/**
 * Convert a nested Code Mode helper call into unified-exec JavaScript.
 *
 * Parsed values are serialized as data, never interpolated as source, so command and patch text
 * cannot escape the generated call. Invalid structured helper payloads are also passed as data so
 * nested-tool validation can reject them without evaluating provider text as JavaScript.
 */
export function compileCodeModeHelperInput(argumentsText: unknown, toolName: string): string {
  if (typeof argumentsText !== "string") return "";
  if (toolName === "apply_patch") {
    const patch = normalizeApplyPatchDelimiters(unwrapPatchInput(argumentsText));
    return `const result = await tools.apply_patch(${JSON.stringify(patch)});\ntext(result);`;
  }
  let parsed: unknown = argumentsText;
  try {
    parsed = JSON.parse(argumentsText);
  } catch {
    // Keep malformed provider text as data rather than executable source.
  }
  const args: unknown = isPlainObject(parsed) ? { ...parsed } : parsed;
  if (
    toolName === "shell_command"
    && isPlainObject(args)
    && typeof args.command === "string"
    && args.cmd === undefined
  ) {
    args.cmd = args.command;
    delete args.command;
  }
  if (toolName === "write_stdin") {
    return `const result = await tools.write_stdin(${JSON.stringify(args)});\ntext(result);`;
  }
  return `const result = await tools.exec_command(${JSON.stringify(args)});\ntext(result);`;
}

/**
 * Resolve the effective code-mode helper for one freeform call.
 *
 * `codeModeHelperName` already covers the NAME-based case: a provider emitted
 * `apply_patch` under a declared `exec` catalog, so `normalizeDeclaredToolName` rewrote
 * the name and recorded the original. That decision happens at tool-call start, before
 * any arguments exist, so it cannot see a provider that got the NAME right and the BODY
 * wrong.
 *
 * This adds that second case: the name is already `exec` so nothing was rewritten, but
 * the body is a complete patch envelope and therefore cannot be the JavaScript that
 * `exec` runs. Same inference the name-based path makes, drawn from the payload.
 *
 * Returns undefined for everything else, including JavaScript that merely mentions a
 * patch envelope — that body is a real program and is forwarded byte-identical.
 */
export function resolveCodeModeHelperName(
  codeModeHelperName: string | undefined,
  toolName: string,
  argumentsText: unknown,
  namespace?: string,
): string | undefined {
  if (codeModeHelperName) return codeModeHelperName;
  if (toolName !== "exec" || namespace !== undefined) return undefined;
  if (typeof argumentsText !== "string" || argumentsText === "") return undefined;
  return isCompletePatchEnvelope(unwrapFreeformToolInput(argumentsText)) ? "apply_patch" : undefined;
}
