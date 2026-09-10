# Residuals

Known-and-accepted gaps, parked here rather than left in prose (audit B14). Each says what
is wrong, why it was not fixed in its cycle, and what evidence would change the decision.

## R1 — effort ladders on a listed fast id (wp4)

`/v1/models` stamps `grokEffortFields(m.reasoningEfforts, …)` from the BASE row, but a fast
variant's ladder can be shorter: `claude-opus-5` runs to `max` while its `fast` spec stops
at `high` (`catalog.ts` CURSOR_CAPABILITIES). With `fastMode: true` a client could therefore
request `max` against a listed `-fast` id.

Not fixed in wp4 because the resolver clamps: `cursorVariantEffort` picks the top rung the
variant actually declares, so an over-request degrades to `high` rather than failing. The
cost is an advertised rung that silently clamps, not a broken request.

Fix when: a user reports an effort selection that appears to do nothing on a fast id. The
change is to thread the resolved variant spec into the listing branch instead of reading the
base row's ladder.

## R2 — `claude-4-sonnet-1m` stays a separate row (wp2)

It is a real upstream wire id, not `claude-4-sonnet` + ultra, and `claude-4-sonnet` carries
no `maxModeVerified` evidence — folding it would invent a capability. So "1M" still means two
things in the picker: a synthetic ultra marker for `kimi-k3`, and this genuine second row.

Fix when: live `GetUsableModels` proves `claude-4-sonnet` supports Max Mode, at which point
the row folds into the base the same way `kimi-k3-1m` did.

## R3 — `fastMode` carries two meanings (wp4)

One flag drives OpenAI's `service_tier: "priority"` and Cursor's fast VARIANT. These are
different products with different ladders. The overload is deliberate — both express "go
faster" — and is recorded so a later reader does not read it as an accident.

Fix when: a user needs one on without the other. That is a second flag, not a re-interpretation of this one.

## R4 — pre-existing red outside this unit

`bun run test:changed` at `42731a4be` reports 14461 pass / 5 fail. All five reproduce on a
clean stash of this branch, so none is caused by this unit:

- `tests/cli-capabilities.test.ts` — "every management route is capability-covered"
- `tests/…` CL-07 task effectiveness producer (4 tests)

Not this unit's to fix. Recorded so a later cycle does not mistake them for a regression it
introduced.

## R5 — `agent-task-recovery` is red on dev itself (landing cycle, 2026-09-02)

While landing this stack, `test 3/4` failed on the rebased PR #3222 head:

```
(fail) agent task recovery (opt-in, default off)
      > keeps the disabled fail-fast response byte-identical to the absent feature
  tests/agent-task-recovery.test.ts:53   Received: 502
```

Not caused by this stack. Reproduced on a DETACHED checkout of pure `origin/dev`
HEAD `b54508c8c` (`fix(agents): allow Codexless V2 task recovery (#3241)`): same one
failure, 18 pass / 1 fail. The surrounding commits `#3239` -> `#3240` -> `#3241` are a
live repair chain in that area, so the red is theirs to close.

Recorded so a later reader does not attribute it to the Cursor identity work, and so the
landing decision is auditable: the stack was merged with this pre-existing failure present
on the base branch, not introduced by it.

**Closed 2026-09-02, by dev, not by this unit.** `#3242`
(`revert(subagents): drop the synthesized native chain for encrypted spawns`) reverted
`#3239` and `#3240`. On the resulting `origin/dev` the file is green:

```
$ bun test tests/agent-task-recovery.test.ts
19 pass / 0 fail
```

The mechanism matches the diagnosis recorded above: the synthesized native chain rewrote
`xai/grok-4.5` to `gpt-5.5` for BOTH the absent and the disabled config, so the final route
was native and the honest 400 gate (`core.ts` "encrypted child tasks may only reach the
canonical native backend") never fired - the request went out and the fixture's throwing
`fetch` turned it into a 502. With the chain gone, `applySubagentModelFallback` returns
`null` for all three config shapes and the 400 is restored. No follow-up PR needed.

## Landing record (2026-09-02)

The stack landed on `dev` in dependency order, each with exact-head CI green and ancestry
proven by `git merge-base --is-ancestor` against a freshly fetched `origin/dev`:

| PR | merged head | squash commit |
|---|---|---|
| #3222 umbrella seed + labels | `419e89625` | `7aa64bb0bf1700482c74064a4d7523a5a960cf11` |
| #3225 cursor-variant Fast toggle | `61d6d38d9` | `83838e7fab0e2b1a23ab86dee4ef606f25eeb8d6` |
| #3233 fastMode -fast listing | `f26169712` | `8d2dd66398450974e28ec158aed4a77862f0cdf7` |

Maintainer `--admin` cleared only the `Protect dev` ruleset's review requirement. No red
check was bypassed: every merged head reported zero FAILURE conclusions.

Each child was re-stacked by CHERRY-PICKING its unique commits onto the landed parent, not
by rebasing. A parent squash absorbs the child's content under a different commit id, so a
plain rebase conflicts against work that is already in the base - the hazard the stacked-PR
rules warn about, observed here on #3225.

### Closeout verification (landed dev `21416a7af`)

```
git merge-base --is-ancestor 7aa64bb0b FETCH_HEAD   -> OK   (#3222)
git merge-base --is-ancestor 83838e7fa FETCH_HEAD   -> OK   (#3225)
git merge-base --is-ancestor 8d2dd6639 FETCH_HEAD   -> OK   (#3233)
git merge-base --is-ancestor 21416a7af FETCH_HEAD   -> OK   (#3243, this record)

bun run typecheck                                    exit 0
bun test (11 files: cursor-*, fastwire-policy, claude-*, codex-catalog,
          agent-task-recovery)                       662 pass / 0 fail
```

No PR from this unit is left open. Remote branch deletion is refused by the repository
ruleset, which is expected protection and does not affect the landings.
