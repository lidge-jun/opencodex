/**
 * Keyless Zen tier tool-declaration gate (`opencode-free`).
 *
 * Provenance — measured live against `https://opencode.ai/zen/v1` on
 * 2026-09-26 with the anonymous identity from `./opencode-free-session.ts`:
 *
 * - A turn with no `tools` at all is refused (`FreeTierError`).
 * - A turn declaring only `exec`/`wait` (Codex 0.153.x) is refused.
 * - A turn declaring `shell` alone, `read` alone, or `bash` alone is refused.
 * - A turn declaring `shell`+`read`, `bash`+`read`, or `shell`+`read`+`exec`
 *   streams. Capitalized `Bash`+`Read` (Claude-style) is refused: matching is
 *   case-sensitive lowercase.
 * - A `web_search` tool alongside the pair is fine; it is not the tripwire.
 * - The full Codex wire body (22k instructions, environment context,
 *   `prompt_cache_key`, `client_metadata`, plugin catalogs) streams once the
 *   pair is present, so declarations are the sole remaining blocker.
 *
 * The "never invoke" declaration wording below follows OpenCode's own
 * precedent for compatibility-only tools: `packages/opencode/src/session/
 * llm.ts` injects a `_noop` tool ("Do not call this tool. It exists only for
 * API compatibility and must never be invoked.") when a proxy in the path
 * requires a tools array the turn would otherwise omit.
 *
 * The declarations satisfy admission, not execution. If the model calls one
 * anyway, the provider compatibility response hook suppresses that synthetic
 * call and emits the guidance below. A client-declared tool with the same name
 * is never synthetic and flows through unchanged.
 */

import type { CompatibilityFunctionTool } from "./provider-compatibility";

/** OpenCode's compatibility-only wording, reused verbatim. */
export const ZEN_FREE_GATE_DECLARATION =
  "Do not call this tool. It exists only for API compatibility and must never be invoked.";

/** Guidance that keeps a mistaken compatibility-tool call from killing the turn. */
export function zenFreeGateGuidanceText(callName: string, callerNames: readonly string[]): string {
  const alternatives = callerNames.filter(name => name !== callName).slice(0, 4);
  const instead = alternatives.length === 0
    ? "Use one of this turn's other declared tools instead."
    : alternatives.length === 1
      ? `Use \`${alternatives[0]}\` instead.`
      : `Use one of ${alternatives.map(name => `\`${name}\``).join(", ")} instead.`;
  return `The \`${callName}\` tool is declared but cannot be executed in this session. ${instead}`;
}

/** Declarations required by Zen; the shared profile layer supplies each wire shape. */
export const ZEN_FREE_GATE_TOOLS: readonly CompatibilityFunctionTool[] = [
  {
    name: "shell",
    satisfiedBy: ["shell", "bash"],
    description: ZEN_FREE_GATE_DECLARATION,
    parameters: { type: "object", properties: {} },
  },
  {
    name: "read",
    description: ZEN_FREE_GATE_DECLARATION,
    parameters: { type: "object", properties: {} },
  },
];
