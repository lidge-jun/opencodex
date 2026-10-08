/** Pure caller-forward exclusion shared by Messages ingress and protocol preview. */
import { resolveInboundModel } from "../claude/inbound-model-options";
import { routeConcreteModel } from "../router";
import { configuredAnthropicInstance } from "../providers/anthropic-instance";
import { hasOwnProvider } from "../config/provider-name";
import type { OcxConfig } from "../types";

export function messagesSelectorTargetsSecondaryInstance(
  config: OcxConfig,
  model: string,
  cc: OcxConfig["claudeCode"] = config.claudeCode,
): boolean {
  const selector = resolveInboundModel(model, cc);
  const slash = selector.indexOf("/");
  if (slash <= 0) return false;
  const qualifier = selector.slice(0, slash);
  // An orphan or unmarked B selector must also never forward a caller's credential.
  if (qualifier === "anthropic2") return true;
  // Provider keys are case-sensitive and outrank aliases, including when disabled.
  if (hasOwnProvider(config.providers, qualifier)) return false;
  try {
    // Concrete resolution handles configured provider aliases without picking a combo/account.
    return routeConcreteModel(config, selector).providerName === "anthropic2";
  } catch {
    return config.providers.anthropic2?.alias?.trim().toLowerCase() === qualifier.toLowerCase();
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
