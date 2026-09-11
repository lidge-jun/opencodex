# Phase 5 — three contracts and two GUIs become one

Base: the phase-2 layer. Opens once the kernel lands.

## Thesis

One pool-settings contract and one operator surface, so a new pooled provider
needs configuration rather than another name branch.

## Current behaviour (verified on dd9a2906b)

Three management contracts:

1. Codex only. src/codex/auth-api.ts handleCodexAuthAPI :2477-2515 handles PUT
   and PATCH /api/codex-auth/pool-strategy, writing accountPoolStrategy and
   accountPoolStickyLimit. There is no GET on this path.
2. Anthropic versus generic. src/server/management/oauth-account-routes.ts
   handleOauthAccountRoutes branches on provider !== "anthropic": GET :348-361,
   PUT and PATCH :373-423 with stickyLimit and quotaWindow rejected at :395-396,
   and the anthropic write at :424-483.
3. Registry. src/server/management/route-registry.ts :95 and :110 for the Codex
   path, :263, :270 and :283 for the oauth pool path.

Two GUI surfaces, one shared control:

- shared gui/src/components/AccountPoolStrategyControls.tsx :42 and
  gui/src/account-pool-strategy.ts, whose putCodexPoolStrategy :58-65 posts to the
  Codex-only route
- Codex gui/src/components/CodexPoolStrategySetting.tsx :33 and :174
- Anthropic gui/src/components/provider-workspace/AnthropicAccountPoolSettings.tsx
  :63 GET and :117 PUT, hardcoded to provider=anthropic
- mounted by a name branch in
  gui/src/components/provider-workspace/ProviderAuthPanel.tsx :387-389,
  item.name === "anthropic" only, so the generic kind has an API and no UI

i18n: 36 accountPool.* keys in gui/src/i18n/en.ts :1981-2023, and every catalog in
gui/src/i18n/catalogs.ts :24-33 already carries 36. All nine stay in sync.

## Change surface

NEW one pool-settings DTO covering every kind, served from a single route pair
under the oauth-account-routes module, with the Codex path kept as a deprecated
alias that forwards rather than duplicating the write.

MODIFY ProviderAuthPanel to mount the pool panel from the capability returned by
poolSettingsCapability instead of item.name === "anthropic".

MODIFY AnthropicAccountPoolSettings into a kind-driven component; keep
AccountPoolStrategyControls as the shared control it already is.

MODIFY the i18n catalogs together. Any new key lands in all nine files in the same
commit, per the docs-sync rule in AGENTS.md.

## Boundary with phase 4

This layer owns oauth-account-routes.ts, the route registry entries and the GUI
pool surfaces. Phase 4 keeps key-strategy fields out of those files. If the key
pool needs an operator surface, it arrives here after both have landed, not in
parallel.

## Tests

tests/server/account-pool-management-api.test.ts for the unified DTO and the
deprecated alias; tests/cli/cli-account-pool-verbs.test.ts for CLI parity; a GUI
test that the panel mounts for a generic OAuth provider. A gui-labelled PR needs a
screenshot in its description per AGENTS.md.
