# Fallback Policy

OCX-11. One resolver decides whether a request may be served from a different **model** or a
different **provider** than the one chosen or requested, and every site that would make such a hop
asks it first. Absent configuration allows every hop, which is the behavior before this policy existed.

## What is and is not a fallback

A hop's kind is decided by what changes between the target that failed (or is known unavailable) and
the next one: provider differs → `provider`; same provider, different model → `model`; same target
→ not a hop. `fallbackHopKind` in `src/routing/fallback-policy.ts` is the only classifier.

Rotation among the accounts or API keys of one provider pool for the same model is intra-pool
resilience and is not governed here: Codex pool account switches (`src/codex/routing/selection.ts`),
Anthropic OAuth rotation (`src/oauth/anthropic-routing.ts`), generic OAuth rotation
(`src/oauth/generic-account-failover.ts`) and API-key pool rotation (`src/providers/key-failover.ts`).
The rule recorded in `src/types/config.ts` that reactive 429 rotation cannot be switched off stands.
Same-target retries (`src/lib/upstream-retry.ts`), the Antigravity direct lane's per-request bridge
fallback and transport fallbacks keep their target and are not hops. Claude Code
`classifierFallbacks` (`src/claude/inbound-model-options.ts`) is a static mapping with no
availability check, so it never hops.

## Configuration and precedence

`fallback` in config.json (`src/types/fallback.ts`, read schema `src/config/schema/fallback-policy.ts`):
global `model`/`provider` booleans, `providers.<name>`, `routes.<selector>` and `devices.<id>` maps of
the same switches, and `devices.<id>.localFallback`. A malformed leaf reads as absent; diagnostics and
the load warning name the section. A whole-config write does not degrade: `validateConfigCandidate`
(`src/config/diagnostics.ts`) rejects a malformed `fallback` section through `fallbackPolicyError`, so a
save cannot silently drop a refusal. Map keys are validated by the resolver, so one bad key never drops its
siblings.

`resolveFallbackPolicy`: a device entry set to `false` for the kind refuses; a device `true` never
reopens a hop. Otherwise the first route selector with a boolean decides, then the provider the hop
starts from, then the global switch, then the default (allowed). Route selectors are the public
selector the client asked for plus the site's aliases (`combo/<id>` and the requested model,
`policy/<id>` and the requested model).

Device identity comes from admission only: a `configured` admission's key id, plus the Remote Link
id whose `apiKeyId` matches it in the link store. The store is read only when `devices` is non-empty
and is cached for five seconds. Loopback and unkeyed requests have no device scope.

## Sites

| Site | Hop point | Reactive status | Proactive |
|---|---|---|---|
| Combos, `src/server/responses/core-combo.ts` | top of the dispatch loop, when a later dispatch follows a failure on a different target; and before the first send of a `failover` combo that starts on a later target than its first, for any reason | the failure's status and `Retry-After` | `cooldown` or `quota_exhausted`, 429; otherwise `unavailable`, 503 (`comboTargetSkipTrigger`, `src/combos/resolve.ts`) |
| Routing profiles, `src/server/responses/policy-fallback.ts` | before the next ranked candidate runs | the failure's status and `Retry-After` | — |
| Subagent model fallback, `src/codex/subagent-model-fallback.ts` | `applySubagentModelFallback`, before the spawn's model is rewritten; the caller in `src/server/responses/request-prepare.ts` returns the refusal | — | `unavailable`, 503 |
| Main-account hard-lock fallback, `src/server/responses/main-hard-lock-routing.ts` | before the body is rewritten; `FallbackRefusedError` carries the refusal to `request-prepare.ts` | — | `hard_lock`, 429 |

A refused hop never contacts its refused destination. Hard-lock pre-admission refuses before
rewriting the body; its first combo dispatch or profile selection can refuse after that rewrite.

The combo and routing-profile sites classify a hop by resolved destinations: both ends pass through
`routeConcreteModel`, so provider aliases and `blockedModelRedirects` are applied, and the end a hop
leaves is the failed child's resolved provider and model. Two selectors under one provider that redirect
to different providers make a provider hop; a routing profile's `current` advances to the redirected
candidate.

The hard-lock site keeps concrete/account-qualified targets' proactive admission at body rewrite.
For combos and profiles it only checks policy feasibility over declared destinations, resolved through
`routeConcreteModel` with the actual first guard's route, alias, source-provider and device precedence.
It refuses before rewriting only when every declared candidate resolves and is policy-denied. One
denied candidate is the refusal witness; it is not a selected destination. Empty, mixed or unresolved
declarations defer to actual dispatch. No candidate is filtered, no random sample is consumed, and no
picker state or profile-history index is opened. Cooldown, weighted/RR/sticky order and evidence-based
profile ranking remain the selector's responsibility. This preflight creates no taken event or send
reservation: an all-denied declaration records one refusal, otherwise it records nothing.

