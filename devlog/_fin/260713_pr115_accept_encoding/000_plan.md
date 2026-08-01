# PR #115 OpenRouter SSE streaming integration

## Objective

Land contributor PR #115 on `dev` without losing authorship, harden its header handling for every `HeadersInit` shape, prove the identity-encoding branch activates, then promote the verified tree through preview and stable npm releases.

## Constraints

- Preserve commit `75109049d8ba6ddbda4097a99231dc036a56375d` in history by merging `origin/pr/115` into `dev` rather than copying its six lines.
- Do not touch the existing untracked `.claude/` tree or unrelated PRs.
- Keep identity encoding as a default only. Any explicit caller `Accept-Encoding` value wins case-insensitively.
- Apply the default only to streaming requests; non-streaming requests retain Bun's normal compression negotiation.
- No dependency changes and no OpenRouter paid/live request requirement.
- HOTL bounds: existing GitHub/npm credentials only, zero paid calls, 90-minute wall clock, at most three release retries per stage.

## Work-phase map

1. `010_wp1_audit.md`: freeze and independently audit the integration decision.
2. `020_wp2_integrate.md`: merge the contributor commit, harden header normalization, and add activation tests.
3. `030_wp3_dev.md`: run full gates, push `dev`, and wait for CI.
4. `040_wp4_release.md`: publish the next unique preview and stable versions, align branches, and verify provenance.

## Key evidence already captured

- PR: https://github.com/lidge-jun/opencodex/pull/115
- Issue: https://github.com/lidge-jun/opencodex/issues/114
- Contributor head: `75109049d8ba6ddbda4097a99231dc036a56375d`
- PR CI: six Cross-platform CI jobs succeeded on 2026-07-12.
- Current production owner: `src/server/responses.ts:1172-1190`.
- All current adapter call sites pass plain record headers, but `fetchWithHeaderTimeout` accepts the wider `RequestInit.headers` contract.
- Runtime reproduction: Bun sent `gzip, deflate, br, zstd` by default; a gzip-compressed two-frame SSE body arrived as one batch after ~260 ms, while `identity` delivered the first frame in ~1 ms and the second at ~253 ms.

## Terminal outcomes

- `DONE`: exact contributor commit reaches main, hardened tests and full gates pass, npm preview/latest and GitHub releases are verified, and `dev`/`preview`/`main` converge.
- `NOOP`: only if the same behavior already exists after a concurrent merge.
- `BLOCKED`: branch protection, CI, registry, or credentials prevent promotion after bounded retries.
- `UNSAFE`: identity negotiation breaks an explicit upstream contract in verification.
- `NEEDS_HUMAN`: a maintainer-only policy conflict remains.
- `BUDGET_EXHAUSTED`: the stated 90-minute or retry bound is reached.
