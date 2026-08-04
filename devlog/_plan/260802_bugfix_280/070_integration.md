# 070 — Integration: land codex/bugfix-280 on origin/dev + close issues

Date: 2026-08-02. Landing plan for the five fixes (010-050) developed on
branch `codex/bugfix-280` in worktree `/Users/jun/Developer/opencodex-bugfix280`.

## Constraints

- The MAIN worktree (/Users/jun/Developer/opencodex) hosts another active
  session with unpushed local commits and an uncommitted file. Do not touch
  it: all integration happens in the bugfix worktree.
- Push is pre-approved by the owner for this scope: fast-forward only, no
  force, target origin/dev.

## Steps

1. `git fetch origin`; `git merge origin/dev` into codex/bugfix-280.
   Audit note: from merge base 55ce981d only src/codex/catalog/sync.ts
   changed on both sides and `git merge-tree` shows zero conflict markers;
   registry.ts changed only on origin/dev, devlog only on our branch.
2. Post-merge verification: `bun run prepush` (typecheck + GUI lint + FULL
   test suite + privacy scan — the required pre-push gate; focused suites
   alone are insufficient per AGENTS.md). Preflight: never stage the
   untracked node_modules symlink.
3. Immediately before push, `git fetch origin` again and require
   `git merge-base --is-ancestor origin/dev HEAD` (the FF guarantee is only
   as fresh as the last fetch). Then `git push origin codex/bugfix-280:dev`.
   No force.
4. Watch the dev-branch CI run; require EVERY job green for the exact pushed
   SHA (Linux/macOS/Windows, GUI gates, privacy scan, npm-global smoke —
   MAINTAINERS.md holds direct pushes to the same bar). The Windows leg is
   the runtime proof for #864 (Bun#32111 stall).
5. Comment + close issues 858, 855, 859, 864, 857 with the merge SHA and CI
   outcome. #848 stays open (its fix rides PR #861; rebase instruction
   already posted).

## Failure handling

- Non-fast-forward push → stop, report (NEEDS_HUMAN).
- Any CI job red for the pushed SHA → do NOT close the issues; report and
  investigate as a new work-phase.

## Results (2026-08-02, executed)

- Merge: 808b885c (zero conflicts; 74 files from origin/dev merged in).
- prepush: typecheck, GUI lint, full suite 6911 pass 0 fail (480 files),
  privacy scan, react-doctor — all green.
- Push: 253455bc..808b885c → origin/dev (FF verified immediately before
  push).
- CI run 30733116558: all 7 jobs success for the exact pushed SHA, incl.
  the Windows leg (#864 runtime proof).
- Issues closed with fix-reference comments:
  - 858 (comment 5155571704)
  - 855 (comment 5155571918)
  - 859 (comment 5155574271)
  - 864 (comment 5155574529)
  - 857 (comment 5155574750)
- 848 stays open: fix rides PR #861 (rebase instruction posted earlier).
