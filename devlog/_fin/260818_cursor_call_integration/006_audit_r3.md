# 006 — Audit round r3-20260818032759: FAIL, 5 findings, all accepted

Fresh reviewer (r1/r2's reviewer was retired; a final gate must not reuse a
contaminated one). Verdict **FAIL**: every CODE resolution passed, and the
integration/release WORKFLOW had five defects.

Round `r2` was aborted as inconclusive — its reviewer produced a NEAR-PASS report
but exited without the CLI recording a verdict, and an unrecorded verdict is not a
verdict (REVIEW-BINDING-01). Its three findings were already absorbed at
`2ea12062d`; `r3` re-verified them independently and they held.

## What passed (recorded, because a survived claim is evidence)

- **Rebase executability.** Every identifier in `010`'s literal block exists with
  compatible types, and the guard order preserves dev's precedence:
  incomplete-frame → zero-frame → existing terminal/expected close → open-tool
  truncation → assistant-text synthesis
  (`origin/dev:src/adapters/cursor/live-transport.ts:1016-1051`). dev's EOF tests at
  `tests/cursor-hardening.test.ts:396-600` stay consistent.
- **WP2b.** Moving `partialUsageFromEventState` down creates no cycle;
  `protobuf-events.ts` already has `OcxUsage`, the state fields, and
  `resolvedTurnUsage` (`:1340`). Reporting proven token consumption is correct even
  though the tool call was never committed.
- **Consumer trace.** `message-mapper.ts:29` forwards error usage; the bridge
  reports it only on the failed response and suppresses compaction history
  (`bridge.ts:1228-1253`, `:1800-1860`).
- **Collision set.** `fe2237038` is 31 commits / 28 paths (18 source+test, 10
  devlog). Live and local `origin/dev` both `e1bdbc1e5`; still only
  `live-transport.ts` and `google.ts` collide. No new collision.
- **Hidden dev behavior.** dev's parser, replay, tool-catalog-nudge, code-mode, and
  registry changes contradict none of the campaign's eight test files.
- **Governance wording.** Accurately an owner-authorized exception, not compliance
  (`MAINTAINERS.md:48-50`), and the no-Windows-surface claim is true of the 28-path
  diff.

## F1 (High) — the tested `dev` base was not pinned through merge

`dev` moves, and it moved twice during planning. `020` verified only the rebased
branch SHA, and `040`'s ancestry check runs *after* the merge. So GitHub could
construct a merge result nobody tested and put it on `dev`, with WP6 discovering it
afterwards.

**Accepted.** `020` now records `VERIFIED_BASE` from
`git ls-remote origin refs/heads/dev` — the LIVE head, following
`scripts/release.ts:327-335`, which uses `ls-remote` precisely because the local
tracking ref goes stale. `040` re-reads it before EVERY merge in the stack and stops
if it moved.

## F2 (High) — remote verification could destroy unrelated work

Both remote phases ran `git checkout -f` in the shared `~/Developer/opencodex`
checkout without proving it clean. That silently discards tracked uncommitted work —
in a phase that calls itself "verification only".

**Accepted.** `020` and `050` now use a dedicated `git worktree add /tmp/ocx-*`
and never touch the shared checkout's HEAD. `git worktree list` on lidge already
shows a dozen `/tmp/ocx-*` verification worktrees, so this is that host's existing
pattern, not a new invention.

## F3 (Medium) — an honest three-PR stack DOES exist

`r1` killed a fabricated adapter/bridge/docs split, and `030` over-corrected to one
PR. `r3` showed the campaign's own phase boundaries are already clean commits, with
no reordering needed:

| PR | Range | Commits |
|----|-------|---------|
| 1 | `<base>..dfb6fb884` | 17 — Cursor EOF + tool-result wire |
| 2 | `dfb6fb884..6d9744283` | 3 — unexpected CANCEL (depends on `emittedTerminal`) |
| 3 | `6d9744283..HEAD` | 15 — bridge/adapter terminals + integration docs |

Verified: PR1's file set is the Cursor wire files plus decode docs; PR2's is
`cursor-errors.ts`, `live-transport.ts`, its provenance test, and `040_*.md`; PR3's
is the bridge/adapter files. The dependency is real, not decorative — PR2's guard
reads PR1's `emittedTerminal`, and PR3's bridge logic is what makes PR1/PR2's error
events reportable.

**Accepted, and it restores what the user asked for.** `030` is rewritten as a real
stack; `020` adds a per-layer verification table because `AGENTS.md:178-180` wants
each layer's own evidence, not the tip's borrowed. Criterion `c6` goes back to
requiring a stack.

The lesson: `r1` was right that THAT split was fake, and `030` drew the wrong
conclusion from it — "no honest split exists" instead of "that split was the wrong
one". Absorbing a finding is not the same as absorbing its narrowest reading.

## F4 (Medium) — `build:gui` is not N/A for a readiness claim

`050` skipped it because no `gui/` path changed. But `prepublishOnly`
(`package.json:49`) runs `audit:high`, `typecheck`, and `build:gui` on **every**
publish regardless, and `build:gui` also runs `prepare:package` (`:46-47`).

**Accepted.** `build:gui` moves into both `020` and `050`. `lint:gui` stays N/A
with evidence. `050` must also state that publication additionally requires a
successful Cross-platform CI run AND a successful Service lifecycle run at the exact
release SHA (`scripts/release.ts:393-401`) — otherwise a "go" reads as if publishing
were one command away.

## F5 (Medium) — the release baseline was already stale

`050` said `origin/main = 474584bcd`; it is `0013b2347`. `v2.24.2` the TAG still
points at `474584bcd`, which is a different fact.

**Accepted.** `050` now requires reading `git ls-remote`, `npm view dist-tags`, and
`gh release list` at write time, and states both the tag target and the `main` tip
rather than conflating them. Same root cause as F1: this plan cannot cache a moving
ref.

