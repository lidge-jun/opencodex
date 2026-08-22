# Mixed `dev` split (2026-08-21)

One-time record. Fork-owned. Do not open as an upstream PR.

Source snapshot: `archive/mixed-dev-2026-08-21` (`f6c5ef1ed`).
Compared to `vendor/dev` after FF to `upstream/dev`.
Tool: `git cherry -v vendor/dev archive/mixed-dev-2026-08-21` plus `gh pr view`.

`git log vendor/dev..overlay` must stay the curated overlay (today: one `fork:` commit), not this 65-commit mix.

## DROP — already on `vendor/dev` (equivalent patch)

Keep the topic branches for history; do not cherry-pick onto `overlay`.

| Stack | Evidence |
|---|---|
| Cursor SelectedImage vision (#1742) | MERGED 2026-08-21. `git cherry` marks follow-up patches equivalent (`-`). `cursor/native-vision-selectedimage` is fully contained in `vendor/dev`. |
| OAuth structured-secret redaction (#2226) | MERGED 2026-08-21. Equivalent: `1435ec5f4` → `0a120da86`. |
| French Vision apostrophe docs | Equivalent on vendor (`748cfd0ce`). |

## FEAT-ONLY — still unique; leave on `feat/*` / open PRs

Do not fold into `overlay`. Rebuild `run/dev` if you need them locally.

| Stack | Where it lives | Upstream |
|---|---|---|
| Encrypted V2 passthrough | mixed archive only (no `feat/*` in this clone) | #2113 OPEN |
| Antigravity live quota / geoblock | `feat/antigravity-quota-geoblock` | #2068 OPEN |
| Antigravity account cooldowns | `feat/antigravity-account-cooldown` | #2069 OPEN |
| Antigravity Claude CCA wire | `feat/antigravity-cca-wire` | #2070 OPEN |
| Antigravity CCA host failover | `feat/antigravity-host-failover` | #2071 OPEN |
| Related google/CCA hardening on mixed tip (`f6c5ef1ed` and siblings) | mixed archive / hardening branches | not landed as that SHA |

Merge commits on mixed `dev` (`Merge PR #2113/#2226/#1742/#2071`) are not overlay material.

## FORK — local-forever overlay

| Commit | Branch |
|---|---|
| `fork: add public overlay sync playbook and registration seam` | `overlay` (cherry-picked onto current `vendor/dev`) |

## Not done here

- GitHub default branch still `origin/main` (upstream-shaped release). Do not switch until asked.
- `run/dev` not built (would re-mix open feat stacks).
- No push.
