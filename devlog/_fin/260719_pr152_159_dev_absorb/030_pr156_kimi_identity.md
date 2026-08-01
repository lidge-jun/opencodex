# 030 — PR #156 absorb: Kimi multi-account identity via JWT user_id

## 1. Scope and locked inputs

Absorb community PR #156 from immutable source head
`a6d824ee398535855302495ab13cd0228632a5b1` (`codex/source-pr156-a6d824ee`)
onto local `dev`, then land maintainer repairs for the Sol findings below.
No push / no GitHub write. Attribution per `000_plan.md`.

Source delta (3 files, +188/−4):

- `src/oauth/kimi.ts` — NEW `decodeKimiJwtPayload`, `identityFromKimiTokens`
  (user_id → sub fallback, email lowercased, refresh-JWT gap fill);
  `parseTokenPayload` spreads identity into returned credentials.
- `src/oauth/store.ts` — comment-only update (kimi no longer listed identity-less).
- `tests/kimi-oauth-identity.test.ts` — NEW: helper identity tests + saveCredential
  append/upsert/identity-less-replace tests.

`git merge-tree --write-tree dev codex/source-pr156-a6d824ee` → clean
(`6a5176818b50`), no conflicts with dev.

## 2. Sol review verdict (2026-07-19, lane B)

`VERDICT PR#156: GO-WITH-FIXES (blockers=1)`

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| 1 | P1 | Legacy identity-less Kimi row is duplicated, not migrated: first post-fix login appends (store.ts:218-229) leaving the stale identity-less row selectable/refreshable | FOLD — maintainer repair commit: when saving a Kimi credential WITH accountId and the provider's only existing rows are identity-less, replace the active identity-less row instead of appending. Add test driving legacy→identified transition |
| 2 | P2 | user_id not truly preferred across tokens (access.sub beats refresh.user_id, kimi.ts:61-75); user_id/sub namespace collision can upsert across users | FOLD — repair: compute accountId as (access.user_id ?? refresh.user_id ?? access.sub ?? refresh.sub); collision risk accepted as-is (same-issuer namespace) with comment, per PR intent |
| 3 | P2 | Tests bypass production wiring (parseTokenPayload spread untested) | FOLD — add a mocked token-response test asserting parseTokenPayload output carries identity |

## 3. Landing plan

- Commit 1 (author Wibias, committer maintainer): faithful cherry-pick of
  `a6d824ee`. Body names PR #156 + source head.
- Commit 2 (maintainer author + Co-authored-by Wibias): P1 migration repair +
  P2 preference-order fix + wiring test.

## 4. Verification

- `bun run typecheck` exit 0.
- `bun test tests/kimi-oauth-identity.test.ts tests/oauth-public-surface.test.ts` pass.
- C-ACTIVATION: legacy-migration branch driven by new test (login after
  identity-less row → replaced not appended).
