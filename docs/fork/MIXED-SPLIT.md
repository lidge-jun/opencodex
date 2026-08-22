# Mixed `dev` split / release-pin rebuild (2026-08-21)

One-time record. Fork-owned. Do not open as an upstream PR.

Source snapshot: `archive/mixed-dev-2026-08-21` (`f6c5ef1ed`).
Release base: `vendor/main` (`231e622be`), fast-forwarded from `upstream/main`.
Compared with `git log vendor/main..overlay` plus the selected GitHub PR heads.

The release-pin overlay is the curated `fork:` stack on `vendor/main`, not the
mixed 65-commit archive. At review time it contained six existing `fork:`
commits (the review fixes are additional `fork:` commits):

| Commit | Purpose |
|---|---|
| `66655a2e0` | add public overlay sync playbook and registration seam |
| `8bf3a0565` | record mixed-dev commit classification |
| `3a8ced4e4` | spec daily driver on released `upstream/main` |
| `38cee8420` | pin daily docs to released main |
| `570e89da3` | update OWNED merge sides for `vendor/main` |
| `6e2533fac` | pin sync guidance to released main |

Use `git log vendor/main..overlay` to verify the final stack remains
`fork:`-only. The overlay is based on `vendor/main`, never on `vendor/dev`.

## DROP — contained by `vendor/main`

DROP decisions use containment in `vendor/main`. Presence on `vendor/dev` alone
is not enough: a patch still absent from the released pin must remain in the
daily `main` replay (via `run/main`, then merge).

| Stack | Evidence |
|---|---|
| Cursor SelectedImage vision (#1742) | MERGED 2026-08-21. `git cherry` marks follow-up patches equivalent (`-`); drop only because the equivalent patch is contained in `vendor/main`. |
| OAuth structured-secret redaction (#2226) | MERGED 2026-08-21. Equivalent: `1435ec5f4` → `0a120da86`. |
| French Vision apostrophe docs | Equivalent on `vendor/main` (`748cfd0ce`). |

## FEAT-ONLY — still unique; leave on GitHub `feat/*` / open PRs

Do not fold these into `overlay`. Replay the GitHub `feat/*` PR heads onto
`run/main` (then merge into daily `main`) if you need them locally; local `feat/*` branches are not required.

| Stack | Where it lives | Upstream |
|---|---|---|
| Encrypted V2 passthrough | mixed archive only (no `feat/*` in this clone) | #2113 OPEN |
| Antigravity live quota / geoblock | GitHub `feat/antigravity-quota-geoblock` | #2068 OPEN |
| Antigravity account cooldowns | GitHub `feat/antigravity-account-cooldown` | #2069 OPEN |
| Antigravity Claude CCA wire | GitHub `feat/antigravity-cca-wire` | #2070 OPEN |
| Antigravity CCA host failover | GitHub `feat/antigravity-host-failover` | #2071 OPEN |
| Named subagent role catalog | GitHub `feat/subagent-roles-config` | #2257 OPEN |
| Named subagent role GUI | GitHub `feat/subagent-roles-gui` (stacked on config) | #2257 stack |
| Named subagent role sync | GitHub `feat/subagent-roles-sync` (stacked on GUI) | #2257 stack |
| Related google/CCA hardening on mixed tip (`f6c5ef1ed` and siblings) | mixed archive / hardening branches | not landed as that SHA |

Merge commits on mixed `dev` (`Merge PR #2113/#2226/#1742/#2071`) are not overlay material.

## FORK — local-forever overlay

| Commit | Branch |
|---|---|
| Six commits listed above | `overlay` on `vendor/main` |
| Review-fix `fork:` commits | `overlay` after the six-commit release-pin stack |

## Rebuild result

`run/main` was rebuilt from `vendor/main`, the overlay, and the selected feature
heads in stack order. It was pushed with `--force-with-lease`; the review-time
tip was `1d67b7472`, and the post-review overlay replay tip is recorded in
`.superpowers/sdd/fix-final-review.md`.

The full `bun run test` check remained red with 32 failures in the Task 5
environment: sandbox-denied `/bin/ps` process assertions, temporary Git hook
permission errors, and unrelated credential/admission, independent-review,
route-inventory, and Google tool-result tests. The fork-focused tests and
typecheck were green, and no failure was caused by the overlay or `src/fork`;
this is not a merge blocker for the `origin/main` overlay.
