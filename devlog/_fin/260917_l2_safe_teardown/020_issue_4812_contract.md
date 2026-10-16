# 020 — Degraded restore: separate routing recovery from history

Issue #4812. Parent PR, branch `codex/restore-routing-without-history`.

## The defect, stated as a decision error

`preflightCodexHistoryInjection` answers one question — "may I rewrite Codex
conversation history?" — and four call sites use that answer to decide a
different question: "may I take OpenCodex routing out of `config.toml`?"

```ts
const historyError = preflightCodexHistoryInjection(false, false);
if (historyError) return { state: "failed", ... };
```

`src/codex/inject/restore.ts:260-261`, `:275-276`, `:371-372`, `:519-520`, and
`src/codex/inject/remove.ts:145-146`

Because `assertLegacyHistoryStore` refuses on the mere *presence* of a
`history_mode` column (`src/codex/history-provider.ts:397-400`), and every
current Codex build has that column, the answer is permanently no. The config
half is therefore permanently unreachable, and `ocx uninstall` removes the
proxy while leaving the routing that points at it.

The fix is not to weaken the guard. The guard is right about history. It is
being asked the wrong question.

## Contract

### Two classes of owned state

**Routing state** — makes *every* `codex` invocation go through the proxy:
marker-owned root `openai_base_url` and `experimental_realtime_ws_base_url`,
root `model_provider = "opencodex"`, a routed root `model`, an OpenCodex
`model_catalog_json`, `[profiles.opencodex]` and the generated profile file,
and the managed subagent defaults.

**Thread-resolution state** — `[model_providers.opencodex]` and its
sub-tables. It affects nothing unless a thread row names that provider id.

Routing state is what strands the user. Thread-resolution state is what the
history guard is protecting. They are separable, and `010` establishes that
separating them in this direction is safe while the opposite direction is
catastrophic.

### The rule

When `preflightCodexHistoryInjection` returns
`history_paginated_requires_native_writer` **and nothing else**, restore takes
the degraded path:

- All routing state is removed, through the existing journal-or-strip logic,
  unchanged.
- `[model_providers.opencodex]` is retained verbatim, including its ownership
  marker.
- The history relabel is **skipped, not attempted**. No rollout byte, thread
  row, or manifest entry is touched. The native writer stays the only writer.
- The outcome is reported as degraded, never as a plain success.

Every other refusal reason — `history_injection_preflight_unavailable`,
`history_state_database_missing`, and the rollout-integrity codes — keeps the
existing hard refusal and its compensating rollback, byte for byte. This is
the exact asymmetry the apply direction already encodes as
`HISTORY_RELABEL_STANDS_DOWN` (`src/codex/inject.ts:472-484`); restore is
being brought into line with it, not given something new.

### Atomicity

`010` shows that a config containing root `model_provider = "opencodex"`
without a matching table fails `Config::load` outright. The degraded write is
therefore **one** `atomicWriteFile` of fully-computed content. The
implementation must not strip and then re-add as two writes, and must not
leave that combination reachable through an error path.

The seam is a verbatim capture, taken before the transform and re-appended
into the same output buffer:

- `extractOcxProviderTableBlock(content): string | null` — new pure function
  in `src/codex/inject/remove.ts`, the exact inverse of the existing
  `removeOcxSection` scan (`:50-80`), sharing `isOcxProviderHeaderLine` so the
  two cannot drift on what counts as our table.
- `removeCodexConfig({ retainProviderTable })` re-appends the captured block
  after the strip, before the single write.
- `restoreCodexConfigInlineImpl` captures the block from the on-disk config
  **before** the journal restore, because an exact journal restore replays the
  original pre-injection bytes and deletes the journal
  (`src/codex/journal.ts:258-293`). After a successful journal restore the
  captured block is re-appended inside the same lock and the same preimage
  window.

Verbatim capture, rather than rebuilding the table from the live routing
target, is deliberate. Rebuilding needs a port and a config that `uninstall`
is in the middle of removing, and it would silently change the retained
definition. Capture cannot.

### Reported outcome

`CodexRestoreArtifactState` gains `"partial"`. `CodexRestoreConfigResult.action`
gains `"routing-restored-provider-retained"`. The envelope gains:

```ts
retainedCodexProviderTable?: {
  reason: "history_paginated_requires_native_writer";
  /** Exact config.toml lines left on disk. */
  lines: string[];
  /** What to run to remove them, and what breaks if you do. */
  followUp: string;
};
```

`success` stays `true`: the routing restore genuinely succeeded and the
dead-address trap is gone. The residue is a deliberate, named outcome rather
than a hidden failure, which is what completion criterion 1 asks for —
stored, effective, and still-owed are three separate fields, not one boolean.
A degraded restore that *fails* is still a failure and keeps today's handling.

`historyPreflightRefusal` keeps its current meaning — "nothing was attempted
at all" — and must therefore **not** be set on the degraded path, because
`src/cli/index.ts:813-818` reads it together with three `skipped` artifacts to
decide that a stop obligation is still owed. A degraded restore discharged
the config obligation, so the receipt must be released, not preserved.

### Caller obligations

Report B found that seven of eight callers reduce the result to `.success`.
They keep working unchanged, which is the point of keeping `success: true`.
Three need real changes:

- `ocx restore` (`src/cli/dispatch.ts:194-240`) prints the retained lines and
  the follow-up command; `--json` carries the new field.
- `ocx stop` (`src/cli/index.ts:796-825`) must classify degraded as neither
  `historyDeferred` nor `other`. The obligation was performed; exit stays `0`
  and the receipt is discharged.
- `ocx uninstall` (`src/cli/index.ts:1357-1360`) no longer records a failed
  step, so `failures` stays empty and `~/.opencodex` is removed
  (`:1393-1410`). It prints the retained lines. This is the concrete end of
  the trap: uninstall completes, native Codex works, and the user is told
  exactly what is left and why.

### Full removal, on request

`ocx restore --remove-codex-provider-table` strips the table too. It states
before acting that `opencodex`-tagged threads will stop opening, and it is
never implied, never defaulted, and never selected by `stop` or `uninstall`.

### `ocx status`

A config with `[model_providers.opencodex]` but no OpenCodex root routing is
retained residue, and status says so, with the removal command. Report B
confirms status has no such line today
(`src/codex/inject/routing-classify.ts:55-107` classifies endpoint ownership
only), so residue is currently invisible.

## What this does not do

- It does not make `opencodex`-tagged threads work after teardown. They point
  at a proxy that is gone. They open, and their requests fail with an ordinary
  connection error instead of a config-load error.
- It does not touch conversation history on a paginated home, ever.
- It does not add a `--force` that bypasses the history guard. There is no
  such flag, because there is no safe version of it.
