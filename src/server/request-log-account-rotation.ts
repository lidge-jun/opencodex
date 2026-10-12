import { ACCOUNT_LOG_LABEL_RE } from "../codex/account-label";
import { isCodexUsageAccountLogLabel, type PersistedUsageAttempt } from "../usage/log";

/**
 * Did the account behind a sent attempt change between two sends of the same request?
 *
 * Any ACCOUNT change ends the attempt, not just an API-key one. Codex pool and generic OAuth
 * labels are `p`/`o` + 6 hex, which the key-only pattern never matched, so a rotation folded the
 * second account's sends, usage and label into the first attempt row: the request then reported
 * one attempt on the wrong account, and per-account usage attribution was silently wrong.
 * `isCodexUsageAccountLogLabel` (src/usage/log.ts) already persists those labels onto the
 * attempt through the broad pattern; this is the same pattern, read back at the split.
 *
 * The other axis a rotation can move: Anthropic's pool carries no label at all --
 * `stampOAuthAccountLabel` skips that base provider -- and keeps its account inside the
 * account-qualified log provider string (`anthropic-p<hex6>`), so the label test can never see an
 * Anthropic rotation. Comparing providers is safe because a sent attempt's provider is frozen by
 * `sealRequestAttemptIdentity`: the only way the two diverge after a send is the account moving
 * underneath the row.
 */
export function attemptAccountChanged(
  previousLabel: string | undefined,
  nextLabel: string | undefined,
  attemptProvider: string | undefined,
  currentProvider: string,
): boolean {
  const labelChanged = previousLabel !== nextLabel
    && (ACCOUNT_LOG_LABEL_RE.test(previousLabel ?? "") || ACCOUNT_LOG_LABEL_RE.test(nextLabel ?? ""));
  return labelChanged || (attemptProvider !== undefined && attemptProvider !== currentProvider && currentProvider.length > 0);
}

/** Stamp an attempt's identity; after its first send the account is frozen (see attemptAccountChanged). */
export function sealRequestAttemptIdentity(
  attempt: PersistedUsageAttempt | undefined,
  provider: string,
  adapter: string,
  accountLogLabel?: string,
): void {
  if (!attempt) return;
  if (attempt.provider !== provider || attempt.adapter !== adapter) delete attempt.credentialSource;
  // The adapter keeps re-stamping: a mid-turn wire rotation is still this same physical send.
  attempt.adapter = adapter;
  if (attempt.sendCount === 0) {
    attempt.provider = provider;
    if (isCodexUsageAccountLogLabel(accountLogLabel)) attempt.accountLogLabel = accountLogLabel;
    else delete attempt.accountLogLabel;
    return;
  }
  // After a send the account is settled; only a label that arrives late for the same account lands.
  if (attempt.accountLogLabel === undefined && isCodexUsageAccountLogLabel(accountLogLabel)) {
    attempt.accountLogLabel = accountLogLabel;
  }
}
