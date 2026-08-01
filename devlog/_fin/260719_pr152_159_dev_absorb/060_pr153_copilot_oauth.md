# 060 — PR #153 absorb: GitHub Copilot device-flow OAuth (C4 security surface)

## 1. Scope and locked inputs

Absorb community PR #153 from immutable source head
`1034be9ceff149a2d4ce1367b859a3a3e7c37f69` (`codex/source-pr153-1034be9c`)
onto local `dev` with maintainer repairs for the Sol security review findings.
C4: OAuth/credentials — full gates, durable evidence. No push. Attribution per
`000_plan.md`. Depends on 030 (store.ts identity conventions already landed).

Source delta (12 files, +735/−13): NEW `src/oauth/github-copilot.ts`,
`src/providers/github-copilot-transport.ts`; MODIFY oauth/index.ts, store.ts,
types.ts, providers/registry.ts (preset key→oauth), xai-transport.ts,
server/responses.ts, docs providers.md; NEW tests github-copilot-oauth.test.ts;
MODIFY oauth-public-surface / provider-registry-parity tests.
`git merge-tree` clean (`3c32d7529e0e`). Source commits: `9cb236ca` (feature),
`77e611c9` (privacy-scan fixture), `bc50cf28`+`1034be9c` (CI bump + revert — skip both).

## 2. Sol review verdict (2026-07-19, lane D, security-focused)

`VERDICT PR#153: GO-WITH-FIXES (blockers=4)`

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| 1 | P1 | Registry preset flips key→oauth without `allowKeyAuthOverride`; router rewrites persisted `authMode:"key"` → existing API-key users silently broken (registry.ts:762-773, router.ts:125-132) | FOLD — add `allowKeyAuthOverride: true` to the preset (pattern already used by other dual-mode providers) + migration regression test |
| 2 | P1 | Access-token-only device-flow success rejected (github-copilot.ts:205-207 requires both tokens); refresh path assumes refresh grant | FOLD — DECIDED renewal representation: the durable GitHub grant is stored in the credential `refresh` field (satisfies `src/oauth/types.ts` contract). Access-only response (classic `gho_` token, non-expiring) → `refresh = gho_token`; expiring-token response → `refresh = ghr_refresh_token`. The `access` field holds the short-lived Copilot token from `copilot_internal/v2/token`. `def.refresh(cred.refresh)` inspects the stored grant: `ghr_` prefix → GitHub refresh grant then Copilot exchange; otherwise → direct Copilot re-exchange. "Refresh" for Copilot always means re-exchange of the durable GitHub grant, so both expiry renewal and 401 recovery work for BOTH response shapes; test fixtures for access-only and refresh-grant paths |
| 3 | P1 | Copilot token grammar (`tid=...;...`) not redacted on upstream-error path (redact.ts:5-10, responses.ts:1510) | FOLD — extend redact.ts for the Copilot token shape (raw value + JSON "token" field + full Bearer value) + handleResponses-level leak test |
| 4 | P1 | Transient `/user` identity failure → identity-less credential → replaces active slot, clobbering another account (github-copilot.ts:293-341, store.ts:208-248) | FOLD — DECIDED: `fetchGithubIdentity` retries once (500ms backoff); if identity is still unavailable, the login FAILS with a clear "could not verify GitHub account identity — retry login" error and nothing is persisted. No identity-less GitHub rows, ever |
| 5 | P2 | Poll cadence: immediate first poll, slow_down +1s (spec: +5s, cf. kimi.ts:115-134), no fetch deadline bound | FOLD — wait-before-poll, +5s slow_down, AbortSignal.timeout bounded by remaining lifetime |
| 6 | P2 | Lazy 401 refresh unreachable: GitHub arg sits inside xAI-only branch (responses.ts:1431-1453, oauth/index.ts:220-224) | FOLD — extend the snapshot/forced-refresh gate to github-copilot, one refresh+replay on 401 |
| 7 | P2 | Terminal refresh failures unclassified → revoked creds retried forever (github-copilot.ts:250-252 vs oauth/index.ts:247-251) | FOLD — DECIDED (leak-safe + reachable): parse the OAuth error response and extract ONLY the allowlisted `error` code (`invalid_grant`, `access_denied`, `expired_token`); throw an error whose message contains just `github-copilot refresh failed: <code> (HTTP <status>)` — never the body or error_description. REACHABILITY: extend `isTerminalRefreshError` (oauth/index.ts:233-236) to match all three allowlisted codes (currently only invalid-grant/reuse/revocation text) so needsReauth actually fires. Activation tests drive ALL THREE codes: each marks needsReauth, and an `error_description` canary never appears in message or logs |
| 8 | P2 | Host-allowlist fallback gap: credential without `apiBaseUrl` falls back to provider.baseUrl → bearer to arbitrary configured host (github-copilot-transport.ts:39, oauth/index.ts:344-350) | FOLD — fail closed: no `endpoints.api` in credential → refuse non-allowlisted baseUrl (allowlist check at the transport boundary) |
| 9 | P2 | Negative coverage gaps conceal findings 1-8 | FOLD — add tests per repaired finding (access-only, expired_token, access_denied, malformed payload, deadline, identity-failure store integration, key compat, 401 replay, host fallback) |
| 10 | P3 | Docs drift: preset/key counts stale, ko/zh guides still describe key auth; dead "test helper" in production module | FOLD — fix counts, update ko/zh provider guides, remove/relocate helper |

## 3. Landing plan (commit map — DECIDED)

1. Wibias-author pick of `9cb236ca` + `77e611c9` (feature + privacy fixture) —
   source-faithful checkpoint.
2. Maintainer repair commit A (+Co-authored-by): security findings 1-8 + their
   activation tests.
3. Maintainer repair commit B (+Co-authored-by): P3 docs fixes (counts, ko/zh
   guides, dead helper removal).

## 4. Verification (C4 gates)

- `bun run typecheck` exit 0.
- `bun test tests/github-copilot-oauth.test.ts tests/oauth-public-surface.test.ts tests/provider-registry-parity.test.ts` pass.
- Stale check first (000_plan contract): dev drifted at `eb1c39e5`
  (registry.ts + provider-registry-parity + reasoning-effort tests) — re-derive
  the registry hunk against the current tree before picking.
- Leak test through handleResponses proves redaction (C-ACTIVATION for finding 3).
- Key-mode compat test proves finding 1 migration path.
- Durable evidence recorded in this doc's close-out section at D.
