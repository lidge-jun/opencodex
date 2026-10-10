# 020 — Newly Discovered Models Arrive OFF by Default

Status: design proposal (no code). Scope: discovery baseline, policy setting, API/GUI surfacing, migration.

## Motivation

Providers with `liveModels: true` (src/providers/registry.ts:165; most rows, including openrouter) re-fetch their `/models` endpoint on catalog sync. Any model the vendor publishes overnight appears in the user's Codex picker on the next refresh, silently. That is the wrong default for a proxy that routes real spend: a new model can be more expensive, unvetted, or a duplicate snapshot. The user should opt models IN as they arrive, not race to turn them off.

## Current behavior (verified)

- Visibility is two persisted filters composed in `filterCatalogVisibleModels` (src/codex/catalog/provider-fetch.ts:1555-1577): a per-provider allowlist `providers.<name>.selectedModels` (non-empty = only these ship; empty/absent = ALL discovered models ship — src/types/provider.ts:262-268) and a global blocklist `config.disabledModels` (src/types/config.ts:391).
- With an EMPTY allowlist, every newly discovered model is immediately visible: it is not in `disabledModels` and there is no allowlist to exclude it.
- With a NON-EMPTY allowlist, newly discovered models are already effectively off — they are not in `selectedModels`, so the filter drops them. The problem is exclusively the empty-allowlist ("all on") state, which is the default for every provider.
- There is no persisted record of which models a provider was known to have: the live model cache is in-memory with a 5-minute TTL (src/codex/model-cache.ts:15, DEFAULT_MODEL_CACHE_TTL_MS), and the on-disk Codex catalog is a rendered artifact, not a per-provider baseline. Nothing today can distinguish "newly discovered" from "always been there".
- `/api/model-visibility` PUT (src/server/management/model-routes.ts:285-390) mutates both filters atomically; enable with scope=provider clears the allowlist entirely (line 350), enable with scope=models appends to a non-empty allowlist (line 368-371).

## Design

### Core mechanism: persisted known-model baseline

A model is "new" iff it is discovered now and absent from the last persisted baseline. Add to config:

```jsonc
{
  "modelDiscovery": {
    "newModelPolicy": "off",              // "off" | "on" | "inherit"  (per-install default)
    "knownModels": {                      // baseline: native ids seen per provider
      "openrouter": {
        "ids": ["anthropic/claude-opus-4.6", "..."],
        "removed": [],
        "updatedAt": "2026-08-24T00:00:00Z"
      }
    },
    "recentArrivals": {                   // ring buffer for the GUI "new" badge, max ~50/provider
      "openrouter": [ { "id": "x-ai/grok-5", "at": "2026-08-24T02:11:00Z" } ]
    }
  },
  "providers": {
    "openrouter": { "newModelPolicy": "off" }   // per-provider override of the global policy
  }
}
```

- `newModelPolicy`: `"on"` = today's behavior (new arrivals visible). `"off"` = new arrivals hidden until enabled. Per-provider `"inherit"` (or absent) falls back to the global value; global absent = `"on"` for existing installs (see Migration) and `"off"` seeded for fresh installs.
- `knownModels` stores NATIVE ids (the same form `selectedModels` uses). It is written only after a SUCCESSFUL live fetch for that provider — a failed or partial fetch must never shrink the baseline, otherwise a provider outage would mark the entire catalog "new" on recovery. Sorted, deduped, size-bounded per provider (cap ~2000 ids; over cap, policy degrades to "on" for that provider with a logged warning rather than corrupting the baseline).

### Applying the policy at catalog convergence

Hook point: the catalog gather path that already runs on every convergence (`gatherRoutedModels` → `filterCatalogVisibleModels`, provider-fetch.ts). After a provider's live fetch succeeds and before visibility filtering:

1. `newIds = discovered − knownModels[provider].ids − knownModels[provider].removed` (first run with no baseline: everything is "known", nothing is new — baseline bootstrap must not hide the whole catalog).
2. If effective policy is `"off"` and `newIds` is non-empty:
   - Empty allowlist ("all on") case: append `routedSlug(provider, id)` for each new id to `config.disabledModels`. The blocklist is the right store here because it composes with an empty allowlist without freezing it — seeding `selectedModels` with the full current list would convert "all on" into a frozen snapshot and silently change the meaning of the user's existing state. The blocklist grows only by genuinely new arrivals.
   - Non-empty allowlist case: do nothing. The allowlist already excludes new ids; adding blocklist rows would be redundant state to reconcile later.
