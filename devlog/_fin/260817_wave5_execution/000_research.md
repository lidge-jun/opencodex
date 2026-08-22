# 260817 Wave 5 execution — research and Gate 0 baseline

Campaign: execute the Wave 5A/5B/5C/5D + Wave 6 roadmap produced by the
2026-08-17 external audit, landing each item on `dev`, then promoting to
`preview` and `main`.

## Gate 0 baseline (verified 2026-08-17)

| Fact | Value | Evidence |
|------|-------|----------|
| local `dev` head | `1208bd25c` | `git rev-parse HEAD` after `--ff-only origin/dev` (44 commits fast-forwarded) |
| #1881 merge ancestry | present | `git merge-base --is-ancestor bb984ad47 HEAD` → exit 0 |
| #1909 ancestry | present | `b1708acc4 Merge pull request #1909` reachable |
| stable release | v2.24.2 | `origin/main` = `474584bcd Merge pull request #1914 from lidge-jun/release-2.24.2` |
| working tree | clean | `git status --porcelain` empty |

## Roadmap PR inventory at exact head

| PR | head | draft | review | checks | Wave |
|----|------|-------|--------|--------|------|
| #1899 | `8ab0aa8d0` | no | REVIEW_REQUIRED | 15 success | 5A |
| #1876 | `d5acd7414` | no | CHANGES_REQUESTED | 22 success, 1 skipped | 5A |
| #1888 | `cd3367193` | no | CHANGES_REQUESTED | 10 success | 5B |
| #1902 | `b8983c912` | no | REVIEW_REQUIRED | 10 success | 5B |
| #1884 | `99b0bbc38` | no | REVIEW_REQUIRED | 25 success | 5B |
| #1892 | `6b17d6233` | no | REVIEW_REQUIRED | 9 success | 5B |
| #1904 | `c603dcd83` | yes | REVIEW_REQUIRED | 6 success, 1 cancelled | 5B |
| #1898 | `7279aca7c` | yes | REVIEW_REQUIRED | 21 success, 1 cancelled | 5B |
| #1900 | `1824a0148` | no | REVIEW_REQUIRED | 10 success | 5C |
| #1895 | `8a4040384` | yes | CHANGES_REQUESTED | 12 success | 5C |
| #1887 | `ed4e87753` | yes | REVIEW_REQUIRED | 4 success | 5C |
| #1896 | `5d2aec482` | yes | REVIEW_REQUIRED | 7 success | 5C |
| #1903 | `54893ca6e` | no | REVIEW_REQUIRED | 10 success | 5C |
| #1889 | `ea64418a3` | yes | REVIEW_REQUIRED | **5 failure**, 6 success | 5D |
| #1891 | `10b88e155` | no | REVIEW_REQUIRED | 14 success | 5D |
| #1897 | `38c25aed8` | no | REVIEW_REQUIRED | 24 success, 1 cancelled | 5D |

## Correction to the external audit (P-phase finding)

The audit's #1894 remedy — "split direct Google mapping from Antigravity CCA
mapping" — describes a separation the tree **already has**:

- `src/adapters/google.ts` owns `GEMINI_DIRECT_WIRE_RENAMES` /
  `resolveDirectGeminiWireModelId()` for the direct AI Studio path.
- `src/providers/antigravity-models.ts` owns `GEMINI_FLASH_WIRE_ID` /
  `ANTIGRAVITY_MODEL_ALIASES` for the CCA path.
- `src/adapters/google.ts:395-399` already branches on provider family before
  choosing a resolver.

So the real defect is not a shared alias table. It is that
`GEMINI_DIRECT_WIRE_RENAMES` is an **unconditional** rename applied to every
direct Google deployment, while the rename is only true for some of them.
Commit `a70bb78d4` added it from a live capture where bare ids 404'd and
`-tiered` returned 200; #1894 reports the exact opposite from another account
on the same day. Both reporters are credible and neither is universal.

PR #1739 already implements the correct shape: a provider-level
`directGeminiWireRenames` boolean, defaulting to today's behavior. That makes
the deployment difference configurable but still ships a default that 404s for
the #1894 reporter.

Wave-5 decision: the default must stop guessing. See `010`.
