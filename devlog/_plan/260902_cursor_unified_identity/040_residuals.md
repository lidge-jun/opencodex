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
