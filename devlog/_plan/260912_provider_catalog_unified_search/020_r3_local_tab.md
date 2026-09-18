# 020 — R3: a dedicated Local tab (work-phase wp2)

First implementation cycle, because every later phase depends on the tier set. R1's
chip counts and group order need Local to exist; R2 touches the same row renderer.

## Change

`gui/src/components/provider-catalog/provider-presets.ts`

- `export type CatalogTier = "accounts" | "free" | "local" | "paid"` — declared here,
  deliberately **not** an alias of `ProviderTier`. `ProviderCatalog.tsx` re-exports it
  for existing importers.
- `isLocalCatalogPreset(preset)` delegates to `isLocalProvider(presetTierInput(preset))`
  from `gui/src/provider-workspace/kind.ts`, so loopback base URLs and
  `authMode === "local"` are classified by the one helper the rail already uses.
- `bucketPresets` returns four buckets. Local is peeled off **after** `presetTier`
  runs, so `presetTier` keeps returning `"free"` for Ollama and the existing unit test
  that asserts it stays green. Accounts still wins over local: a canonical forward
  provider is an account row regardless of its URL.

`ProviderCatalog.tsx`: the tab array becomes `["accounts", "free", "local", "paid"]`.

i18n: `modal.tab.local` in every locale file that carries `modal.tab.paid`.

## Not changed

`providerTier`, `isFreeProvider`, `sortWorkspaceItems`, `ProviderSortMode`,
`buildProviderWorkspace`, the workspace free count, and the amber Local badge. A local
preset keeps whatever badges it has today; the tab is an additional axis, not a
relabelling.

## Risks

- `AddProviderModal.initialTier` is typed `"accounts" | "free" | "paid"` and is passed
  from `providers-page-modals.tsx`. Widening it to `CatalogTier` must not make any
  caller start passing `"local"` implicitly.
- An empty Local tab on a machine with no local runtime configured is fine — the
  catalog is a preset list, and Ollama/vLLM presets are always present.

## What actually moves (verified against `src/providers/registry.ts`)

Four catalog rows change tab, all Free → Local: `ollama`, `vllm` and `lm-studio`
(`authKind: "local"` plus a loopback base URL) and `litellm` (`authKind: "key"` with
`keyOptional` and `localhost:4000`). LiteLLM is the non-obvious one — people browse it
under Free today as a self-hosted key-optional gateway — and moving it is intended: it
runs on the user's machine, which is what the tab is for. `presetTier` still returns
`"free"` for all four, so the workspace Free count and the rail are unchanged.
`openai` stays Accounts, `ollama-cloud` stays Paid (it is not loopback), and `devin-cli`
is local but is not a catalog preset at all.

## Verification (remote CI only)

`tests/gui/provider-catalog-tiers.test.ts` (new, pure): local presets bucket to
`local` and are absent from `free`; `presetTier` still returns `"free"` for them; a
loopback-base-URL preset with `authMode: "key"` still lands in `local`; the canonical
forward provider still buckets to `accounts`. New test files need an entry in
`scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`.
