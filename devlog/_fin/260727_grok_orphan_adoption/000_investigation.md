# 000 — investigation: Grok Build reports 200k for every model (#511)

## Reproduced symptom

Grok Build's TUI shows a 200k context window for models that are far larger:
`gpt-5.6-sol` is 372k, `xai/grok-4.5` and `cursor/grok-4.5` are 500k. 200k is not a
value opencodex ever writes — it is Grok's OWN fallback, used whenever a model entry
carries no `context_window` key.

## Live evidence (this machine, `~/.grok/config.toml`)

The file contains 46 `[model.*]` tables. The opencodex managed block runs from line
196 to line 397. Everything ABOVE line 196 is outside our fence:

```toml
[models]
default = "ocx-gpt-5-6-sol"        # line 13 — points at the ORPHAN

[model.ocx-gpt-5-6-sol]            # line 23, OUTSIDE the fence
model = "gpt-5.6-sol"
base_url = "http://127.0.0.1:10100/v1"
api_backend = "chat_completions"
api_key = "opencodex-loopback"
name = "OCX gpt-5.6-sol"
                                   # <- NO context_window: Grok falls back to 200k

# >>> opencodex managed block — do not edit (removed by `ocx stop`) >>>   # line 196
[model.ocx-gpt-5-6-sol-2]          # line 197, INSIDE the fence
model = "gpt-5.6-sol"
api_key = "opencodex-loopback"
name = "OCX gpt-5.6-sol"
extra_headers = { "x-opencodex-grok" = "1" }
context_window = 372000            # <- correct, but nothing selects this alias
# <<< opencodex managed block <<<                                        # line 397
```

The same doubling exists for `terra` (372k), `luna` (372k), and every other model that
predates the fence. Models added later — `alibaba-token-plan-intl/glm-5.2` (1M),
`cursor/grok-4.5` (500k), `xai/grok-4.5` (500k) — appear ONCE, inside the fence, with
the right `context_window`. That split is the tell: the orphans are a historical
residue, not something the current writer produces.

## Root cause (two cooperating behaviours)

**1. The fence is the only thing we rewrite.** `injectGrokConfig`
(`src/grok/inject.ts:227-245`) splices `content.slice(0, region.start) + block +
content.slice(region.end)`. `stripGrokConfig` does the same in reverse. Anything above
`region.start` is untouched by construction, for any number of re-syncs.

**2. Everything outside the fence is presumed user-owned.**
`userModelAliases` (`src/grok/inject.ts:93-103`) scans the content outside the managed
region and reserves EVERY `[model.<alias>]` header it finds. `buildGrokManagedBlock`
then routes around those reserved aliases, which is why the regenerated entry is
`ocx-gpt-5-6-sol-2` rather than `ocx-gpt-5-6-sol`.

Together these produce a stable, self-perpetuating wrong state: each `ocx sync` writes
a CORRECT duplicate beside the stale original, and never removes the original. The sync
reports success, the managed block is genuinely perfect, and the user still sees 200k —
because `[models] default` and the model picker resolve the un-suffixed alias.

## Why the alias-suffix mechanism is not itself the bug

The suffix logic exists for a real hazard, documented at `src/grok/inject.ts:64-74`: a
`[[model.x]]` array-of-table colliding with a generated `[model.x]` makes Grok reject
the ENTIRE config layer with a duplicate-key error, taking every unrelated user setting
with it. Reserving user aliases is correct. The defect is that the reservation cannot
tell an actual hand-written model from opencodex's own escaped output.

## Ownership signals available on an orphan

Every orphan on this machine carries all three:

| Signal | Strength | Note |
|---|---|---|
| `api_key = "opencodex-loopback"` | strong | a literal we own; no reason for a human to type it |
| `base_url = "http://127.0.0.1:<port>/v1"` | medium | a user CAN legitimately point at the local proxy |
| `name = "OCX <id>"` / alias prefix `ocx-` | weak | a human could name a model this way |
| `extra_headers = { "x-opencodex-grok" = "1" }` | strong | present on newer writes only — absent on the oldest orphans |

The oldest orphans predate `extra_headers`, so the header alone is insufficient as the
sole adoption key; it would leave exactly the entries causing this bug unadopted.

## Blast radius of getting adoption wrong

- **False positive** (adopting a genuine user model): we delete a hand-written entry.
  Unrecoverable from the user's point of view, though `config.toml.bak-opencodex`
  exists. This is the failure to design against.
- **Dangling reference:** removing an orphan that `[models] default` or
  `[ui] fork_secondary_model` names leaves Grok pointing at a nonexistent alias. On
  this machine `default` DOES name an orphan, so this is the common path, not an edge.

## Non-goals for this unit

Reformatting or normalizing user content outside the fence, changing the alias
allocation scheme, and touching `stripGrokConfig`'s removal semantics beyond the
adoption sweep.
