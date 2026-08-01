# 050 — PR #304: fix(kiro): restore hardening and complete text turns

- Author: mushikingh · base `dev` · nominal +3440/−496, 53 files, 14 commits.
- CI: full cross-platform + service-lifecycle green (linux-systemd, macos-launchd) + CodeRabbit.
- No GUI paths. Touches Kiro OAuth/credential import → **security-review scope** per
  MAINTAINERS.md (author explicitly flags this in the PR body).

## Key context: the "restore" framing is partially stale

- The PR claims #302's merge commit is unreachable from `dev`. That was true when filed, but
  `dev` now contains 49e586d9 "feat(kiro): harden completion and transport integration"
  (co-authored with mushikingh) — the #302 content was re-landed by the maintainer.
- Effective diff vs today's dev (`origin/dev...pr-304`) is much smaller than the nominal stat:
  mostly `src/adapters/kiro.ts` and the delta commits on top of the restore:
  - d4f612ff fix(kiro): complete turns on clean text EOF (the real new fix — Codex turns
    hung after Kiro returned a complete plain-text answer; now accepts clean text EOF
    without a second upstream generation).
  - 5317d4f2 fix(test): isolate suite from user Codex/opencodex state (`scripts/test.ts`
    sandboxing) — genuinely useful for CI hygiene.
  - kiro-credentials: adds `kirocli:oidc:*` (correct spelling) alongside legacy `odic` keys,
    `KIROCLI_DB_PATH`/`KIROCLI_TOKEN_KEY` selectors, ambiguous-token fail-fast diagnostics.
  - CORRECTION (verified): the three-dot diff `origin/dev...pr-304` touches NO cursor files
    and no configuration docs — merge-base is 54e0bbf8 (current dev lineage). The scary
    removals only appear in the two-dot diff vs 49e586d9, which is not what a merge applies.
    The PR does not revert any dev work.

## Review findings

- Credential changes are read-only imports with fail-fast on ambiguity; error strings leak no
  token material. Reasonable, but this is exactly the security-review lane.
- Runtime endpoint derivation (`kiroRuntimeEndpoint`) regex-pins `runtime.<region>.kiro.dev` —
  prevents region drift, good.
- Because dev absorbed the restore separately (49e586d9), the PR's effective delta is the
  kiro/bridge/oauth/test files shown in `git diff origin/dev...pr-304 --stat`. Mergeable
  without resurrecting stale state; GitHub will show the same effective diff.

## Verdict: **SECURITY REVIEW, then MERGE**

The clean-text-EOF fix and test isolation are valuable and should land. The diff vs dev is
already the true delta (no rebase strictly required). Run the security-review checklist on
`src/oauth/kiro-credentials.ts` / `src/oauth/index.ts` before merging, per MAINTAINERS.md and
the author's own flag.
