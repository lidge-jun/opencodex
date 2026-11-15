# Native-Main Login Retention

Codex rewrites auth.json in place (truncate, then write), so a reader can briefly see it empty or
half written. `src/codex/native-main-credentials.ts` classifies every native-main read through the
shared reader as complete, incomplete (empty or unparseable), no-login (well-formed without a ChatGPT
access or refresh token), missing or unreadable, and keeps the last complete login per CODEX_HOME,
auth path and file identity (#7345, owner's second contract). Only an incomplete observation may be
answered from it, and only by `getMainAccountCredentialStatus` and the initial read of
`getValidMainAccountToken` / `forceRefreshMainAccountToken` in `src/codex/main-account.ts`.
There is no time window. Retention ends at once, and is never revived, on:

- a missing observation (a missing file is unavailable unless the Codex RPC confirms a login; see [native-main refresh ownership](openai-accounts.md#native-main-refresh-ownership)),
  a no-login observation, or an unreadable file;
- account replacement: another OpenCodex credential publication (`advanceCodexCredentialMutationEpoch`),
  a different file identity, or a complete file naming another login;
- revocation (`markMainRefreshGrantRejected`, `markAccountNeedsReauth` for `__main__`, a rejected grant
  on the retained login) and pause (`setCodexAccountPaused` for `__main__`);
- a refresh-owner change reported by `resolveNativeMainRefreshMode`;
- ownership loss: another home or path, the `src/codex/native-main-owner.ts` lock leaving `held`, or
  native-main traffic blocked by startup or recovery.

Every invalidation bumps a generation. A refresh captures its ticket before the token exchange,
and retains the published login only if no invalidation happened meanwhile, so a completion after
ownership loss cannot repopulate retention. A retained bearer that is expired (or the one upstream
rejected) is discarded before use, so the selected refresh owner decides exactly as for an
unavailable file: the guarded writer cannot refresh a file mid-rewrite and reports no credential,
and Codex mode asks the RPC. Write guards (the pre-rename snapshot check and native device reauth)
read the physical file and never retain. `tests/codex-integration/native-main-credentials-retention.test.ts`
pins each fixture; `tests/codex-integration/native-main-refresh-mode.test.ts` stays the refresh-owner parity check.
