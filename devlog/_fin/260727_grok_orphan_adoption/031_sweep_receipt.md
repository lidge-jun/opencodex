# 031 — sweep receipt against the REAL config

Run on a COPY of this machine's `~/.grok/config.toml` (`/tmp/grok-sweep-probe/.grok/`),
never the live file. Original preserved at `/tmp/grok-config-before-511.toml`.

## Before

```
model tables:                 69
tables WITHOUT context_window: 40
default:                      "ocx-gpt-5-6-terra"   (an orphan, no context_window)
```

## After one sync

```
result:                       { ok: true, changed: true }
model tables:                  6   (one per catalog model)
tables WITH context_window:    6   (all of them)
model tables above the fence:  0
default:                      "ocx-gpt-5-6-terra"  -> still defined, now WITH context_window = 372000
```

## Counting caveat worth recording

A first pass reported "23 orphans survived". That was a MEASUREMENT error, not a code
defect: `rg -c '^\[model\.'` also counts `[model.<alias>.extra_headers]` sub-tables,
which the writer emits for every entry. Counting real model tables needs
`'^\[model\.[^.]+\]$'`. Recorded because the wrong pattern makes a correct sweep look
broken, and the same trap is waiting for whoever verifies this next.

## Idempotence (F7)

A second sync over the swept file:

```
2nd run changed: false | bytes identical: true
```

## User content preserved (F1)

`[cli]`, `[ui]` (including `fork_secondary_model = "grok-build"`, a genuine user value),
and `[marketplace]` with its sources are all intact after the sweep.

## What this does NOT yet prove

That Grok's TUI reads the corrected file. That requires the user to restart via
`ocx service` and a visual check — `030` step 2, criterion `c-live`.

## Field state the fixture did not model (found at WP3, fixed)

Inspecting the live file before the restart turned up two things the synthetic fixture
never reproduced. Both came from Grok Build re-serializing the config into its own
format:

**1. The marker comments are GONE.** `rg '>>> opencodex managed block' ~/.grok/config.toml`
returns nothing. Grok rewrote the file and dropped our comments. `findManagedRegion`
then returns `null`, so the whole file is in scope and the ownership predicate is the
ONLY thing protecting the user's own entries. That is survivable exactly because the
predicate is conjunctive (`api_key` AND loopback `base_url` AND plain header) — a
position-based rule would have had nothing left to stand on.

**2. Sub-tables kept the alias reserved.** Grok also promotes inline
`extra_headers = { ... }` into a separate `[model.<alias>.extra_headers]` table. The
first implementation removed the parent table only, leaving that child behind — and a
leftover child still matches `MODEL_TABLE_HEADER`, so `userModelAliases` kept reserving
the alias. The sweep removed the parent and STILL allocated a suffixed duplicate: the
exact #511 loop, one level down.

Fixed by extending each orphan's span to swallow its own `model.<alias>.*` children.
Pinned by a test that reproduces the real shape (no markers, parent + `.extra_headers`
child + a hand-written model that must survive).

Re-verified against a copy of the live file: 46 model tables -> 3, all three carrying
`context_window`, `default` still resolving, `[ui] fork_secondary_model` intact.

**Lesson for the next verifier:** the fixture passed 10/10 while the real file was still
broken. Field state beat the synthetic case, which is why `030` insists on the live
check rather than treating green tests as the finish line.
