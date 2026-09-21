# Rebasing this branch

Checked 2026-09-20 against `upstream/dev`: 27 commits on the branch, 16 on dev
since the merge-base at `29e796b0a`. It rebases with one conflict and one
regeneration.

## The conflict

`.gitignore`, every time. Upstream appends to the same region this branch does
(`.red-running`, for the red-test lock). Both sides are wanted; keep both.

## The regeneration

`skills/ocx/references/01_management_surface.md` is generated, and this branch
edits it because it adds a route. Any capability upstream adds makes the
branch's copy stale — the last rebase moved it from 49 declared to 50, and
`bun run skill:surface:check` fails until it is regenerated:

```bash
bun scripts/generate-ocx-skill-surface.ts
```

This is inherent to carrying a generated file in a branch, not a defect. Do it
as the last step before offering the branch, never earlier, because it goes
stale again the moment dev moves.

## Then

```bash
bun run check          # 2.6s: typecheck, gates, red tests, guard coverage
bun run test:changed   # ~4 min: the full affected suite
bun scripts/check-known-failures.ts <log>   # the six that are not ours
```
