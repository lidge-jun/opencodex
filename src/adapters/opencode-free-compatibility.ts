import type { ProviderCompatibilityProfile } from "./provider-compatibility";
import { applyZenFreeIdentity, isZenFreeEndpoint, zenFreeHasApiKey } from "./opencode-free-session";
import { ZEN_FREE_GATE_TOOLS, zenFreeGateGuidanceText } from "./opencode-free-tools";

/**
 * Anonymous Zen admission is provider policy, not an OpenAI wire behavior.
 * The generic compatibility layer owns JSON parsing and Chat/Responses shapes;
 * this profile only declares when the policy applies and what Zen requires.
 */
export const openCodeFreeCompatibility: ProviderCompatibilityProfile = {
  applies(provider, context) {
    return context.providerId === "opencode-free"
      && isZenFreeEndpoint(provider.baseUrl)
      && provider.authMode !== "forward"
      && !zenFreeHasApiKey(provider);
  },
  amendHeaders(headers, provider, context) {
    applyZenFreeIdentity(headers, provider, context);
  },
  requiredFunctionTools() {
    return ZEN_FREE_GATE_TOOLS;
  },
  injectedFunctionCallGuidance(name, callerNames) {
    return zenFreeGateGuidanceText(name, callerNames);
  },
};
