# Evidence

Collected 2026-09-11 on the reporting Windows machine. Read-only except for
`bun install`, which populated `node_modules` so the verifier could run.

## 1. The clamp diagnostic outlives the binary it describes

`~/.opencodex/codex-runtime-clamp.json`:

```json
{
  "version": 1,
  "updatedAt": "2026-09-10T12:01:09.525Z",
  "runtimePath": "C:\\Users\\<user>\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
  "runtimeVersion": "0.135.0",
  "removedEfforts": ["max", "ultra"],
  "affectedModels": ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark",
    "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra",
    "anthropic/claude-fable-5-1", "anthropic/claude-opus-4-6", "anthropic/claude-opus-5"]
}
```

The binary at that exact path now reports `codex-cli 0.154.0`, and its own
bundled catalog carries both rungs:

```
$ codex debug models --bundled
... "slug":"gpt-6-astra" ... "supported_reasoning_levels":[
  {"effort":"low"...},{"effort":"medium"...},{"effort":"high"...},
  {"effort":"xhigh"...},{"effort":"max"...},{"effort":"ultra"...}]
```

`ocx status` nevertheless reports:

```
Codex version: 0.154.0
Catalog clamp: active
Removed efforts: max, ultra
```

and `ocx doctor`:

```
ok  Selected runtime: ...\codex.exe (0.154.0, source=configured)
!!  max and ultra were removed during catalog sync.
     Suggested: set CODEX_CLI_PATH to a newer Codex binary and run ocx sync.
```

The advice is impossible to follow — the selected binary is already the newer one.

## 2. Why: path equality short-circuits the version check

`src/codex/runtime.ts:431`

```ts
export function effortClampAppliesToRuntime(diagnostic, runtime): boolean {
  if (!diagnostic || diagnostic.removedEfforts.length === 0) return false;
  if (sameRuntimeCommand(diagnostic.runtimePath, runtime.command)) return true;   // <-- returns before version is read
  return Boolean(diagnostic.runtimeVersion && runtime.version
    && diagnostic.runtimeVersion === runtime.version);
}
```

The version comparison on the last line is only reachable when the paths
**differ**. An in-place upgrade — which is how the Windows Codex install updates —
keeps the path identical, so the stale diagnostic is treated as current forever.
Consumers: `src/cli/status.ts:250`, `src/server/management/config-routes.ts:283`.

## 3. Where the effort ladder is derived

- `src/codex/catalog/effort.ts:331` `codexSupportedReasoningEfforts` → `loadBundledCodexCatalog`
- `src/codex/catalog/bundled.ts:225` runs `debug models --bundled`
- `src/codex/catalog/bundled.ts:261` passes `discoverAlternatives: deps.discoverAlternatives ?? false`
- `src/codex/runtime.ts:603` `if (deps.discoverAlternatives === false) break;` — candidate search stops after the persisted entry
- `src/codex/runtime.ts:582` the persisted command is pushed first with source `configured`
- Applied at `src/codex/catalog/sync.ts:1945` and `src/codex/convergence.ts:382`

So the machine-wide ladder is whatever the persisted binary reports, with no
notion of which client will render it.

## 4. Card fields: deleted everywhere, carried nowhere — OPEN QUESTION

Delete sites:

| Path | Row kind | Fields |
| --- | --- | --- |
| `src/codex/catalog/metadata.ts:567` | alias | `availability_nux` |
| `src/codex/catalog/sync.ts:354` | routed | `upgrade = null`, `availability_nux` |
| `src/codex/catalog/parsing.ts:613` | routed | `availability_nux`, `upgrade` |
| `src/codex/catalog/reserve.ts:36` | reserve projection | `availability_nux` |

Client side, for reference (openai/codex at submodule HEAD):

- `codex-rs/protocol/src/openai_models.rs:409,410` — `ModelInfo.availability_nux`, `ModelInfo.upgrade`
- `codex-rs/tui/src/app/startup_prompts.rs:203,211` — NUX selection and a four-show cap
- `codex-rs/app-server/src/models.rs:31` — `upgrade` / `upgrade_info` forwarded to the desktop app

**Unresolved.** `src/codex/data/upstream-models.json:928` has `availability_nux: null`
for `gpt-6-astra`, and so does the live `debug models --bundled` output above. Only
`gpt-5.6-sol` and `gpt-5.5` carry copy in the bundled catalog. That means the
bundled catalog may simply not be where Astra's announcement lives — the account
endpoint `backend-api/codex/models?client_version=...` is the other candidate, and
it has not been probed. **Phase 3 builds a carrier; whether there is anything to
carry for Astra is not yet established.** Probing it needs a live ChatGPT account
token and is a user decision, not an agent one.

Separately, the `workspace-messages` channel (`headline` / `announcement`,
`codex-rs/backend-client/src/client.rs:651`) has zero references in this
repository. It is out of scope here and is gated client-side on
`auth.uses_codex_backend()` (`account_processor.rs:1307`), which is false for
`AuthMode::ApiKey` (`codex-rs/protocol/src/auth.rs:61`) — the mode produced by
`env_key` injection at `src/codex/inject.ts:327`.

## 5. Verifier, actually run

```
$ bun install
103 packages installed

$ bun test tests/codex-integration/codex-runtime.test.ts tests/codex-integration/catalog-go-exact-efforts.test.ts
42 pass, 0 fail, 160 expect() calls   # exit 0
```

Reads the change target: `tests/codex-integration/codex-runtime.test.ts:37` imports
`../../src/codex/runtime`; line 612 calls `effortClampAppliesToRuntime` directly.

A first attempt failed with `Cannot find module 'zod/v4'` before `bun install` —
recorded because "the verifier passed" would otherwise be unverifiable.

## 6. Not established

- Whether Astra carries announcement copy on the account catalog endpoint (§4).
- Which consumer should own the shared catalog when Desktop and CLI disagree.
- Whether any non-Windows install reproduces §1; the in-place-upgrade shape was only observed here.