3. Record arrivals in `recentArrivals` and update the baseline.
4. Persist via `saveConfigPreservingClaudeCode` once per convergence (single write, all providers batched).

Existing user choices are never flipped: the step only APPENDS blocklist entries for ids that were not in the baseline, and `slugEquals`-matching entries already present are not duplicated. A user who enables a new arrival removes its blocklist row through the existing `/api/model-visibility` enable path — the baseline already contains the id by then, so the next refresh does not re-disable it.

Models that DISAPPEAR from a provider's catalog are removed from the active baseline only after N=3 consecutive successful fetches without them (vendor list flapping is real); their blocklist rows are left alone (harmless, and the model may return). Removal is NOT deletion: pruned ids move to a compact per-provider tombstone list `knownModels[provider].removed: string[]` (ids only, same size bound). The newness test is `newIds = discovered − ids − removed`, so a model that leaves and later returns is never "new" again. This is what makes the correctness claim hold unconditionally: the union `ids ∪ removed` grows monotonically across successful fetches, so each id can be auto-disabled at most once, ever — including the flapping case where a user enabled the model, the vendor dropped it long enough to prune the active baseline, and it then returned. A rename still counts as new (the new id was never in either set), which remains the safe reading.

### Scenario walkthrough (correctness check)

State: openrouter, empty allowlist (all on), policy "off", baseline B = {a, b, c}.

| Event | discovered | new = disc − B | action | user-visible result |
|---|---|---|---|---|
| Refresh, vendor adds d | {a,b,c,d} | {d} | append `openrouter/d` to disabledModels; B←{a,b,c,d}; record arrival | a,b,c shown; d hidden with NEW badge |
| User enables d | — | — | existing enable path removes blocklist row | d shown; badge cleared |
| Next refresh | {a,b,c,d} | {} | none (d ∈ B) | d STAYS enabled — no re-disable |
| User disables b manually | — | — | ordinary blocklist row | b hidden |
| Vendor drops b, then restores it | {a,c,d} ×3 → {a,b,c,d} | {b} after drop-out | b left in blocklist untouched; on return, b re-enters B; its old blocklist row still applies | b stays hidden — user intent preserved |
| User ENABLES d; vendor drops d ×3 (pruned to tombstone); vendor restores d | {a,b,c} ×3 → {a,b,c,d} | {} — d ∈ removed tombstone | none; d re-enters active baseline from tombstone | d comes back ENABLED — no re-disable, at-most-once holds |
| Vendor renames c → c-v2 | {a,b,d,c-v2} | {c-v2} | c-v2 auto-disabled as a new arrival | rename = removal + arrival; user opts into c-v2 explicitly |

The last row is deliberate: a rename is indistinguishable from a new model, and treating it as new is the safe reading (pricing/behavior may have changed with the rename).

### Native models exception

Bare native OpenAI family models (`isBareOpenAiFamilyModel`, defined at src/router.ts:496, applied in resolution at src/router.ts:672) are exempt: they come from the pinned Codex runtime contract, not live vendor discovery, and hiding a new `gpt-5.x` row would break the primary Codex account flow. Policy applies to routed providers only. Custom models (`config.customModels`) are user-created and always on.

### Setting surface

- API: `GET/PUT /api/model-discovery` — `{"policy":"off","providers":{"openrouter":"inherit"},"recentArrivals":{...}}`; PUT accepts `{"policy":"on"|"off","provider":"openrouter"|null}`. A dedicated `POST /api/model-discovery/acknowledge` body `{"provider":"openrouter","ids":["x-ai/grok-5"]}` clears "new" badges without changing visibility.

  Full GET response shape:

  ```json
  {
    "policy": "off",
    "providers": { "openrouter": "inherit", "claude": "on" },
    "recentArrivals": {
      "openrouter": [
        { "id": "x-ai/grok-5", "at": "2026-08-24T02:11:00Z", "state": "auto-disabled" }
      ]
    },
    "baselineCounts": { "openrouter": 412, "claude": 14 }
  }
  ```

  `state` is derived at read time (`auto-disabled` | `enabled` | `acknowledged`) so the GUI needs no extra bookkeeping. PUT responses echo `{"ok":true,"policy":...,"provider":...}` and, when flipping global policy to "off" for the first time, include `"baselineBootstrapped": true` so the CLI can print what happened.
