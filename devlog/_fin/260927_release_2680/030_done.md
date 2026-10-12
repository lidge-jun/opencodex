# 030 — done: 2.68.0 release round

## Outcome

2.68.0 shipped from candidate `f764765c6453a718806d3465ea966015fa233123` as preview `2.68.0-preview.20260927` and
stable `2.68.0`. `dev` carries 2.69.0 (#6053). The main..dev regression review found three release blockers; all
were fixed in #6052 before the candidate was cut, together with the Windows/Linux tray parity the owner asked for.

## Evidence

- Regression review: seven astra lanes over main..dev (86 commits); dispositions in [000](000_plan.md) and [010](010_wp4_blockers_and_tray.md).
- #6052 exact-head PR CI: 31 pass, 6 skipped; merged as `f764765c64`. Its tree is the candidate.
- Promotion: #6054 `preview` `09081803c5`, #6055 `main` `93f4231e4b` (merge commits).
- Release-branch CI: preview Cross-platform CI `36294469680` (23 success, 5 skipped) and Service lifecycle `36294469713`;
  main Cross-platform CI `36294473376` (23 success, 5 skipped) and Service lifecycle `36294473362`.
- Release runs: preview `36295546215` success (14/14), stable `36296387672` success (14/14).
- GitHub releases: `v2.68.0` (25 assets, prerelease false, target `93f4231e4b`) and `v2.68.0-preview.20260927`
  (25 assets, prerelease true, target `09081803c5`). `latest.json`: 2.68.0 with signatures for darwin-aarch64,
  darwin-x86_64, windows-x86_64, linux-x86_64 and linux-x86_64-deb.
- npm: `preview` = `2.68.0-preview.20260927` after registry propagation; the stable publish was acknowledged with
  provenance and `latest` is checked again after propagation (the preview took about ten minutes).

## Release-note items

- Codex App inline visualizations work with every routed model (#6040, #6045).
- Windows/Linux tray: provider marks, 70%/90% quota colors, and switching the active account (#6052).
- Remote Link: Home-initiated links keep 2.67.0 forwarding; Child-initiated links require the tunnel ownership proof.
- Kiro: account model discovery, quota metrics, device login, concurrency caps, 1M GPT-5.6 context windows; failed
  discovery backs off.
- Items listed by the review lanes in [000](000_plan.md) (combo cooldowns, stall defaults, desktop title strip, and others).

## What did not go to plan

- The first candidate lane=all run failed `test 2/4` on a batch timeout whose files all passed alone (runner stall);
  it and the second candidate run were superseded or cancelled to free macOS runners. The candidate's tree was
  covered by #6052's exact-head CI and by the push-event CI on both promotion commits.
- The pre-move PR (#6053) was merged without PR CI under the owner's heuristic rule; workflow-token PRs do not start CI.
- A 2.67.0-era Child join whose sidecar was deleted before its first 2.68.0 start still forwards like 2.67.0 (owner decision).
