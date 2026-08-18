# 100 — Closeout

## Order of execution

1. `010` Wave 0 triage (GitHub metadata only).
2. `020` `#1805`, `#1806` + test strengthening, close `#1786`.
3. `030` `#1741`, `#1825`, close/reclassify `#1824`.
4. `040` `#1817` + Cursor absorption, close `#1801`.
5. `050` `#1819` hardening, close `#1785`.
6. `060` `#1788` streaming state fix, close `#1700`.
7. `070` `#1780` allocator, close `#1767`.
8. `080` `#1792` null normalization + sponsorship, close `#1668`.
9. `090` `#1703` redesign, close `#1697` **only if the redesign actually lands with its evidence**; otherwise record the contract, keep the PR on design hold, and report the phase outcome honestly.

Each numbered unit is one PABCD work-phase. No two decade docs are implemented in one build phase.

## Verification contract

- Per unit: focused `bun test <files>` named in that unit's doc.
- Per wave: `ssh lidge` full suite in `/home/lidgeai/Developer/opencodex` with `bun test --isolate tests`, reporting pass/fail counts. Raw `bun test` in that checkout bleeds environment state across files and is not acceptable evidence.
- Per merge: `git merge-base --is-ancestor <sha> origin/dev`.
- Per close: `gh issue view <n> --json state` showing `CLOSED`.

## Authority and constraints

- Merges land on `dev` under maintainer authority. `main` promotion, tags and npm publish are out of scope; every close comment says the fix is on `dev` and release is pending.
- Local pushes use `--no-verify` per the operator's standing instruction for this loop; the substitute evidence is the remote suite, not the local hook.
- Contributor-branch CI is `action_required` and cannot be treated as green. Authorize the workflow runs and get the exact-head matrix **before** merging; `MAINTAINERS.md` requires maintainer approval plus successful CI, and post-merge testing is not a substitute. Windows-specific changes (`#1805`, `#1806`) specifically require the native Windows shards — the Linux `ssh lidge` suite cannot stand in for them.
- Any push to a contributor head resets review readiness and exact-head evidence: re-authorize CI and re-request approval after each such push.
- Units that touch the same file must be sequenced and rebased, not merged in parallel. `050` (`#1819`), `080` (`#1792`) and `090` (`#1703`) all edit `src/config.ts`, and `080`/`090` both edit `src/types.ts`. Execute in that order, rebasing each onto the previous head and re-auditing before sponsorship or approval.
- `#1795` stays open. `#92`, `#417`, `#1049`, `#1798`, `#1802` stay open.
