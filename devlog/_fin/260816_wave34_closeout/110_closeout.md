# 110 — Execution order and gates

## Order (smallest verified risk first)

1. `010` #1802 — regression only, then close.
2. `020` #1837 — latency term.
3. `030` #1789 — workspace outcome split.
4. `040` #1784 — typed cause.
5. `050` #1791 — quota windows v2.
6. `060` #1835/#1838 — CLI set/unset via `mutatePersistedConfig`.
7. `070` #1823 — scoped signature replay.
8. `080` #1830 — catalog serialization evidence (PR #1832).
9. `090` #1524 — capability preflight.
10. `100` #1686 — bearer admission + guaranteed substitution. Security review required.
11. `101` #1049 — legacy home adoption. AFTER `100`.
12. `102` #1798 — restore three-way merge. AFTER `101`.

One decade doc per PABCD work-phase — which is why the three large units are `100`, `101` and `102` rather than one document.

Units touching the same file are sequenced, not parallel:

- `100`, `101` and `102` ALL edit `src/codex/inject.ts`; they run strictly in that order, each rebased onto the previous.
- `030`, `040` and `050` all sit in the Codex account/catalog area (`src/codex/routing.ts`, `quota.ts`, convergence); run them in listed order.
- `060` edits `src/cli/config-command.ts` and `090` edits `src/server/responses/core.ts`; neither overlaps the above.

## Gates

- Per unit: focused `bun test <files>` named in that unit.
- Per merge: exact-head CI green. Contributor branches need their workflow runs AUTHORIZED first — `action_required` is not a pass. A push to a contributor head resets readiness; re-authorize and re-request.
- Per wave: `ssh lidge` `bun test --isolate tests`, compared against a `dev` run at the same commit. A failure present on both sides is not a regression; a failure present only on the branch is.
- Per merge: `git merge-base --is-ancestor <sha> origin/dev`.
- Per close: `gh issue view <n>` shows `CLOSED`.

`dev` is protected by a pull-request rule, so every change lands as a PR and is merged with admin authority. No `main` promotion, no tag, no publish; close comments say the fix is on `dev` and ships with the next release.

## Known environment caveats

- The four Windows shards fail under `workflow_dispatch` on `dev` ITSELF (168 failures, symmetric on both sides). They are skipped on the ordinary `pull_request` path. Do not read them as a branch regression; they deserve their own issue.
- The macOS suite has produced a Bun segfault (`panic: Segmentation fault`, RSS 3.6GB) unrelated to any assertion. Rerun once before treating it as real.

## Explicitly out of scope

- `#1795` stays open until a live SenseNova/Kimi reproduction runs.
- W4-01/02/04 are already landed; verify only.
- PR #1840 is already merged; the roadmap's rebase warning is moot.
