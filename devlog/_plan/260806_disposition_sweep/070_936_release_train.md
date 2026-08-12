# 070 — #936 security review, merge, and release train plan

User authorization (2026-08-06): owner delegates the #936 human security
review to this session; on PASS merge to dev, then run the full
dev→preview→main→npm train per `opencodex-release-train` procedure.

## Base (live)

| Ref | SHA / version |
|-----|----------------|
| origin/dev | `791e0fbf9` (v2.10.1 + #1097 + #1099) |
| origin/preview | `9ba45c85e` (2.10.1-preview.20260805) |
| origin/main | `99440ecd9` (2.10.1) |
| PR #936 head | `4874390dd` (open draft, merged-dev base b3a1d90a8 — two first-parent merge units behind (#1097, #1099; 15 reachable commits); merge-tree clean, no overlap with #1099's log.ts change) |

## wp1 — Security review scope (071 doc)

Owner-delegated review of the four hardening claims, diff-level, each with
threat model / bypass search / regression risk:

1. Vertex authority injection — `src/providers/google-vertex-location.ts`,
   `src/adapters/google.ts:440`, `src/server/auth-cors.ts:429`.
2. Durable Bun executable provenance — `bin/ocx.mjs:394`,
   `src/lib/bun-binary-validator.mjs`.
3. Claude ambient env fail-closed — `src/cli/claude.ts:76`, launcher
   provenance `bin/ocx.mjs:464` (incl. the maintainer's recorded reversal:
   all three slots fail closed without provenance).
4. Health management-token attestation — `src/oauth/health.ts:351/377`,
   `src/lib/local-management-attestation.ts`, server challenge at
   `src/server/index.ts:587`.

Also: workflows/release-automation touchpoints (MAINTAINERS.md blockers),
privacy:scan, and the merge-freshness question (base is 2 commits behind —
#1097 is devlog/test-only; #1099 changes src/usage/log.ts but does not
overlap #936's diff — merge-tree verified clean).
Parallel terra adversarial audit (fresh reviewer, not the wp-era one).
FAIL verdict = stop, report UNSAFE. No merge on a failed review.

## wp2 — Merge gates

ready-for-review → CI green on 4874390dd (or updated head if freshness
demands a dev merge-in) → `gh pr merge 936 --merge --match-head-commit <head>`
→ dev Cross-platform CI + Service lifecycle green on the merge SHA.

## wp3 — Train

Per release skill + audited convention (2.10.1 evidence: preview and main
carry SIBLING release-bump commits off the same dev source — promotion is
fast-forward of the chosen dev SHA to each branch, then an independent
`release.ts` bump on that branch; never merge preview's bump into main).
Version `2.10.2` (patch; the v2.10.0→v2.10.1 interval already carried
feat commits, so #1099's feat does not force 2.11.0). Order:

1. Choose release SHA on dev (post-#936 merge). FF-promote it to preview;
   run `bun scripts/release.ts 2.10.2-preview.<date> --tag preview
   --publish` on preview. release.ts itself waits for BOTH Cross-platform
   CI and Service lifecycle on the bump SHA (release.ts:321); release.yml
   re-enforces CI and conditionally Service lifecycle (release.yml:192).
2. FF-promote the SAME dev source SHA to main; run `bun scripts/release.ts
   2.10.2 --tag latest --publish` on main. Same double gate on the main
   bump SHA.
3. Converge dev (merge the release bumps back or per convention); push.
4. Verify: `npm view @bitkyc08/opencodex dist-tags --json`, three branch
   tips, final workflow conclusions, main-checkout stashes intact.

Rollback: `npm dist-tag add @bitkyc08/opencodex@<prev> latest`.

## Ledger

| Step | Evidence |
|------|----------|
| #936 security review | 071 doc: owner-delegated direct review + adversarial terra audit (019fd548) — both PASS; verdict PASS recorded |
| #936 merge | ready-for-review → CI re-ran green → `gh pr merge --merge --match-head-commit 4874390dd` → merge commit `9795aeb50` on dev |
| dev gates on 9795aeb50 | Cross-platform CI success; Service lifecycle success |
| preview promotion | FF `9ba45c85e → 9795aeb50` pushed; `release.ts 2.10.2-preview.20260806 --tag preview --publish` → published (npm dist-tag preview = 2.10.2-preview.20260806; GitHub pre-release created) |
| main promotion | FF `99440ecd9 → 6865c005d` (dev moved +2 PRs between preview cut and main cut — merged since preview cut: #1094 CI gate hardening, #1101 issue-quality fix); release.ts local-preflight hit the known `cursor-native-exec-shell` 5s timeout flake (reproduced passing in isolation; identical flake seen on #1097 CI) → manual release.ts continuation: bump `246850263` pushed, CI + Service lifecycle green on the SHA, `release.yml` dispatched with `expected-sha` → publish success |
| stable release | npm dist-tag latest = 2.10.2; GitHub Release v2.10.2 marked Latest |
| dev convergence | merged main + preview release bumps into dev; package.json conflict resolved to `2.10.2`; typecheck clean; dev pushed `bf063b57b` |
| Working-tree safety | main/preview promotion worktrees were clean; user stashes in main checkout untouched (6 preserved); no dirty files were present or harmed |
