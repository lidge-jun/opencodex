# 040 Release (wp4): 2.71.0

Same procedure as devlog/_fin/260929_sonnet_5_5_catalog/040_plan_release.md.

Candidate = dev tip after the 030 merge (tree has version sources 2.71.0). The push-event CI run on
that merge commit is informative; the gating runs are on the promotion SHAs.

1. Pre-move dev: `gh workflow run dev-version-bump.yml --ref main -f intended-version=2.71.0 -f mode=pre-move`;
   the opened PR must change only the four version sources to 2.72.0 (package.json,
   desktop/src-tauri/Cargo.toml, Cargo.lock, tauri.conf.json); merge it with --admin --squash
   --match-head-commit (as #6213).
2. Preview: branch `codex/promote-preview-2-71-0` from the candidate, `git merge -s ours origin/preview`,
   `bun scripts/release-version-sources.ts sync 2.71.0-preview.20260929`, commit, PR to preview,
   merge commit. Wait for push-event Cross-platform CI and Service lifecycle success on the
   preview head. Dispatch `gh workflow run release.yml --ref preview -f version=2.71.0-preview.20260929
   -f tag=preview -f dry-run=false -f expected-sha=<preview head>`.
3. Stable: branch `codex/promote-main-2-71-0` from the candidate, `git merge -s ours origin/main`
   (tree equals candidate), PR to main, merge commit. Wait for push-event CI + Service lifecycle on
   the main head. Dispatch release.yml on main with version=2.71.0, tag=latest, dry-run=false,
   expected-sha=<main head>.
4. Verify: `npm view @bitkyc08/opencodex dist-tags --json` shows latest=2.71.0 and
   preview=2.71.0-preview.20260929; `gh release view v2.71.0` (not prerelease, full asset set) and
   `v2.71.0-preview.20260929` (prerelease); latest.json reports 2.71.0 with signed platforms.
5. Write 090_outcome.md with run IDs and SHAs, move the unit to devlog/_fin/, land on dev through a
   docs PR.

Guards: verify preview tree differs from candidate only in the four version sources and main tree
equals the candidate. A failing promotion run is fixed through dev and re-promoted. If a release
run fails after npm acknowledged publication, re-dispatch with resume-after-npm-publish=true and the
same expected-sha; never republish.
