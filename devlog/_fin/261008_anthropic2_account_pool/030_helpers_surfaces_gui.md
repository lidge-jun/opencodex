# 030 — Helpers, management, CLI, catalog, GUI, docs (wp4)

## Execution contract

Prior D: wp3 has instance-bound routing/quota/native/Responses and send-time
incarnation ownership. Hosted focused and baseline contracts passed at
`6ba14b70f1`; full-suite source-inventory follow-ups are retained in the same PR.
This phase consumes those APIs and completes their helper/product consumers.
No change of objective or acceptance reduction. All execution evidence comes from
hosted CI; no local tests, typecheck, lint, build or live-account calls.

### Cross-worker APIs

The helper owner defines these in `src/sidecar/auth.ts`:

- `resolveAnthropicSidecarAuth(config, instance)` returns the selected provider
  name/config or undefined, never another pool.
- `resolveSidecarAuth(config, instance?)` retains legacy discovery when no target
  is supplied. Legacy discovery excludes B as a new automatic candidate.
- `AnthropicHelperContext = { backendFamily: string; anthropicInstance?: AnthropicInstanceId; parentProviderName?: string }`.
- `resolveAnthropicHelperInstance(config, context)` selects explicit target,
  then configured builtin parent, then legacy discovery only AFTER backend-family
  selection. An invalid/unavailable explicit or inherited target is a typed
  refusal, never undefined that would trigger legacy fallback.

The typed refusal is `AnthropicHelperUnavailableError`, exported by
`src/sidecar/auth.ts` with fixed code `anthropic_helper_unavailable` and selected
instance. Executors preserve refusal; options DTOs may expose unavailable state
but never turn it into permission to discover another pool.

The helper owner adds `src/sidecar/anthropic-binding.ts`:
`resolveAnthropicHelperSnapshot(config, instance, model): Promise<OAuthAccessSnapshot>`.
It reuses model-route admission and the selected routing facade. Actual builtin
helper sends capture physical ownership before fetch and retain target/config,
account/generation and send-incarnation checks after awaits. Existing custom
helper providers retain their own credential path.

The quota owner adds `fetchAnthropicUsageQuotaForInstance(instance, token, fresh?)`;
the old function remains A. `fetchAnthropicQuota(provider)` retains the actual
instance. After refresh, use credential-scoped flight keys and
`captureProviderAccountQuotaEpoch(instance)`; B cache clear cannot invalidate A.

Reset uses existing ledger options with
`anthropicResetJournalPathForInstance(instance, customDir?)` and
`anthropicResetLedgerOptionsForInstance(instance, customDir?)`.
A journal stays byte-compatible; B uses `anthropic2-reset-grant-ledger.json`.
GET reset-grants takes provider query; consume takes provider in its JSON body.
Both echo provider. Omission means A only at legacy ingress. New B callers always
send provider. Account/grant/operation IDs and unknown-outcome retry ownership remain
bound to the instance; no automatic spend and no relaxation of session consent.

The account-management owner extracts `src/server/management/anthropic-pool-settings.ts`
when useful. `writeAnthropicPoolSettings(config, instance, value)` writes exactly
one supported location; `persistAnthropicPoolPatch` accepts required instance and
uses that location for durable mutation, uncertain-save comparison and publication.
DTO kind stays `anthropic`, provider remains A/B. Existing A wrappers keep A meaning.

Helper settings PATCH: missing instance preserves, null deletes, A/B sets explicit.
Validate the effective merged backend/model/instance before writing; omit unset
values on GET/save rather than materializing A. Optional options DTO:
`anthropicPool: { selected?, resolved?, mixed: boolean, available: AnthropicInstanceId[] }`.
Mixed is computed only with a known parent instance. Backend changes away from
Anthropic clear the UI draft and submit deletion. Non-Anthropic defaults stay intact.

### Disjoint write ownership

W1 helpers: `src/sidecar/auth.ts`, new binding helper and `candidates.ts`;
`src/vision/plan.ts`, `backends.ts`, `eligibility.ts`, `index.ts`,
`anthropic-describe.ts`; `src/web-search/index.ts`, `sidecar-providers.ts`,
`backends.ts`, `passthrough-bridge.ts`, `alpha-search.ts`,
`anthropic-executor.ts`, `run-turn-loop.ts`, `loop.ts`; `src/images/loop.ts`.
Tests: `tests/vision/vision-anthropic-instance-sidecar.test.ts`,
`tests/web-search/web-search-anthropic-instance.test.ts`.

