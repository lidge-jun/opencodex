# 050 — 2.64.0 release outcome

## Result

The 2.64.0 release round is complete. The verified `dev` candidate
`a1131f521b644c09f43c924a615ea48dfca5b607` shipped to both channels.

| Channel | Version | Promotion merge | Release run | npm dist-tag |
|---|---|---|---|---|
| preview | 2.64.0-preview.20260923 | `836321b33e` (#5670) | [35843685057](https://github.com/lidge-jun/opencodex/actions/runs/35843685057) | `preview` |
| stable | 2.64.0 | `4cb43cb0a8` (#5671) | [35847101363](https://github.com/lidge-jun/opencodex/actions/runs/35847101363) | `latest` |

Both release runs completed successfully. Both GitHub releases are public, with 25
assets each. `releases/latest/download/latest.json` serves `2.64.0` and has a
signature for each of its five platform entries. Direct npm registry reads after
propagation reported `latest=2.64.0` and
`preview=2.64.0-preview.20260923`.

## Pre-release close-out

- Critical desktop dependency update: #5661 merged as `a1131f521b`.
  `tauri-plugin-shell` is pinned to `=2.2.1` in Cargo.toml and Cargo.lock.
  The [full-platform branch run](https://github.com/lidge-jun/opencodex/actions/runs/35835959962)
  finished with 39 successful jobs; a privacy gate skip was expected for dispatch.
  #5525 closed after the update reached `main`.
- Privacy scan complement: #5662 merged as `da662a30ee`. A pull request skipped by
  `gates` now runs the dedicated `privacy gate` job. The exact-head PR CI passed.
- Request-owned main selection: #5663 merged as `f2e8045140`. A request's own
  main credential no longer changes shared active-account state. The exact-head
  PR CI passed after tests were moved to a registered sibling file to satisfy the
  file-size ratchet.
- Reviews of #5471, #5456/#5653, #5469 and #5024/#5654/#5655 were performed.
  The two confirmed findings were fixed in #5662 and #5663 before the candidate
  was selected. Unreleased review details were kept out of this tracked unit.

## Verification and operations

- The `dev` candidate passed [lane=all run 35840680817](https://github.com/lidge-jun/opencodex/actions/runs/35840680817):
  39 successful jobs and the dispatch-only privacy gate skipped as designed.
- The dev pre-move #5666 merged as `685321e297`, taking `dev` to 2.65.0
  before either publication. Its PR Cross-platform CI and Service lifecycle passed.
- The preview promotion's push Cross-platform CI
  [35843639351](https://github.com/lidge-jun/opencodex/actions/runs/35843639351)
  and Service lifecycle [35843639372](https://github.com/lidge-jun/opencodex/actions/runs/35843639372)
  passed on `836321b33e`. The Linux `test 1/4` batch timed out once only when
  twelve files ran together; the one job passed on its second attempt. All other
  requested jobs succeeded.
- The stable promotion's push Cross-platform CI
  [35843612570](https://github.com/lidge-jun/opencodex/actions/runs/35843612570)
  and Service lifecycle [35843612468](https://github.com/lidge-jun/opencodex/actions/runs/35843612468)
  passed on `4cb43cb0a8`.
- The owner directed the two promotion PRs to merge before their PR checks
  finished. Their release-branch push checks succeeded before publication,
  as enforced by `release.yml`.
- The first preview publish attempt reached its CI gate before the preview push
  run passed; only the failed publish job was rerun. The stable packaging run
  started before the preview retry, so it was cancelled to preserve the required
  preview-before-stable version order, then the stable release was dispatched
  again. Publication was not repeated for either version.
- Local tests, typecheck and build: NOT RUN. Hosted CI above is the execution
  evidence.

## Residuals

Three medium Dependabot alerts remain in the desktop lockfile:
`serde_with`, `time` and `glib`. They are separate dependency work.
No release blocker remains from this round.
