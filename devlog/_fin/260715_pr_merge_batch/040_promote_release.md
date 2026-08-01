# 040 — Promote dev -> main -> preview and deploy npm release

Work-phase: `wp4-promote-release`. One full PABCD cycle. Runs only after 010/020/030
cycles closed with green tests.

## Preconditions (P re-check)

- dev holds all 4 PR merges + stacked fixes, working tree clean, tests+typecheck green.
- No new commits appeared on origin/main since planning (re-fetch and diff).

## Steps (B phase)

1. Push dev: `git push origin dev`.
2. Wait for Cross-platform CI green on dev head (`gh run watch` / `gh run list`).
3. Merge to main: `git checkout main && git merge --ff-only dev && git push origin main`
   (fast-forward expected since main==old dev ancestor; if NOT ff-able, STOP — new
   upstream commits landed on main; integrate them into dev, rerun the full gate
   (test/typecheck/CI), then retry. No blind --no-ff fallback.)
   Pushing main makes GitHub auto-mark PRs #128/#129/#130/#132 merged (head SHAs are
   ancestors of main via the --no-ff merges).
4. Merge to preview: `git checkout preview && git merge --ff-only main && git push origin preview`.
5. Release from main: `git checkout main` FIRST (step 4 leaves the tree on preview; the
   release helper rejects a stable version from the preview branch), then
   `bun run release 2.7.19 --publish` (verified: script defaults to
   dry-run without `--publish`; it does bump+commit+push+workflow dispatch with
   dry-run=false only when the flag is present); then `bun run release:watch` or
   `gh run watch`.
   NOTE: the release bump commit lands on main AFTER step 3; re-sync dev/preview to
   include the release commit afterwards (`git merge --ff-only main` on both, push).
6. Verify: `npm view @bitkyc08/opencodex version` == 2.7.19, `gh release view v2.7.19`.
7. PR closeout: confirm all 4 PRs show MERGED (`gh pr view <n> --json state`); comment
   thanks + release version on each; if any shows CLOSED-not-MERGED, comment
   merged-via-dev with the landing commit SHA.

## Verification (C phase)

- CI green on dev/main/preview heads (run URLs recorded).
- npm version + GitHub Release proof captured into goalplan criteria c4/c5.
- Live proxy note: user's running `ocx` picks up the new version only after
  reinstall/restart — mention in final report, do not restart it unasked.
