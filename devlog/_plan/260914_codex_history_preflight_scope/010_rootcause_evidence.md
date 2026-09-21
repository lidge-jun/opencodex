# 010 — Root-cause evidence

The chain below was verified by direct execution on the affected machine.
Nothing here is inferred from logs alone.

The original write-up treated step 6 as a defect this unit would close
in the same pass as the apply-path veto. That was wrong. Automated
review on https://github.com/lidge-jun/opencodex/pull/4531 (the
incident review was `structure/`-aware; the P1 came from the
automated Codex reviewer) kept the remove and restore hard refusals.
Step 6 remains a description of the original home, not a completion
claim.

## Symptom, restated as observed state

| Surface | Observed |
|---|---|
| Codex version | `0.154.0-alpha.6.2` |
| Desktop picker | six built-in OpenAI models only |
| CLI picker | six built-in OpenAI models only |
| `ocx sync --restart-app-server-only` | printed `Model catalog synchronized`; restarted the app-server |
| `~/.codex/opencodex-catalog.json` | correct the whole time; 24 models |
| `~/.codex/config.toml` | only `experimental_realtime_ws_base_url`; no `model_catalog_json` |

The catalog file was never the defect. A successful-looking sync that
leaves `config.toml` without `model_catalog_json` is the failure.

## Verified chain

### 1. Current Codex writes paginated rollout files

The first JSONL line of a current rollout carries an `ordinal` field.

### 2. `assertLegacyHistoryRecord` rejects that shape

`src/codex/history-provider.ts:279-290` throws
`CodexHistoryIntegrityError("history_paginated_requires_native_writer")`
for any record with `ordinal` present or
`payload.history_mode === "paginated"`.

### 3. Preflight catches the throw and returns the reason string

`preflightCodexHistoryInjection` (`src/codex/history-provider.ts:337-376`)
catches that error and returns `history_paginated_requires_native_writer`.

On the affected machine both of these returned that reason:

- `preflightCodexHistoryInjection(true, true)`
- `preflightCodexHistoryInjection(false, false)`

### 4. `injectCodexConfig` used the reason as a hard veto

`injectCodexConfig` treated the preflight reason as a veto on the entire
config write and returned `success: false` before any file was touched.
`model_catalog_json` and the routing keys never reached
`~/.codex/config.toml`.

Verified on disk: `config.toml` contained only
`experimental_realtime_ws_base_url` and no `model_catalog_json`.

### 5. `syncModelsToCodex` hid the veto

`syncModelsToCodex` (`src/codex/sync.ts`) special-cased exactly that
reason and downgraded it to a catalog-only result with `ok: true` and
the message

```text
Model catalog synchronized; Codex config and conversation history left unchanged because paginated history requires its native writer.
```

That is what made the apply-path regression silent. The operator, and
`--restart-app-server-only`, were told the catalog had synchronized.

### 6. The same preflight gated remove and restore — and still does

The same preflight also gated `removeCodexConfig`,
`restoreCodexConfigInlineImpl`, `restoreNativeCodex`, and
`restoreNativeCodexAsync`.

On the affected machine, 3 thread rows out of 14164 were tagged
`model_provider = 'opencodex'`. Those 3 rows were enough to deadlock
apply, remove, **and** restore at the same time.

This unit closes only the apply side of that deadlock, and only for
`history_paginated_requires_native_writer`. Remove and restore keep
the original hard refusal. The first draft claimed those directions
could proceed because they open no state database and no rollout.
Review rejected that: stripping `[model_providers.opencodex]` while
thread rows still reference it makes those conversations
unresolvable, and the restore path has no seam for keeping a
compatibility provider table. The uninstall deadlock on an
already-paginated home is therefore still open. A later fix needs
that keep-the-table seam; it is not implied by the apply-path
stand-down.

## What this chain does and does not prove

It proves the picker failure is an apply-path config-write veto, not a
catalog-file miss and not an app-server restart miss. The sidecar
catalog was already right; the app-server did restart; `config.toml`
never gained `model_catalog_json`.

It does not authorize writing paginated rollout bytes or retagging
thread rows. The native-writer refusal on the history unit remains
correct for that shape: Codex allocates paginated rollout ordinals in
its own writer, and no retry changes that. That is why only
`history_paginated_requires_native_writer` stands the relabel unit
down. Other reasons stay hard refusals so a transient miss cannot be
recorded as a converged transition.

It does not prove that remove and restore were vetoed by mistake.
The original analysis asserted they were; review showed the opposite.
Those refusals stay.