W2 quota/reset: `src/providers/quota.ts` (cap 558; extract a cohesive sibling);
new `src/providers/quota/anthropic-account-quota.ts`; `quota/account-cache.ts`,
`vendor-probes-oauth.ts`, `anthropic-cooldown-recovery.ts`;
`src/providers/anthropic-reset-grant-ledger.ts`;
`src/server/management/anthropic-reset-grant-routes.ts`.
Tests: new `tests/providers/provider-anthropic-instance-quota.test.ts`,
existing reset route/cooldown tests.

W3 account surfaces: `src/server/management/oauth-account-routes.ts`,
`anthropic-account-threshold.ts`, new pool-settings helper;
`src/oauth/pool-settings-capability.ts`; `src/cli/account.ts`,
`account-extended.ts`, `account-api.ts`, `account-policy.ts`,
`account-policy-dto.ts`, `account-anthropic-threshold.ts`,
`capabilities-accounts.ts`; `src/codex/catalog/provider-models.ts`;
`src/providers/label.ts`; `src/usage/cost.ts`, `expected-prices.ts`,
`summary.ts`, `timeline.ts`.
Reset CLI retains old syntax with optional `--provider anthropic|anthropic2`.
Tests: server/anthropic2-management, cli/cli-anthropic2-account,
codex-integration/anthropic2-catalog, usage/anthropic2-usage-attribution.

W4 account GUI/icons: `gui/src/components/provider-workspace/ProviderAuthPanel.tsx`,
`AnthropicAccountPoolSettings.tsx`, `AnthropicResetGrants.tsx`;
`gui/src/hooks/useAnthropicResetGrants.ts`, `useProviderAccountPools.ts`;
`gui/src/pool-settings.ts`, `oauth-tos-risk.ts`, `provider-icons.ts`,
`provider-payload.ts`, `models-groups.ts`, `protocol-deep-links.ts`;
`gui/src/pages/providers-shared.ts`, `Providers.tsx` for provider-scoped mutation
state consumers; green SVG and desktop Rust alias table.
W4 alone owns ALL locale catalogs, including W5 keys:
`sidecar.pool`, `sidecar.poolCurrent`, `sidecar.poolA`, `sidecar.poolB`,
`sidecar.poolMixed`. Every existing locale receives the keys.
Tests: GUI anthropic2 provider mark/surfaces and reset-grants suites.

W5 helper settings/UI: `src/server/management/config-routes.ts`,
`agent-settings-routes.ts`, `web-search-sidecar-options.ts`,
`vision-sidecar-options.ts`; `src/types/config.ts`;
`src/config/schema/anthropic-account-pool.ts`;
`gui/src/pages/dashboard-shared.ts`, `use-dashboard-data.ts`,
`dashboard-overview-sections.tsx`, `claude-manual-env.ts`,
`claude-code-types.ts`, `claude-code-save.ts`, `claude-code-sidecar.ts`,
`claude-code-sections.tsx`.
Tests: existing Claude sidecar override/serializer tests; new
`tests/server/management-sidecar-anthropic-instance.test.ts` and
`gui/tests/anthropic-instance-helper-controls.test.tsx`.
W5 sends translation key requirements to main/W4 and never edits locale files.

Main owns both inventories, structure/manifest/index, docs-site translations,
generated capability surface, screenshot evidence and all Git/CI work. Main also
owns the first-login repair (`src/oauth/index.ts` plus an isolated publication
helper/test if needed) and pinned old-version hosted fixture; no worker edits these.
Additional files require main assignment. Workers use Sol and do not spawn.

### Required final acceptance work

- B first login with initially absent config uses existing
  `initializePersistedConfigIfMissing` and must not overwrite a concurrent winner.
  Distinguish initially missing from deleted/invalid during login; preserve defaults,
  A and any concurrent custom B row. Initial creation happens only during explicit
  onboarding. Add isolated no-config and competing-create cases.
- STATE-11 runs an actual pre-feature pinned checkout at
  `6a7632db2a85c359da9feac976180450ebb42c60` in hosted CI against synthetic auth/config
  data. Observe B orphan-key preservation under old auth read/write and config
  salvage separately; publish a receipt/artifact. No in-place downgrade claim.
- GUI screenshot/interaction evidence comes from hosted rendering at the final
  feature head, not running a local suite. Capture A/B cards, account lists,
  model groups, B settings and empty B refusal; read images before claiming visual
  verification. Screenshots never enter the feature branch.
- Final matrix includes explicit/inherited/no-parent helpers, unavailable B,
  strict routes, post-output no-replay, generated-cache separation, equal-ID
  management/reset operations, stale-response UI isolation, default preservation,
  all locale keys and native icon alias parity. Passing a narrower matrix does
  not close the original acceptance map.

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

- `tests/vision/vision-anthropic-instance-sidecar.test.ts`, `tests/server/anthropic2-management.test.ts`,
  `gui/tests/anthropic2-provider-mark.test.ts` and focused additions next to existing suites.
