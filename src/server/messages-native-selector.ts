/** Pure caller-forward exclusion shared by Messages ingress and protocol preview. */
import { resolveInboundModel } from "../claude/inbound-model-options";
import { routeConcreteModel } from "../router";
import { configuredAnthropicInstance } from "../providers/anthropic-instance";
import type { OcxConfig } from "../types";

export function messagesSelectorTargetsSecondaryInstance(
  config: OcxConfig,
  model: string,
  cc: OcxConfig["claudeCode"] = config.claudeCode,
): boolean {
  const selector = resolveInboundModel(model, cc);
  // An orphan or unmarked B selector must also never forward a caller's credential.
  if (/^anthropic2\//i.test(selector)) return true;
  if (!selector.includes("/")) return false;
  try {
    // Concrete resolution handles configured provider aliases without picking a combo/account.
    return routeConcreteModel(config, selector).providerName === "anthropic2";
  } catch {
    const qualifier = selector.slice(0, selector.indexOf("/")).toLowerCase();
    return config.providers.anthropic2?.alias?.trim().toLowerCase() === qualifier;
  }
}

/** A missing B row must not fall through the router's generic default-provider path. */
export function messagesSecondaryInstanceUnavailable(
  config: OcxConfig,
  model: string,
  cc: OcxConfig["claudeCode"] = config.claudeCode,
): boolean {
  if (!messagesSelectorTargetsSecondaryInstance(config, model, cc)) return false;
  const provider = config.providers.anthropic2;
  return !provider || provider.disabled === true
    || provider.authMode === "oauth" && configuredAnthropicInstance(config, "anthropic2") !== "anthropic2";
}
