import { OAuthAccountPausedError } from "../oauth";
import type { OcxProviderConfig } from "../types";

export class ProviderApiKeyPausedError extends OAuthAccountPausedError {
  constructor() {
    super();
    this.message = "API key is paused. Resume it in account settings and retry.";
    this.name = "ProviderApiKeyPausedError";
  }
}

export function isProviderApiKeyPaused(provider: OcxProviderConfig | undefined): boolean {
  if (!provider || provider.authMode === "oauth" || provider.authMode === "forward" || provider.authMode === "local") {
    return false;
  }
  const pool = provider.apiKeyPool;
  if (!pool?.length) return false;
  if (pool.every(entry => entry.disabled === true)) return true;
  const ref = provider._apiKeyAttempt?.reference ?? provider.apiKey;
  if (!ref?.trim()) return false;
  return pool.some(entry => entry.disabled === true && entry.key === ref)
    && !pool.some(entry => !entry.disabled && entry.key === ref);
}
