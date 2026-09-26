import type { ProviderRequestCompatibility } from "./provider-compatibility";
import { applyZenFreeIdentity, isZenFreeEndpoint } from "./opencode-free-session";
import { ZEN_FREE_GATE_TOOLS } from "./opencode-free-tools";

/**
 * Anonymous Zen admission is provider policy, not an OpenAI wire behavior.
 * The generic compatibility layer owns JSON parsing and Chat/Responses shapes;
 * this profile only declares when the policy applies and what Zen requires.
 */
export const openCodeFreeCompatibility: ProviderRequestCompatibility = {
  applies(provider) {
    return isZenFreeEndpoint(provider.baseUrl) && provider.authMode !== "forward";
  },
  amendHeaders(headers, provider, context) {
    applyZenFreeIdentity(headers, provider, context);
  },
  requiredFunctionTools(provider) {
    return provider.apiKey?.trim() ? [] : ZEN_FREE_GATE_TOOLS;
  },
};
