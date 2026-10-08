# anthropic2: a second, independent Anthropic account pool

Status: open. Opened 2026-10-08 against `dev` at `bf9ecf3d79` (v2.81.0).

## Outcome

Add a builtin OAuth provider instance `anthropic2` ("Anthropic · Pool 2") next to the
existing `anthropic`. Both run the single Anthropic implementation (adapter `anthropic`,
the same login/refresh engine, native Messages and the Responses bridge, the same model
metadata). Only the account drawer is separate: credentials, pool configuration, pool runtime
state, quota/usage/reset attribution and helper credential resolution belong to the instance
the request selected. A user picks `anthropic/<model>` or `anthropic2/<model>` in the existing
picker.

Terms used in every document of this unit:

- **family** — shared Anthropic behaviour (login, wire format, model capability, error classes).
- **instance** — `anthropic` (A) or `anthropic2` (B), the provider a user selects.
- **account** — one stored credential inside an instance; **pool** — the accounts and policy of one instance.

## Decisions

| ID | Decision |
|---|---|
| D-01 | Exactly two fixed IDs. `anthropic3` or prefix matching is never accepted. B is a dormant registry preset until the user adds it. |
| D-02 | One engine, separated identifiers. Instance membership is declared by registry metadata (`oauthFamily: "anthropic"` on OAuth rows) and checked by `isAnthropicOAuthInstance(id)`; never by `adapter === "anthropic"` or `startsWith`. `anthropic-apikey` and Anthropic-compatible gateways are not instances. |
| D-03 | One protected auth file, separate keys (`anthropic`, `anthropic2`). Existing lock/atomic-write/generation/refresh-intent contracts are reused. |
| D-04 | A keeps `config.anthropicAccountPool`; B uses `config.providers.anthropic2.anthropicAccountPool`. Same schema, same product defaults, no inheritance from A. `providers.anthropic.anthropicAccountPool` and the field on any other provider are rejected by validated writes and reported by diagnostics. |
| D-05 | Pool state (selection, revision, round-robin cursor, affinity, quorum, manual preference) is per instance; account state (cooldown, admission pause, family quota, usage history) is per (instance, account). Route `fallback: true` widens only within the same instance. |
| D-06 | B starts empty and supports browser OAuth only (OPEN-01, owner-confirmed 2026-10-08). No Claude Code CLI import, adoption or write-back for B; A keeps its import/continuity behaviour. Proven duplicate access/refresh token or verified account UUID across instances is rejected inside the store write lock. |
| D-07 | A direct `anthropic2/<model>` request never recovers onto A. Explicit combos/helpers naming A remain a user-declared cross-provider choice. Helper `backend: "anthropic"` names the family; the new optional `anthropicInstance` names an instance; unset means "inherit the request's instance". |
| D-08 | Pool separation is an opencodex routing boundary only. It does not claim provider-side account separation, terms compliance or OS-level isolation. |
| D-09 | Explicit builtin ownership: newly created B config carries `anthropicOAuthInstance: "anthropic2"`. Every pre-existing unmarked `anthropic2` row remains custom, including one at the canonical endpoint. Login refuses the collision without rewriting config/auth. Marker plus Anthropic OAuth shape identifies B; endpoint equality does not. Both instances retain the existing baseUrl override behavior. The marker records operator configuration intent, not an OS or cryptographic boundary. |
| D-10 | GUI: B uses the Claude mark recoloured green (`claude-green.svg`, design-system green) so the two pools are distinguishable at a glance. |

## Code contract (shared by every slice)

- `src/providers/anthropic-instance-id.ts` (leaf, no imports): `AnthropicInstanceId = "anthropic" | "anthropic2"`,
  `ANTHROPIC_INSTANCE_IDS`, `isAnthropicInstanceId(id)` (pure string check). The registry imports only this leaf.
- `src/providers/anthropic-instance.ts`: `isAnthropicOAuthInstance(id)` (exact ID + registry entry with
  `oauthFamily`), `isBuiltinAnthropicInstanceRow(name, providerConfig)` (D-09 shape check) and
  `configuredAnthropicInstance(config, name)` (for `anthropic` it returns the instance as a compatibility
  identity and callers keep their existing checks; for `anthropic2` only when the row exists, is enabled and
  passes the shape check). Runtime selection and physical send use `configuredAnthropicInstance`, so an
  orphan `anthropic2` auth row without an enabled builtin-shaped config row never activates B.
