import { CODEX_ACCOUNT_LOG_LABEL_RE } from "./codex-account-label";

function canonicalUsageProviderLabel(provider: string): string {
  return provider === "chatgpt" ? "openai" : provider;
}

export function baseProviderLabel(provider: string): string {
  const cut = provider.lastIndexOf("-");
  if (cut <= 0) return canonicalUsageProviderLabel(provider);
  const suffix = provider.slice(cut + 1);
  // `-main` is the legacy log label for the main Codex account (MAIN_CODEX_ACCOUNT_ID). New entries
  // log under the base provider name, but historical `<provider>-main` entries must still collapse.
  // ChatGPT auth-pool and OpenAI passthrough are the same Codex/OpenAI usage surface, so display
  // summaries normalize them to one `openai` row after recognized main/pool suffixes are removed.
  if (suffix === "main") return canonicalUsageProviderLabel(provider.slice(0, cut));
  return CODEX_ACCOUNT_LOG_LABEL_RE.test(suffix) ? canonicalUsageProviderLabel(provider.slice(0, cut)) : provider;
}
