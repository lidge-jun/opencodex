# The native-restore thesis, tested against the code

Research doc. No diffs here — the implementation designs live in the decade
docs. This one records what the code actually does, because the previous
unit's plan was built on a claim the code does not support.

## The claim under test

`000_plan.md` asserts that Codex and Claude Desktop both need a durable
operation-state engine — a versioned discriminated journal entry, prepare/commit
with restart reconciliation, and a field-scoped config writer — before either
can get a toggle. The owner's counter-thesis: the proxy keeps RUNNING while a
client is switched back to its native path, so each client only needs to be
returned to a path that already exists, not replayed from a recorded snapshot.

For Codex the counter-thesis is correct, and the evidence is not subtle.

## Codex: the toggle pair already ships as a CLI

`ocx restore` is documented in `src/cli/help.ts:18-20` as:

> Restore native Codex config without stopping the proxy; `restore back`
> re-points codex at the running proxy.

That is the toggle, both directions, with the proxy up. `src/cli/index.ts:770`
calls `restoreNativeCodex()` with no lifecycle operation anywhere near it, and
`src/cli/index.ts:756` implements the enable direction as `syncModelsToCodex(live.port)`
against a proxy it first proves is live via `findLiveProxy()` (`:751`).

Stronger still: `POST /api/stop` (`src/server/management-api.ts:181`) calls
`restoreNativeCodex()` FIRST and only then schedules the drain and exit. The
restore therefore already executes while the listener is serving. Whether the
proxy later stops is irrelevant to the restore itself.

The service-stop path does verify the listener is gone before restoring
(`src/service.ts:2571`), but that check enforces the requested outcome "service
stopped" so success is not claimed while a supervisor respawns the process. It
is not a precondition inside `restoreNativeCodex()`.

**Conclusion:** no durable operation-state engine is required to make Codex
switchable. The disable path exists, the enable path exists, and both are
proxy-agnostic.

## What restore actually touches, and where it is not symmetric

Four state groups, when no external `model_provider` owns the config:

| Group | Restore behavior | Evidence |
|---|---|---|
| `config.toml` + `opencodex.config.toml` | Byte-exact from the journal when the injected hash still matches; otherwise strip owned fragments | `src/codex/journal.ts:109`, `src/codex/inject.ts:770` |
| Injection journal | Deleted on a complete restore, retained on a partial one | `src/codex/journal.ts:133` |
| Model catalog | Pristine backup + post-sync native additions, or drop slash-qualified routed rows keeping native ones | `src/codex/catalog/sync.ts:572-590` |
| Resume history | May update `state_5.sqlite`, patch/append rollout JSONL, consume the backup manifest | `src/codex/history-provider.ts:413,656,691` |

When an external provider such as `custom` owns `model_provider`, restore removes
only the stale journal and deliberately leaves everything else alone
(`src/codex/inject.ts:765`). That is a pre-existing courtesy to a user who moved
off us by hand, and the toggle must preserve it rather than "fixing" it.

Three asymmetries matter for the toggle's honesty:

1. **Enable is `syncModelsToCodex()`, not `injectCodexConfig()`.** Injection
   selects and writes a catalog path but does not build the routed rows;
   `src/codex/sync.ts:83-110` refreshes the catalog and then injects, and that
   is what `ocx restore back` uses. A toggle wired to bare injection would
   re-point Codex at a catalog that no longer lists the routed models.
2. **A post-injection root model selection is destroyed, not restored.** If the
   user edited config after we injected, the hash no longer matches, the
   fallback strip runs, and a root `model = "provider/slug"` line is removed
   (`src/codex/inject.ts:315,700`). Re-enabling has no record of that selection.
   The dialog copy must not promise to put it back.
3. **Resume history is reversible but not byte-identical.** Restore patches line
   one when safe and appends a `session_meta`
   (`src/codex/history-provider.ts:81,444`); re-enabling appends another
   provider change rather than deleting that history.

## The history lock, and why the current return shape is not enough

The write path mirrors Codex's five-second SQLite busy timeout and retries twice
with a 500 ms delay (`src/codex/history-provider.ts:25,526`). A Codex app or IDE
holding the WAL writer lock is exactly what makes it fail.

At the low-level boundary the failure is structured:

```ts
return withHistoryRetry(...) ?? { rows: 0, files: 0, failed: true };
```

Recoverable busy/lock/permission failures return `failed: true`; corruption and
programming errors throw (`src/codex/history-provider.ts:511,536,577`).

But `restoreNativeCodex()` discards that structure. `history.failed` only edits
the message string, and `success` stays `cfg.success`
(`src/codex/inject.ts:787,794`). A config restore that succeeded while the
history stayed locked returns roughly:

```
{ success: true, message: "... history could NOT be restored ..." }
```

So a GUI that trusts `success` reports a clean disable while routed threads stay
tagged `opencodex` and remain invisible in the native app. And `failed: true`
itself conflates lock contention with `EPERM`/`EACCES`.

**Design consequence for `020`:** the toggle route must not consume
`restoreNativeCodex()`'s boolean. It needs the structured per-artifact outcome —
config, catalog, history — with the history failure carrying a classified reason,
so the card can render "disabled, but your routed threads are still hidden
because the Codex app is holding the history database" instead of a green check
or a raw 500. Parsing the message string is not acceptable.

## The real hazard is not the socket

The sibling explorer's central finding, and the one that reshapes this unit:
**there is no persisted per-client desired state.** After a disable, the next
proxy startup, `ocx ensure`, `ocx sync`, a provider/model mutation, or
`POST /api/sync` can silently re-inject Codex (`src/cli/index.ts:318,365`,
`src/server/management/config-routes.ts:261`).

That is the actual engineering work this unit needs — and it is a much smaller
thing than the operation-state engine `000_plan.md` specified. A durable
desired-state flag per client, defaulting ON so no existing setup dies on
upgrade, consulted by every automatic apply path. It is a switch's memory, not a
rollback engine.

`030` and the durable-state design pick this up; `010` is retired as specified
because the crash-recovery machinery it described is not what the evidence asks
for.

## Observable consequences of a Codex disable

What the consequence dialog must actually name:

- plain `codex` returns to its native provider path (`src/codex/inject.ts:688`)
- routed `provider/model` catalog rows disappear; native rows survive
  (`src/codex/catalog/sync.ts:578,590`)
- the generated `opencodex` profile is removed or replaced, and managed native
  subagent defaults are restored or stripped (`src/codex/inject.ts:703`)
- previously routed threads are retagged to their native provider — or stay
  hidden if the history DB was locked (`src/codex/history-provider.ts:677`)
- the proxy keeps serving Claude, Grok, the exported file clients, and direct API
  callers, because restore contains no lifecycle operation at all

That last line is the whole point of the feature.