A hard-lock rewrite checks the actual first combo destination in `core-combo.ts` against the locked
OpenAI source, with `trigger: hard_lock`. Feasibility is no grant: a forbidden selected destination
still refuses even when another declaration is allowed or unknown. Actual unknown resolution remains
fail-closed. The combo records an allowed first hop only after its send-budget reservation.

For a hard-lock profile rewrite, `src/server/responses/request-prepare.ts` checks the actual first
ranked destination against the original OpenAI model with `trigger: hard_lock`. An allowed declared
provider hop does not admit a selected model hop when model fallback is off. The guard records an allowed
selection when it is accepted; later authentication or preparation can still refuse it.
`tests/codex-integration/main-account-hard-lock-profile-dispatch.test.ts` covers refusal and allowed
dispatch with a synthetic caller-owned credential and a fetch stub.

## Refusal contract

`fallbackRefusedResponse`: `error.type` and `error.code` `fallback_refused`, `error.fallback` with
`kind`, `scope`, `scopeKey`, `from`, `to` and `trigger`, a message naming the `ocx fallback on` command
that allows the hop, and the header `x-opencodex-fallback: refused`. `from`/`to` are `provider/model`
selectors.

## Hub down

A Remote Link Child and a Hub client run the relay-only client runtime (`src/client/runtime.ts`), which
has no provider dispatch; `tests/clients/client-home-unreachable.test.ts` proves there is no load-time
path from it to Responses dispatch, the router or adapter resolution. When the Home cannot be reached,
the Child's data relay (`src/client/link-relay.ts`) answers a retryable 503 and the Hub client's
management relay (`src/client/hub-relay.ts`) a 502; both bodies keep their legacy `error` string and add
`code: "home_unreachable"` and the message from `src/client/home-unreachable.ts`. That code means the
connection is unavailable and nothing else: a failed connection-bound relay authentication answers
`code: "link_relay_auth_failed"`, so an upgrade or re-link problem never reads as Home down to GOAT.
A tunnel that drops after forwarding started also answers `home_unreachable`, and the Home may have
received that request.
`devices.<id>.localFallback` is a permission GOAT reads (goat-si/goat ADR-0021 §1.6, "local fallback
opt-in per device"); OpenCodex never acts on it and keeps answering `home_unreachable`.

## State and surfaces

Every guarded hop, taken or refused, is recorded in a 20-entry in-memory ring (`recentFallbackEvents`).
A refusal is recorded when it is decided; an allowed hop only when its site calls `commit()` at its
admission boundary (body rewrite, combo send-budget reservation, or accepted profile selection).
`taken` records that guard admission, not an upstream contact or a billed send; later preparation,
authentication or dispatch may still refuse. Each event carries
time, site, route, kind, from, to, trigger, outcome, deciding scope and the device id. No body, key,
account id, label or email. `src/routing/fallback-state.ts` builds the `ocx.fallback/1` view and applies
the one scoped write.

- `GET|PUT /api/fallback` (`src/server/management/fallback-routes.ts`, loaded on demand). The view lists
  every link from the store and every configured device. A passive read (a Remote Link Child through
  `LINK_MANAGEMENT_READ_PATHS`) omits link aliases and event device ids. PUT validates a device key
  against the link store (an alias maps to its link id) and `apiKeys`, persists through
  `mutatePersistedConfig` and mirrors the result into the live config.
- `GET /readyz` advertises `fallback-policy/1` (`src/remote/features.ts`); GOAT reads its absence as unknown.
- `ocx fallback` (`src/cli/fallback.ts`) and `ocx status --json` `fallback` (`src/cli/status-fallback.ts`:
  the live view, the Home's over the link on a Child, or the local policy marked `source: "local"`).
- Dashboard: `gui/src/components/FallbackPanel.tsx` on the Dashboard overview (switches, overrides, last hop) and on
  Remote Link (per-device local fallback and chains, read-only on a Child).

Coverage: `tests/routing/fallback-policy.test.ts` (precedence matrix, degrade, device identity, contract,
privacy), `tests/responses/responses-combo-fallback-off.test.ts`, `tests/routing/routing-policy-fallback-off.test.ts`,
`tests/routing/subagent-model-fallback-off.test.ts`, `tests/codex-integration/main-account-hard-lock-fallback-off.test.ts`,
`tests/server/fallback-routes.test.ts`, `tests/clients/client-home-unreachable.test.ts`, `tests/cli/cli-fallback.test.ts`
and `gui/tests/fallback-panel.test.tsx`.

The opt-in [all-cooled Combo recovery](runtime.md#scoped-provider-quota-for-combo-selection) can reserve saved combo cooldowns in `src/combos/resolve.ts`; only that request bypasses its reserved writes until a successful dispatch conditionally clears its unchanged target, with throwing predicates treated as ineligible during recovery preparation and available siblings preferred without probing cooled targets. Route-level picks and in-flight retry-after-cooldown selections disable reprobes. Recovery does not authorize a fallback hop or bypass the configured fallback policy.
