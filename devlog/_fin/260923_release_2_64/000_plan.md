# 260923 release 2.64 — plan

## Objective

Ship the verified `dev` tree as preview `2.64.0-preview.20260923` and stable `2.64.0`
after closing the two items that kept the previous readiness answer at "not yet":

1. The critical Dependabot alert on `desktop/src-tauri` (GHSA-c9pr-q8gx-3mgp,
   `tauri-plugin-shell` below 2.2.1).
2. Missing security-review records for the CI, release and account-routing changes
   merged by the parallel batch (#5471, #5456, #5653, #5469, #5024, #5654, #5655).

The owner authorized PR creation, admin squash merges to `dev`, promotion merges to
`main` and `preview`, and release dispatch for this round.

## Starting state (2026-09-23 07:50Z)

| Ref | Commit | Version | Evidence |
|---|---|---|---|
| `dev` | `fa81e5a2a7` | 2.64.0 in all four version sources | lane=all run 35828289232, every job success, privacy gate skipped by design |
| `main` | `96b1406cb6` | 2.63.0 | npm `latest`, release v2.63.0 |
| `preview` | `5bec58cdda` | 2.63.0-preview.20260923 | npm `preview` |
| Dependabot #5525 | `d6dea8f246` (base `main`) | tauri-plugin-shell =2.2.1 | applies to `dev` cleanly, merge tree `11d41e0b70` |

Open Dependabot alerts on `desktop/src-tauri/Cargo.lock`: critical `tauri-plugin-shell`,
medium `serde_with`, `time`, `glib`. Only the critical one is in scope. `glib` 0.20
needs a GTK binding upgrade that the pinned Tauri line does not take; `serde_with` and
`time` are transitive and are recorded as residuals for a later dependency round.

## Constraints

- No local test, typecheck, build, install, cargo or ocx run. Hosted CI at the exact
  head is the only execution evidence. Helper scripts that read state (version-source
  check, merge-tree, gh reads) or rewrite the four version sources
  (`release-version-sources.ts sync`) are allowed; neither executes the product.
- Skipped, cancelled, missing or older-head results are not success. A Windows job that
  fails once on a known runner stall is rerun once; a repeat is a defect.
- No timeout increase, platform skip, weakened assertion, or ratchet cap raise.
- Security analysis stays in scratch space outside this repository's tracked tree. This
  unit records only that each review happened and how findings were dispositioned.
- Pushes use `--no-verify`; merges use `--admin` with `--match-head-commit`.

## Work-phase map (dependency order)

| Phase | Doc | Consumes | Produces |
|---|---|---|---|
| wp1 | this unit | current state | locked roadmap |
| wp2 | [010](010_wp2_prerelease_items.md), [011](011_wp2_privacy_gate_complement.md), [012](012_wp2_request_owned_main_cursor.md) | wp1 | `tauri-plugin-shell` 2.2.1 on `dev`; review records; fixes for the two confirmed findings |
| wp3 | [020](020_wp3_dev_candidate.md) | wp2's final `dev` SHA | fixed candidate SHA with a fully green lane=all run |
| wp4 | [030](030_wp4_release.md) | wp3's candidate | dev pre-move, promotions, both releases, channel verification |

Each phase closes with something checkable from GitHub alone: a merged PR with its
exact-head run, a dev run ID, release run IDs and registry state.

## Verifiers

| Script (scratch) | Reads | Proves |
|---|---|---|
| `check-wp1.sh` | this unit | numbered docs, no private review detail, no absolute user paths |
| `check-wp2.sh` | PRs, `origin/dev`, Dependabot API | the three wp2 PRs merged at their verified heads with green exact-head runs, `Cargo.toml` pins `=2.2.1` on `dev`, review and second-review reports present |
| `check-wp3.sh` | the candidate run | every job `success` except the privacy gate skip, run head equals candidate |
| `check-wp4.sh` | npm registry, GitHub releases, `latest.json` | channel versions, release assets, updater signatures |

## Terminal outcomes

DONE when wp4's verification passes. BLOCKED on a confirmed security blocker that
cannot be fixed inside this round or on a repeated CI defect. UNSAFE if a release gate
would have to be bypassed. NEEDS_HUMAN on a policy decision this plan does not cover.
