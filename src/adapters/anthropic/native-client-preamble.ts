/** Preserve an observed native client's existing prefix; never create or sign billing text. */
import { hasObservedAnthropicClientIdentity, type AnthropicClientIdentity } from "./client-identity";

const NATIVE_IDENTITIES = new Set([
  "You are Claude Code, Anthropic's official CLI for Claude.",
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
]);
const BILLING_PREAMBLE = /^x-anthropic-billing-header: cc_version=[A-Za-z0-9._-]{1,128}; cc_entrypoint=[A-Za-z0-9._-]{1,128};/;

function textBlock(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const block = value as Record<string, unknown>;
  return block.type === "text" && typeof block.text === "string" ? block.text : undefined;
}

/**
 * Only the native first-party builder asks this, after selecting its destination. The coherent
 * handle and the two exact prefix blocks select compatibility behavior, not credential authority.
 * Returning true leaves the original system array and every cache marker untouched.
 */
export function shouldPreserveNativeClientPreamble(
  system: unknown,
  clientIdentity: AnthropicClientIdentity | undefined,
): boolean {
  if (!hasObservedAnthropicClientIdentity(clientIdentity) || !Array.isArray(system) || system.length < 2) return false;
  const billing = textBlock(system[0]);
  const identity = textBlock(system[1]);
  return billing !== undefined && billing.length <= 4096 && !/[^\x20-\x7e]/.test(billing)
    && BILLING_PREAMBLE.test(billing) && identity !== undefined && NATIVE_IDENTITIES.has(identity);
}
