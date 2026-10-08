# 030 — Helpers, management, CLI, catalog, GUI, docs (wp4)

## Helpers

- `src/sidecar/auth.ts`: `resolveAnthropicSidecarAuth(config, instance)` — exact lookup, no fallback.
  Legacy discovery keeps its order but never adds B automatically.
- Helper resolution order: the backend family is chosen first by the existing rules (web search still
  defaults to OpenAI; vision keeps its automatic order). Only when that yields Anthropic: explicit
  `anthropicInstance` > the parent request's instance > legacy discovery, which never adds B automatically
  (no parent, or a non-Anthropic parent). `anthropicInstance` combined with a non-Anthropic backend, or
  with a provider-qualified routed helper model naming the other instance, is a validation error. A helper
  whose explicit instance differs from the main request is reported as mixed in the settings options DTO.
  Applied in `src/vision/plan.ts`, `backends.ts`, `eligibility.ts`, `src/web-search/index.ts`,
  `sidecar-providers.ts`, `backends.ts`, `passthrough-bridge.ts`, `alpha-search.ts`.
- Physical helper executors `src/vision/anthropic-describe.ts` and `src/web-search/anthropic-executor.ts`
  obtain their token through the selected instance's routing facade (model-route admission and snapshot
  included); `getAnthropicSidecarAccessToken` takes the instance and has no first-match fallback.
- Generated image-description cache keys (`src/vision/index.ts`) include instance, model and the effective
  helper policy; deterministic resize caches stay shared.
- `src/web-search/loop.ts`, `src/images/loop.ts`: account-403 recovery recognised for both instances,
  within the sending instance.

## Quota, reset, usage

- `src/providers/quota.ts` (557/558: extract helpers to a sibling), `quota/account-cache.ts`,
  `quota/vendor-probes-oauth.ts`: B is a supported per-account quota provider; probes, header recording
  and publication use the instance. Retention and family-window handling in `account-cache.ts` recognise
  both instance key prefixes.
- `src/providers/anthropic-reset-grant-ledger.ts`: B uses its own journal file; A's file and records are
  untouched. `src/server/management/anthropic-reset-grant-routes.ts` accepts an optional `provider`
  (omitted means A) and echoes it.
- `src/providers/label.ts`, `src/usage/*`: B keeps its own label and grouping; pricing comes from the
  family metadata alias.

## Management API and CLI

- `src/server/management/oauth-account-routes.ts`, `anthropic-account-threshold.ts`: pool settings,
  per-account threshold, pause and cleanup accept either instance and write that instance's location.
- `src/server/management/config-routes.ts`, `agent-settings-routes.ts`: persist and validate
  `anthropicInstance`.
- `src/cli/account*.ts`, `capabilities-accounts.ts`: `ocx account pool|auto-switch|use anthropic2 ...`
  behave as for A; regenerate the skill surface map if a capability string changes.
- `src/codex/catalog/provider-models.ts`: B discovery and selection capture like A.

## GUI

- `gui/public/provider-icons/claude-green.svg` (new): Claude mark path, fill `#0a7d5c`, dark-scheme fill
  `#4ecb9d`. `gui/src/provider-icons.ts` maps `anthropic2` to it; the desktop alias table
  (`desktop/src-tauri/src/provider_icons.rs`) mirrors it.
- `ProviderAuthPanel.tsx`, `AnthropicAccountPoolSettings.tsx`, `AnthropicResetGrants.tsx`,
  `useAnthropicResetGrants.ts`, `gui/src/pool-settings.ts`, `oauth-tos-risk.ts`,
  `providers-shared.ts`: instance-predicate instead of `=== "anthropic"`; provider passed explicitly;
  React keys/query keys include the provider.
- i18n: new keys in all locale catalogs.
- Helper instance controls (PRD D-07): the global web-search and vision sidecar settings and the Claude-origin
  sidecar overrides get a "Pool" select with "Current request's pool" (unset), "Anthropic" and
  "Anthropic · Pool 2", shown only when the backend is Anthropic. `gui/src/pages/claude-manual-env.ts` and
  `gui/src/pages/claude-code-sidecar.ts` types/serialisers carry `anthropicInstance`; unset is never saved
  as `anthropic`; a mixed explicit choice shows a short note. Server DTOs in `config-routes.ts` and
  `agent-settings-routes.ts` round-trip it.

## Docs and structure

- `docs-site/.../reference/configuration/providers.md` (+ existing translations): B location, defaults,
  isolation, browser-only onboarding, helper `anthropicInstance`.
- `structure/providers/anthropic-account-pool.md` (+ manifest ownership for new files).

## Tests

- `tests/vision/anthropic-instance-sidecar.test.ts`, `tests/server/anthropic2-management.test.ts`,
  `gui/tests/anthropic2-provider-mark.test.ts` and focused additions next to existing suites.
