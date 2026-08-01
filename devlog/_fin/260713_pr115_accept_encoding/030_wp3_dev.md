# WP3: full verification and dev landing

## Gates

```sh
bun test --isolate tests
bun run typecheck
bun run privacy:scan
bun run build:gui
git diff --check
```

## Review

- Run an independent final diff review accounting for every changed file and the merge topology.
- Confirm the exact contributor SHA remains in `git merge-base --is-ancestor 75109049 HEAD`.
- Reject any implementation that unconditionally overwrites an explicit caller encoding.

## Landing

- Commit only the hardening/test follow-up; `.claude/` remains untracked.
- Push `dev` and wait for every Cross-platform CI and package-install job.
- Record commit SHA and workflow URL before closing the work-phase.

## Acceptance

- Full suite and all local gates exit zero.
- Reviewer says `VERDICT: PASS`.
- `origin/dev` contains both contributor and hardening commits and CI succeeds.

## Captured evidence

- Full local gate: `2400 pass`, `0 fail`, `10047 expect()` calls across 229 files.
- `bun run typecheck`, `bun run privacy:scan`, `bun run build:gui`, and `git diff --cached --check` exited zero.
- Contributor merge: `150873e6`, preserving `75109049` as a parent-line ancestor.
- Scoped hardening commit: `54462c0f337779cc6055467a9e2f09479bebeb44`.
- Dev CI: https://github.com/lidge-jun/opencodex/actions/runs/29223561042
- All six jobs passed: Bun and npm-global matrices on Windows, macOS, and Ubuntu.
