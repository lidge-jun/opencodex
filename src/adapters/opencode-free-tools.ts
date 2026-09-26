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
 * Limits, stated plainly: the declarations satisfy admission, not execution.
 * If the model calls one instead of the client's own tools, the client
 * answers "unknown tool" and the turn fails visibly. There is no call
 * translation (a `shell` JSON call cannot be faithfully rewritten into the
 * client's native tool surface generically), so the wording steers the model
 * to the catalog it already has.
 */

import type { OcxProviderConfig } from "../types";
import { isZenFreeEndpoint, zenFreeHasApiKey } from "./opencode-free-session";

export type ZenFreeGateToolName = "shell" | "read";

/** OpenCode's compatibility-only wording, reused verbatim. */
export const ZEN_FREE_GATE_DECLARATION =
  "Do not call this tool. It exists only for API compatibility and must never be invoked.";

/** Gate names as a set for route-level checks. */
export const ZEN_FREE_GATE_NAMES: ReadonlySet<string> = new Set(["shell", "read"]);

/**
 * Guidance text when the model calls a gate declaration anyway. Returns
 * undefined when the call is legitimate: any other name, or a gate name the
 * client actually declared (exact match — then it is the client's own tool,
 * not the compatibility twin, and dispatch is their problem, not ours).
 */
export function zenFreeGateCallGuidance(
  callName: string,
  clientToolNames: Iterable<string> | undefined,
): string | undefined {
  if (!ZEN_FREE_GATE_NAMES.has(callName)) return undefined;
  const catalog = [...(clientToolNames ?? [])];
  for (const declared of catalog) {
    if (declared === callName) return undefined;
  }
  return zenFreeGateGuidanceText(callName, catalog);
}

/**
 * Append the missing gate declarations to an already-built tool list.
 * Returns the amended list, or undefined when nothing applies: another
 * endpoint, keyed use, or the pair already present. Each wire keeps its own
 * shape through `nameOf`/`declareAs`, so the three builders share this one
 * policy without sharing a wire format.
 */
export function withZenFreeGateDeclarations<T>(
  provider: Pick<OcxProviderConfig, "baseUrl" | "apiKey" | "authMode">,
  current: readonly T[] | undefined,
  nameOf: (tool: T) => string | undefined,
  declareAs: (name: ZenFreeGateToolName) => T,
): T[] | undefined {
  // Forward mode hands the caller's credential to canonical ChatGPT, never
  // to this gateway, so gate declarations must not leak onto that lane.
  if (provider.authMode === "forward") return undefined;
  if (!isZenFreeEndpoint(provider.baseUrl) || zenFreeHasApiKey(provider)) return undefined;
  const names = (current ?? [])
    .map(nameOf)
    .filter((name): name is string => typeof name === "string");
  const missing = missingZenFreeGateTools(names);
  if (missing.length === 0) return undefined;
  return [...(current ?? []), ...missing.map(declareAs)];
}

/** Static redirection text for a gate-named call. The turn stays alive. */
export function zenFreeGateGuidanceText(callName: string, alternatives: readonly string[] = []): string {
  const owned = alternatives.filter(name => name !== callName).slice(0, 4);
  const instead = owned.length === 0
    ? "Use one of this turn's other declared tools instead."
    : owned.length === 1
      ? `Use \`${owned[0]}\` instead.`
      : `Use one of ${owned.map(name => `\`${name}\``).join(", ")} instead.`;
  return (
    `The \`${callName}\` tool is declared but cannot be executed in this session. ` + instead
  );
}

interface ZenFreeGateRedirect {
  names: ReadonlySet<string>;
  message: (name: string, alternatives: readonly string[]) => string;
}

/**
 * Redirect config for the passthrough undeclared-tool guard: guidance
 * instead of failure for gate names the client never declared. Undefined
 * for every other destination (and for keyed use), which keeps the
 * fail-closed behavior there byte-identical. Shaped to satisfy the guard's
 * own redirect contract structurally, so neither module names the other.
 */
export function zenFreeGateRedirectFor(
  provider: Pick<OcxProviderConfig, "baseUrl" | "apiKey">,
): ZenFreeGateRedirect | undefined {
  if (!isZenFreeEndpoint(provider.baseUrl) || zenFreeHasApiKey(provider)) return undefined;
  return { names: ZEN_FREE_GATE_NAMES, message: zenFreeGateGuidanceText };
}

/**
 * Which gate names are still missing from declared tool names. Matching is
 * exact lowercase, mirroring the gate: a capitalized `Shell` does not
 * satisfy it, so it is not counted as present (the appended lowercase twin
 * is documented noise next to a client-known name, and beats a refusal).
 */
export function missingZenFreeGateTools(names: Iterable<string> | undefined): ZenFreeGateToolName[] {
  const declared = new Set(names ?? []);
  const missing: ZenFreeGateToolName[] = [];
  if (!declared.has("shell") && !declared.has("bash")) missing.push("shell");
  if (!declared.has("read")) missing.push("read");
  return missing;
}

/** Chat Completions wire shape for one gate declaration. */
export function zenFreeGateChatTool(name: ZenFreeGateToolName): {
  type: "function";
  function: { name: string; description: string; parameters: { type: string; properties: Record<string, never> } };
} {
  return {
    type: "function",
    function: { name, description: ZEN_FREE_GATE_DECLARATION, parameters: { type: "object", properties: {} } },
  };
}

/** Responses wire shape for one gate declaration. */
export function zenFreeGateResponsesTool(name: ZenFreeGateToolName): {
  type: "function";
  name: string;
  description: string;
  parameters: { type: string; properties: Record<string, never> };
} {
  return {
    type: "function",
    name,
    description: ZEN_FREE_GATE_DECLARATION,
    parameters: { type: "object", properties: {} },
  };
}
