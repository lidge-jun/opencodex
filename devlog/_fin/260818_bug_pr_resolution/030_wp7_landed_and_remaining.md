# 030 — WP7: landed-redesign closeout + #1876 / #1842 disposition

## Part A — already-landed redesigns (bookkeeping only)

- #1932 (WHAM 401) → landed via #2021 (f2b507f83), original CLOSED already. No linked issue.
- #1896 (functions-namespace) → landed via #2020 (5f2b93979), original CLOSED. Linked #1844 is a PR (merged), not an issue.
- #1889 (x-goog-api-client) → landed via #2018 (ea16f8613), original CLOSED. Linked #1836 is a PR (closed), not an issue.
- r4 audit confirmed: no OPEN issue references 1932/1896/1889 or the landing PRs.
- Nothing to do beyond verification (done above via gh states).

## Part B — #1876 (async Windows snapshot collector, linked #1852 OPEN)

Matrix: REDESIGN-SMALL "rebase onto fail-closed snapshot API; keep async collector, 250ms TTL".
Head 125156c3e is only 7 commits behind dev and scratch-merges CLEAN. Wibias
CHANGES_REQUESTED exists — check whether it postdates the head.
Decision rule (in order):
1. Audit the head against the directive: does it build on the CURRENT fail-closed
   snapshot API (post-#1946/#1947 state), is the TTL guidance honored (matrix says
   250ms; PR body says 5s — resolve which is right against structure/03 and the
   review thread), is the CHANGES_REQUESTED stale?
   r4 resolution: BOTH TTLs are correct by design — 250ms is the unknown-state
   negative cache (CATALOG_STATE_UNKNOWN_TTL_MS, #1947 policy), 5s the positive
   advisory cache (CATALOG_STATE_TTL_MS); head 125156c3e adopts dev's machinery
   and all four fail-closed commits are its ancestors.
2. HARD GATES before any #1876 merge (r4 HIGH): (a) the Wibias CHANGES_REQUESTED
   explicitly demands the full Windows suite on the resulting EXACT head —
   dispatch the platform-windows workflow (workflow_dispatch, full SHA) on the
   landed candidate and require green; (b) reviewDecision must clear via Wibias
   re-review or explicit dismissal with reason. Blocker-1 staleness alone does
   NOT clear the review. Only then: validate named suites + tsc and MERGE with
   credit; close #1852.
3. If gaps are small → merge-with-fixup commits on a codex/land-1876 branch (same
   pattern as the land-* train), close original + #1852.
4. If gaps are structural → close with a redesign directive comment (do NOT merge).

## Part C — #1842 (OAuth redaction, no linked issue)

Matrix: REDESIGN-SMALL "OAuth redaction; preserve typed identity errors".
Head e298b2d80 is 308 commits behind but scratch-merges CLEAN (security-sensitive
surfaces: auth-api, oauth, sidecars — MAINTAINERS security review applies).
Decision rule: same ladder as Part B, with two extra gates:
- the redaction must NOT swallow the typed identity errors that #1932's transient
  gate and the account-pool health machinery rely on (invalid_refresh_token,
  invalid_workspace_selected classification paths in auth-api.ts) — that is the
  exact "preserve typed identity errors" directive;
  r4 verification: gate PASSES on the scratch-merged tree — #1842's hunks
  (auth-api login-flow ~1791-2045, core.ts 2169/3809) have zero overlap with
  f2b507f83's classification hunks (@566-601, @723), and redaction rewrites
  outbound messages only, never body-code classification.
- privacy:scan and the oauth/auth test suites must pass on the merged tree.
- r4 MEDIUM: dev core.ts drifted 29 hunks since the merge-base; raw err.message
  still escapes at post-merge-base sites (core.ts ~1101/1104/1107, ~2131) the PR
  never saw. The fixup commit must either extend coverage to those sites or
  scope the landing-commit claim explicitly. r4 LOW: squash the no-op
  oauth-account-routes /api/oauth/status remnant in the fixup.

## Verifiers

- Per-PR scratch worktree on lidge or local: bun test <named suites> + tsc.
- #1876 additionally requires the platform-windows workflow_dispatch run green on
  the exact landed SHA (lidge is not a Windows leg and does not discharge it).
- gh pr checks after any push; lidge full suite before wp11 closeout (not per-merge).

IN: dispositions for 1876/1842 + issue closes. OUT: new feature work beyond fixups.

## Outcome (wp7 close)

- Part A: verified terminal (1932/1896/1889 CLOSED, landings on dev, no open issues).
- Part C #1842: 7-commit redesign rebased to codex/land-1842-v2, independent
  security review SECURITY: APPROVE, PR #2043 ALL GREEN, merged e446607c8;
  original #1842 closed with credit. Canonical dev push CI green on e446607c8
  (run 32147799485).
- Part B #1876: NEEDS_HUMAN — candidate validated (rebased, fail-closed
  ancestors, TTLs honored) and windows dispatch run 32145700019 failed ONLY in
  suites that fail identically on dev's own control dispatch 32147924436
  (Log Guard / CodeRabbit-protection / WS-relay families; pre-existing dev
  Windows-leg redness, zero app-server-process failures). Merge held for the
  standing Wibias CHANGES_REQUESTED re-review/dismissal; evidence posted on the
  PR. #1852 stays open until #1876 lands.
- Pre-existing (out of campaign scope, recorded): the platform-windows
  workflow_dispatch leg is red on dev itself (Log Guard suites) since at least
  366a56324 (8/16). Deserves its own unit.
