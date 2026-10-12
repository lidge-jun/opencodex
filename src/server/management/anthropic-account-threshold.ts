import { isAnthropicOAuthInstance, configuredAnthropicInstance } from "../../providers/anthropic-instance";
import type { OcxConfig } from "../../types";
import { effectiveAnthropicAccountThresholdForInstance, parseAnthropicAccountThreshold } from "../../oauth/anthropic-account-threshold";
import { OAUTH_PROVIDERS } from "../../oauth";
import { setAnthropicAccountThresholdForInstance } from "../../oauth/store";
import { jsonResponse } from "../auth-cors";
import { readManagementJsonBodyOr } from "./body";

/** Account-owned policy writes share the auth-store lock, not a config/auth split transaction. */
export async function handleAnthropicAccountThreshold(req: Request, config: OcxConfig): Promise<Response> {
  const body = await readManagementJsonBodyOr(req, {});
  if (!body || typeof body !== "object" || Array.isArray(body)) return jsonResponse({ error: "body must be an object" }, 400);
  const fields = body as Record<string, unknown>;
  const provider = fields.provider;
  if (typeof provider !== "string" || !isAnthropicOAuthInstance(provider)) return jsonResponse({ error: "account threshold requires Anthropic OAuth" }, 400);
  const definition = OAUTH_PROVIDERS[provider];
  const effectiveProvider = config.providers[provider]
    ?? definition?.resolveProviderConfig?.(config) ?? definition?.providerConfig;
  if (effectiveProvider?.authMode !== "oauth" || (provider === "anthropic2" && !configuredAnthropicInstance(config, provider))) {
    return jsonResponse({ error: "account threshold requires Anthropic OAuth" }, 400);
  }
  if (typeof fields.accountId !== "string" || !fields.accountId.trim()) return jsonResponse({ error: "missing accountId" }, 400);
  const threshold = parseAnthropicAccountThreshold(fields.threshold);
  if (fields.threshold !== null && threshold === null) return jsonResponse({ error: "threshold must be an integer 0-100 or null" }, 400);
  if (!await setAnthropicAccountThresholdForInstance(provider, fields.accountId, threshold)) return jsonResponse({ error: "account not found" }, 404);
  return jsonResponse({ ok: true, provider, accountId: fields.accountId,
    autoSwitchThresholdOverride: threshold,
    effectiveAutoSwitchThreshold: effectiveAnthropicAccountThresholdForInstance(provider, config, { autoSwitchThresholdOverride: threshold ?? undefined }),
    autoSwitchThreshold: effectiveAnthropicAccountThresholdForInstance(provider, config) });
}
