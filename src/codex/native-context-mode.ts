/** Root Codex settings published for the explicit GPT-5.6 1M opt-in. */
export const NATIVE_GPT56_ONE_MILLION_CONTEXT_WINDOW = 1_000_000;
export const NATIVE_GPT56_ONE_MILLION_AUTO_COMPACT_LIMIT = 900_000;
export const MANAGED_NATIVE_CONTEXT_MARKER = "# Managed by opencodex: native GPT-5.6 1M context";

const TARGETS = {
  model_context_window: NATIVE_GPT56_ONE_MILLION_CONTEXT_WINDOW,
  model_auto_compact_token_limit: NATIVE_GPT56_ONE_MILLION_AUTO_COMPACT_LIMIT,
} as const;

type TargetKey = keyof typeof TARGETS;

export type ManagedNativeContextTransformResult =
  | { ok: true; changed: boolean; content: string }
  | { ok: false; changed: false; content: string; error: string };

function fail(content: string, error: string): ManagedNativeContextTransformResult {
  return { ok: false, changed: false, content, error };
}

function targetAssignment(line: string): { key: TargetKey; value: number } | null {
  const match = line.match(/^\s*(model_context_window|model_auto_compact_token_limit)\s*=\s*(\d+)\s*(?:#.*)?$/);
  if (!match) return null;
  return { key: match[1] as TargetKey, value: Number(match[2]) };
}

function rootNumericValue(
  lines: readonly string[],
  key: TargetKey,
): { ok: true; value: number | undefined } | { ok: false; error: string } {
  const firstTable = lines.findIndex(line => /^\s*\[/.test(line));
  const root = lines.slice(0, firstTable === -1 ? lines.length : firstTable);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const assignment = new RegExp(`^\\s*(?:${escaped}|"${escaped}"|'${escaped}')\\s*=`);
  const matches = root.filter(line => assignment.test(line));
  if (matches.length > 1) return { ok: false, error: `duplicate user-owned ${key} cannot be updated safely` };
  if (matches.length === 0) return { ok: true, value: undefined };
  try {
    const parsed = Bun.TOML.parse(matches[0]!) as Record<string, unknown>;
    const value = parsed[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      return { ok: false, error: `user-owned ${key} must be an integer` };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, error: `user-owned ${key} is not valid TOML` };
  }
}

/**
 * Add or remove only marker-owned root settings. User-owned compaction policy is never
 * overwritten: an exact 900k value can satisfy the mode as-is, while any other value makes
 * enable fail closed. Callers retain the historical root context-window stripping separately.
 */
export function transformManagedNativeContextMode(
  input: string,
  enabled: boolean,
): ManagedNativeContextTransformResult {
  const eol = input.includes("\r\n") ? "\r\n" : "\n";
  const content = input.replace(/\r\n/g, "\n");
  const lines = content.split("\n");
  const firstTable = lines.findIndex(line => /^\s*\[/.test(line));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  const owned = new Map<TargetKey, number>();

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]!.trim() !== MANAGED_NATIVE_CONTEXT_MARKER) continue;
    if (index >= rootEnd) return fail(input, "managed native context marker is not at the TOML root");
    const assignment = targetAssignment(lines[index + 1] ?? "");
    if (!assignment || index + 1 >= rootEnd) {
      return fail(input, "orphaned managed native context marker cannot be updated safely");
    }
    if (owned.has(assignment.key)) {
      return fail(input, `duplicate managed ${assignment.key} cannot be updated safely`);
    }
    if (assignment.value !== TARGETS[assignment.key]) {
      return fail(input, `managed ${assignment.key} has an unexpected value`);
    }
    owned.set(assignment.key, index);
    index += 1;
  }

  const removals = [...owned.values()].sort((a, b) => b - a);
  for (const index of removals) lines.splice(index, 2);

  if (enabled) {
    const nextFirstTable = lines.findIndex(line => /^\s*\[/.test(line));
    const userContext = rootNumericValue(lines, "model_context_window");
    if (!userContext.ok) return fail(input, userContext.error);
    if (userContext.value !== undefined) {
      return fail(input, "user-owned model_context_window must be normalized before enabling 1M mode");
    }
    const userCompact = rootNumericValue(lines, "model_auto_compact_token_limit");
    if (!userCompact.ok) return fail(input, userCompact.error);
    if (userCompact.value !== undefined
      && userCompact.value !== NATIVE_GPT56_ONE_MILLION_AUTO_COMPACT_LIMIT) {
      return fail(input, "user-owned model_auto_compact_token_limit conflicts with the 1M mode");
    }

    const block = [
      MANAGED_NATIVE_CONTEXT_MARKER,
      `model_context_window = ${NATIVE_GPT56_ONE_MILLION_CONTEXT_WINDOW}`,
      ...(userCompact.value === NATIVE_GPT56_ONE_MILLION_AUTO_COMPACT_LIMIT ? [] : [
        MANAGED_NATIVE_CONTEXT_MARKER,
        `model_auto_compact_token_limit = ${NATIVE_GPT56_ONE_MILLION_AUTO_COMPACT_LIMIT}`,
      ]),
    ];
    let insertAt = nextFirstTable === -1 ? lines.length : nextFirstTable;
    while (insertAt > 0 && lines[insertAt - 1]!.trim() === "") insertAt -= 1;
    lines.splice(insertAt, 0, ...block);
  }

  let output = lines.join("\n");
  if (eol === "\r\n") output = output.replace(/\n/g, "\r\n");
  return { ok: true, changed: output !== input, content: output };
}
