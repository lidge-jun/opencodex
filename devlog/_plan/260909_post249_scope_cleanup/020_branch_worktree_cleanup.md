# 020 — branch and worktree cleanup

Evidence standard: local branches deleted only with PR MERGED (gh) or
ancestor-of-origin/dev proof (recon lane B + main-session spot checks).
Branches checked out in surviving worktrees were kept.

## Worktrees

- Removed 54 clean /private/tmp worktrees (248-a/248-b lane workers, axis1-5,
  bug6, track1-3, release-246/247 workers, prs-stack, sponsors, etc.). Clean
  worktree removal loses nothing: every branch ref was retained unless itself
  merged (below).
- Kept: main checkout (dirty local dev, user-owned), this session's ae6a,
  all ~/.codex/worktrees app-managed slots (app owns their lifecycle),
  ~/.cursor/worktrees/opencodex/njhf.
- Dirty merged worktrees left for owner review (uncommitted devlog notes):
  8fd91167 (voice-contract-0908), cb55 (pr3997), d974cb89 (bug6-01a07e9d-close),
  plus 5 detached /var/folders tmp dirs.

## Local branches: 144 deleted

Merged-PR branches (squash, anc=0 but gh MERGED) and ancestor-merged branches:
248-a/248-b/248-c lanes, 260904-260909 wp/train lanes, 260907 a-e letters,
axis1/2/3/5, bug6-01a07e9d set, a/b/c-track, prs-l1-l6, rt-m1-m8,
release-244/246/247/248/249 lines, pr-39xx/40xx/41xx aliases, sponsors/*,
codex/providers-home-and-quota-refresh, codex/security-pr-lane-20260909
(same SHA as stale local dev), etc. 208 local branches remain (orphan
roadmap/diagnostic/rb-*/jrb-*/*-evidence set with no PR and no ancestry —
kept pending owner review, they hold the only copy of that work).

## Remote branches (origin): 8 deleted

- codex/models-provider-head-uniform-row (#3096 MERGED)
- codex/providers-home-and-quota-refresh (#3472+#3466 MERGED)
- codex/release-245-candidate-519b (ancestor of origin/dev)
- fix/post-layout-guard-regressions (#3532 CLOSED, carried via #3865 MERGED)
- ingw/fix-chat-json-sse-parity (#3779 CLOSED)
- ingw/fix-container-codex-volume (#3747 CLOSED)
- ingw/fix-reasoning-envelope-budget (#3862 CLOSED, superseded by #3879 MERGED)
- ingw/type-safety-registry-modularization (#2805 CLOSED)

Kept on origin: open-PR heads (improved-remote-control #3458,
ingw/fix-4110-owned-root-guidance #4114) and ~40 orphan evidence branches
(assets/*, media/*, *-evidence, diagnose-*, track*) — no PR ref backup exists
for these, so deletion would be unrecoverable; owner decision required.
