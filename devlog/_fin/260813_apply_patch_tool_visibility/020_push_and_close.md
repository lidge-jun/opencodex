# 020 — Push origin/dev only if 010 produced a code change

Consumes 010_decision_and_noop_or_fix.md. Unused on the NOOP path.

## File map

No new production files. This phase only:

1. Confirm git status contains only the intended fix + tests + this unit.
2. Leave unrelated untracked files (devlog/_plan/260813_bun_canary_dogfood, probe files, other units) unstaged.
3. Run bun run typecheck and the focused tests named in 010.
4. Commit with a message that names the actual defect, not the nested-hide investigation.
5. git push origin HEAD:dev (pre-approved for this investigation only).

## Accept criteria

- Push output shows origin/dev moved, or this phase is skipped because 010 recorded NOOP.
- Unrelated dirty/untracked files remain untouched.

## OUT

- force-push
- committing unrelated untracked units
- opening a PR unless later asked
