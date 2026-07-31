# 50 — Phase 5: Non-Kiro credential import safeguards

Purpose: make common OAuth credential persistence auditable and safe without
claiming or changing Kiro-specific behavior. Kiro adapter, Kiro OAuth, and
Kiro tests are out of scope for this common-security track.

## Planned non-Kiro surfaces

- `src/oauth/types.ts`
- `src/oauth/store.ts`
- `src/oauth/index.ts` only for provider-neutral status/source handling
- `src/oauth/local-token-detect.ts`
- `src/oauth/xai.ts`
- `src/oauth/anthropic.ts`
- `tests/oauth-status-privacy.test.ts`

## Checks

- Imported non-Kiro local credentials have clear safe source metadata.
- `auth.json` rewrites normalize the whole store, not just the provider being
  saved, so legacy extra fields cannot survive a later write.
- `getLoginStatus()` can expose only allowlisted source labels and masked email
  metadata; it never returns access tokens, refresh tokens, arbitrary legacy
  `source` strings, prompts, headers, ID tokens, or diagnostics.
- Refresh-token persistence remains intentionally unchanged; replacing it with
  memory-only imports or OS keychain storage is a product decision outside this
  slice.

## Diff-level plan

MODIFY `src/oauth/types.ts`

- Add a small `OAuthCredentialSource` union:
  `oauth | local-cli | credential-file | environment | manual`.
- Add optional `source` metadata to persisted OAuth credentials.

MODIFY `src/oauth/store.ts`

- Normalize loaded credentials before any caller observes them.
- Normalize the entire persisted store before writing `auth.json`.
- Persist only `access`, `refresh`, `expires`, optional masked-status metadata
  (`email`, `accountId`, `source`), and drop accidental extra fields such as
  prompt text, headers, ID tokens, or diagnostics.

MODIFY `src/oauth/index.ts`

- Default ordinary OAuth logins to source `oauth`.
- Preserve existing source metadata when a provider refresh response does not
  provide a new source.
- Expose only safe source metadata through `getLoginStatus()`, never access or
  refresh token values.

MODIFY `src/oauth/local-token-detect.ts`

- Mark Grok CLI and Claude Code local imports as `local-cli` at detection time.

MODIFY `src/oauth/xai.ts` and `src/oauth/anthropic.ts`

- Preserve `local-cli` source when an imported local token is refreshed before
  persistence.

MODIFY tests

- `tests/oauth-status-privacy.test.ts`: status source is safe, invalid legacy
  source strings are dropped, and credential persistence allowlists known fields
  across the whole store.

Out of scope:

- Kiro adapter parity, Kiro OAuth import semantics, Kiro diagnostics, and
  `tests/kiro*.test.ts`.

## Build record

Files changed for the non-Kiro common track:

- MODIFY `src/oauth/types.ts`: added `OAuthCredentialSource` and optional
  credential `source`.
- MODIFY `src/oauth/store.ts`: credential loading/writing now allowlists known
  fields and normalizes all providers before writing `auth.json`.
- MODIFY `src/oauth/index.ts`: `runLogin()` defaults to `oauth` source,
  refresh persistence preserves existing source metadata, and
  `getLoginStatus()` exposes only safe source metadata.
- MODIFY `src/oauth/local-token-detect.ts`: Grok CLI and Claude Code imports are
  tagged `local-cli`.
- MODIFY `src/oauth/xai.ts` and `src/oauth/anthropic.ts`: refreshed local
  imports keep `local-cli`.
- MODIFY `tests/oauth-status-privacy.test.ts`: added status-source, whole-store
  credential allowlist, invalid-source, and malformed-store regression coverage.

Verification:

- `bun test tests/oauth-status-privacy.test.ts`
  -> 5 pass, 0 fail.
- `bun x tsc --noEmit`
  -> exit 0, no diagnostics at the time of the non-Kiro slice.

## Independent verification follow-up

Read-only sub-agent audit (`Gauss`) returned FAIL after the first credential
metadata commit.

Non-Kiro findings:

- Existing providers in `auth.json` were not re-normalized when saving one
  provider, so legacy extra fields could survive rewrites.
- xAI/Anthropic local-token imports could be labeled as `oauth`.
- Refreshed credentials could lose existing `source` metadata.
- Legacy arbitrary `source` strings could be reflected by `getLoginStatus()`.

Follow-up changes:

- MODIFY `src/oauth/store.ts`: `loadAuthStore()` now normalizes the whole store;
  invalid credential sources and extra fields are dropped for all providers.
- MODIFY `src/oauth/index.ts`: refresh persistence preserves existing source
  metadata when refresh responses do not provide one.
- MODIFY `src/oauth/local-token-detect.ts`: Grok CLI and Claude Code imports are
  tagged `local-cli` at detection time.
- MODIFY `src/oauth/xai.ts` and `src/oauth/anthropic.ts`: refreshed local imports
  keep `local-cli`.
- MODIFY `tests/oauth-status-privacy.test.ts`: added whole-store normalization
  and invalid-source reflection coverage.

Re-verification:

- `bun test tests/oauth-status-privacy.test.ts`
  -> 5 pass, 0 fail.
- `bun x tsc --noEmit`
  -> exit 0, no diagnostics at the time of the non-Kiro slice.
