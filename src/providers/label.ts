import { CODEX_ACCOUNT_LOG_LABEL_RE, KEY_ACCOUNT_LOG_LABEL_RE, apiKeyAccountLogLabel, oauthAccountLogLabel } from "../codex/account-label";
import type { OcxProviderConfig } from "../types";

export function canonicalUsageProviderLabel(provider: string): string {
  return provider === "chatgpt" || provider === "openai-multi" ? "openai" : provider;
}

const LEGACY_MAIN_ACCOUNT_PROVIDER_LABELS = new Set(["openai-main", "chatgpt-main", "openai-multi-main"]);

export function usesApiKeyAccount(provider: Pick<OcxProviderConfig, "authMode" | "_apiKeyAttempt">): boolean {
  return provider.authMode === "key"
    || (provider.authMode === undefined && !!provider._apiKeyAttempt?.reference);
}

/** Key identity comes from the captured selection, before env/keychain resolution. */
export function stampApiKeyAccountLabel(
  logCtx: { accountLogLabel?: string },
  providerName: string,
  provider: Pick<OcxProviderConfig, "authMode" | "_apiKeyAttempt">,
): void {
  if (usesApiKeyAccount(provider)) {
    logCtx.accountLogLabel = apiKeyAccountLogLabel(providerName, provider._apiKeyAttempt);
  } else if (KEY_ACCOUNT_LOG_LABEL_RE.test(logCtx.accountLogLabel ?? "")) {
    delete logCtx.accountLogLabel;
  }
}

export function baseProviderLabel(provider: string): string {
  const canonical = canonicalUsageProviderLabel(provider);
  if (canonical !== provider) return canonical;
  const cut = provider.lastIndexOf("-");
  if (cut <= 0) return canonicalUsageProviderLabel(provider);
  const suffix = provider.slice(cut + 1);
  // `-main` was the legacy log label for the main Codex account (MAIN_CODEX_ACCOUNT_ID). Restrict
  // that compatibility mapping to the known Codex provider labels so configured providers whose
  // names naturally end in `-main` remain distinct.
  // ChatGPT auth-pool and OpenAI passthrough are the same Codex/OpenAI usage surface, so display
  // summaries normalize them to one `openai` row after recognized main/pool suffixes are removed.
  if (LEGACY_MAIN_ACCOUNT_PROVIDER_LABELS.has(provider)) {
    return canonicalUsageProviderLabel(provider.slice(0, cut));
  }
  return CODEX_ACCOUNT_LOG_LABEL_RE.test(suffix) ? canonicalUsageProviderLabel(provider.slice(0, cut)) : provider;
}

/**
 * Stamp the per-account usage label for a non-Codex OAuth provider (#2699).
 *
 * Call this where the resolved credential is known and NOT inside a failover gate. The obvious
 * place -- next to the `genericFailoverAccountId` assignment in `core.ts` -- sits inside
 * `isGenericFailoverProvider`, and the rotation paths additionally require two or more stored
 * accounts. Stamping there would leave the ordinary case (one xai account, failover off) with no
 * label at all while every test still passed, which is the bug this fixes rather than a variant
 * of it.
 *
 * Two providers are skipped because they already have attribution:
 * - `openai` produces its own `p`-labels through `codexAuthContextLogLabel`.
 * - `anthropic` folds the account into the provider label (`formatAnthropicProviderForLog`).
 *
 * It lives here rather than in `account-label.ts` because it needs `baseProviderLabel`, and this
 * module already imports from that one -- the reverse direction would be an import cycle. This
 * file stays Lab-clean, which matters because `core.ts` is one of the three files
 * `tests/lab/core-lab-boundary.test.ts` guards.
 */
export function stampOAuthAccountLabel(
  logCtx: { accountLogLabel?: string },
  providerName: string,
  provider: Pick<OcxProviderConfig, "authMode">,
  accountId: string | undefined,
): void {
  if (!accountId) return;
  if (provider.authMode !== "oauth") return;
  const base = baseProviderLabel(providerName);
  if (base === "openai" || base === "anthropic") return;
  logCtx.accountLogLabel = oauthAccountLogLabel(accountId, base);
}