- `src/oauth/anthropic-pool-config.ts`: `resolveAnthropicAccountPoolConfig(config, instance)`
  reads the instance's own location only; the existing `anthropicAccountPoolConfig(config)` stays
  as the A wrapper.
- Instance-scoped state uses a factory per module: `anthropicRoutingFor(instance)`,
  `anthropicModelQuotaFor(instance)`, `anthropicRatePolicyFor(instance)`, cooldown-generation and
  reset-ledger owners likewise. State is created lazily on first write, never on read. Existing named
  exports remain and mean A, so existing callers and tests keep their meaning. Required-instance variants
  get distinct names (`...ForInstance(instance, ...)`, e.g. `resolveAnthropicModelRouteForInstance`,
  `setAnthropicAccountThresholdForInstance`, `effectiveAnthropicAccountThresholdForInstance`,
  `resolveNativeOAuthBindingForInstance`); the old names stay as A wrappers. Any B-reachable call site
  passes the instance explicitly; an omitted instance never silently means A on a B request.
- Facade objects may be allocated lazily on lookup; mutable state (health, affinity, pauses, family
  evidence) is created only by a write. Removing a B account or the B row bumps the same generation fences A
  uses, and sweeps reconcile every existing bucket against its own roster.
- The request path derives the instance once from the settled route (`route.providerName` narrowed by
  `isAnthropicOAuthInstance`) and carries it through binding, commit, dispatch, refusal recovery,
  quota recording and log labels.
- Bare `claude-*` inference keeps its A-only provider list; qualified `anthropic2/...` routes never
  take the Claude Code caller-forward path.

## Work-phases

| WP | Doc | Scope |
|---|---|---|
| wp1 | this unit | roadmap only |
| wp2 | [010](010_identity_config_store.md) | registry preset, identity helper, config types/schema/diagnostics, auth store, OAuth login/refresh, duplicate guard, collision guard |
| wp3 | [020](020_pool_runtime_dataplane.md) | routing/quota/rate/kernel state per instance; native Messages; Responses transport, continuation, sidecar execution, combos; protocol settings |
| wp4 | [030](030_helpers_surfaces_gui.md) | sidecar auth, vision, web search, images, quota probes, reset grants, usage labels, management API, CLI, catalog, GUI (green mark), docs, structure |
| wp5 | [040](040_delivery.md) | one PR to `dev`, hosted CI repair loop, independent review, merge |

[050](050_acceptance_map.md) maps every acceptance scenario and release blocker to a phase and test file.
Implementation workers are `gpt-6.1-sol` subagents (owner request); main integrates, commits and owns git.
During wp4 the ChatGPT account began refusing every Sol model name for subagents
(`gpt-6.1-sol`, `gpt-6-sol`, `gpt-5.6-sol`: "not supported when using Codex with a ChatGPT
account"), so wp4's workers ran on the session default model; Sol was retried for each new lane.

All implementation lands on one branch, `codex/anthropic2-account-pool`, and ships as one PR so B is
never exposed half-built. Work inside a phase is split across workers with disjoint file ownership.
The main session alone owns shared fixtures, `scripts/test-layout/layout.json`,
`tests/fixtures/test-layout-expected.json`, `structure/` and `docs-site/`; workers return the entries they
need and main applies them. Files near their cap at the start: `src/oauth/index.ts` 1996/1999,
`src/server/management/provider-routes.ts` 1994/1999, `src/providers/registry.ts` 232/232 (baseline),
`src/providers/quota.ts` 557/558 (baseline), `scripts/test-layout/layout.json` 1955/1999. Growth in these
goes to sibling modules; layout registrations stay compact.

## Verification policy for this unit

The owner forbade every local test, typecheck, lint and build for this unit. Execution evidence is
exact-head hosted CI on the PR. Local checks are limited to static inspection (`git diff --check`,
reading diffs). Each phase adds focused regression tests next to the subsystem it changes; they run
in CI. New test files are registered in `scripts/test-layout/layout.json` and
`tests/fixtures/test-layout-expected.json`. Files at their size cap get sibling modules, never a raised cap.