- CLI: `ocx models new-policy [on|off] [--provider <name>]` (show current when no argument) and `ocx models new-arrivals [--json]` listing recent arrivals with their on/off state. Lives beside the existing runtime subcommands (src/cli/models-runtime.ts USAGE block).
- GUI (gui/src/pages/Models.tsx): global toggle "New models start disabled" in the Models toolbar; per-provider override in the provider header menu. Each recent arrival's row shows a "NEW" badge (from `recentArrivals`) until acknowledged or enabled; the provider header shows a count chip ("3 new, off"). Enabling from the row uses the existing putModelVisibility path (gui/src/model-visibility.ts:58) unchanged.

## Resolution & edge cases

- Baseline bootstrap: first successful fetch after upgrade writes the baseline and disables nothing. No thundering "everything is new" event.
- Provider added by the user: the add flow seeds an empty baseline entry; the FIRST fetch after an explicit provider add is treated as bootstrap (nothing new) — the user just chose this provider and expects to see its models. Doc 030's preset then narrows the initial set; from the second fetch on, arrivals follow the policy.
- Fetch failures / partial catalogs: baseline updates only on `{status:"ok"}` discovery (ProviderModelDiscoveryStatus, src/codex/model-cache.ts). A provider returning a truncated list on error paths cannot poison the baseline.
- disabledModels growth: bounded by real vendor additions; entries are plain routed slugs indistinguishable from user-authored ones (deliberate — one store, one semantics). `recentArrivals` carries the "why" for the GUI instead of tagging blocklist entries.
- Combos/policies referencing a new-and-disabled model: unaffected — `disabledModels` hides models from DISCOVERY (catalog + /v1/models) but does not block direct proxy calls (src/types/config.ts:385-390 comment). Routing keeps working; only the picker hides it.
- Interaction with aliases (doc 010): aliases are a resolution layer over canonical slugs; a disabled new arrival simply has no catalog row, alias or not. Built-in default aliases may match a new arrival — fine, resolution still works for direct calls.
- Interaction with preset (doc 030): a provider in preset mode has a non-empty `selectedModels`, so this policy is a no-op there by construction (case 2 above). The two features compose without coordination: preset governs the initial curated set, new-model policy governs drift for all-on providers.

## Migration & compatibility

- Existing installs: absent `modelDiscovery` = policy `"on"`, zero behavior change until the user opts in. On first opt-in, the current catalog becomes the baseline (bootstrap), so opting in never hides anything retroactively.
- Fresh installs: `ocx` init writes `"newModelPolicy": "off"` — new users get the safe default; the GUI onboarding mentions it once.
- Downgrade: older binaries ignore `modelDiscovery` and simply stop enforcing the policy; blocklist entries appended earlier keep working (they are ordinary `disabledModels` rows). No lossy state.

## Out of scope

- Notification channels beyond the GUI badge (no email/webhook on new arrivals).
- Auto-enabling arrivals matching a pattern ("always enable new -flash models") — expressible later as preset-pattern reuse.
- Per-model metadata diffing (context window changes on an EXISTING id are not "new").

## Open questions

1. Should auto-appended blocklist rows be tagged (e.g. `disabledModelsMeta`) so the GUI can distinguish "auto-disabled on arrival" from "user disabled"? Proposed: no separate store; `recentArrivals` covers the UX need and one blocklist keeps semantics simple.
2. Baseline location — config.json vs a sidecar state file? Proposed: config.json under `modelDiscovery` for atomicity with the blocklist writes it drives; if size becomes a problem (openrouter ~400 ids ≈ 15KB) move `knownModels` to `~/.opencodex/model-baseline.json` in a follow-up while keeping the policy flag in config.
3. Disappearance grace count N=3 — tune after observing real vendor flapping; the constant is otherwise arbitrary.
