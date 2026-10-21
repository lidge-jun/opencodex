# OCX-11 fallback off — design

> Written 2026-10-21 · base origin/dev d82b2173e · status: **design only, waiting on three product choices (§9)**
> Consumer: GOAT hub design, goat-si/goat PR #684 (ADR-0021 §1.6, design doc §1.6 and DH3).

## 1. Goal

Give the operator one clear way to say "do not fall back; fail with a clear error instead", for two families:

- **Hub down.** A Remote Link Child or Hub client whose Home is unreachable never silently serves from
  its own local providers, and the operator can see and set that per device.
- **Fallback chains.** Model, account and provider fallback (combos, subagent fallback, the main-account
  hard-lock fallback, routing profiles, account pools) can be refused per scope: global, per provider, per
  model or route, and per device.

Defaults stay exactly as they are today (§7).

## 2. Terms adopted from GOAT

ADR-0021 §1.6 and its design doc define the hub-down policy. This note reuses these terms verbatim so both
sides read the same way:

- "a Child never silently serves its local providers when the Home is unreachable, and model, account and
  provider fallback chains can be turned off per scope" (design §1.6, describing this package).
- "**local fallback** opt-in per device" (DH3: "pause plus decision item; local fallback opt-in per device").
  GOAT's switch is `hub.devices[alias].localFallback`; this note names the OpenCodex key
  `fallback.devices.<deviceId>.localFallback` so the leaf reads the same on both sides.
- "goal work on that device **pauses** (health condition `HubUnreachable`), people's own threads see
  OpenCodex's 503 as today". OpenCodex keeps that 503 and gives it a stable code (§6).
- "GOAT reads that state; it never changes OpenCodex fallback settings", and the Fleet and Settings → Hub views
  show "OpenCodex's fallback state per device and scope (**on, off, unknown** when the Home predates OCX-11)".
  The read model in §8 reports on or off per scope; GOAT derives unknown from an absent `fallback` field.
- "**GOAT fallback**" (ADR-0018 chains) is GOAT's word for moving GOAT work to another provider instance.
  OpenCodex never uses that phrase; its own hops are "model fallback", "account fallback", "provider
  fallback" and "local fallback".

## 3. Inventory: every fallback today

A fallback here is a hop that serves a request from a **different target** than the one that was chosen
or requested: another model, another account or key, another provider, or (on a Child) another machine.

| # | Fallback | Kind | Where | Trigger | Configured by | Switchable today |
|---|---|---|---|---|---|---|
| F1 | Combo failover | provider or model | `src/server/responses/core-combo.ts` `executeComboResponses`; decisions in `src/combos/failover.ts` `comboFailureDecision`; picker and cooldowns in `src/combos/resolve.ts` | target failure, target in cooldown, quota exhausted | `combos.<id>` | per combo only by editing targets |
| F2 | Subagent model fallback | model or provider | `src/codex/subagent-model-fallback.ts` `selectAvailableSubagentModel`, `noteSubagentModelFailure`; failure feed from `src/server/responses/adapter-dispatch.ts` | primary model quota exhausted or unhealthy (proactive) | `subagentModelFallback`, `subagentModelFallbackByModel` | yes, by emptying the list |
| F3 | Main-account hard-lock fallback | model | `src/server/responses/main-hard-lock-routing.ts` `applyMainHardLockFallbackOverride`; `src/codex/main-account-hard-lock.ts` | the hard lock blocks a Codex-native request | `codexMainAccountHardLockFallback` (opt-in) | yes |
| F4 | Routing-profile fallback | provider or model | `src/server/responses/policy-fallback.ts` `handleResponsesWithPolicyFallback`, `rankPolicyFallbackCandidates` | ranked candidate fails | `routingProfiles.<id>` (explicit `policy/<id>` models only) | per profile by editing candidates |
| F5 | Claude Code classifier fallbacks | model or provider | `src/claude/inbound-model-options.ts` | classifier model unavailable | `claudeCode.classifierFallbacks` | yes, by emptying the list |
| F6 | Codex pool account switch, including the signed-in main as pool fallback | account | `src/codex/routing/selection.ts` (`getEligiblePoolAccounts`, `nativeMainSelectionOnly`), `src/codex/account-auto-switch.ts`, `src/codex/account-preservation.ts` | usage threshold, `upstreamFailoverThreshold` consecutive failures, 429 | `autoSwitchThreshold`, `upstreamFailoverThreshold`, `codexPreserveSignedInAccount`, `codexPool` | partly (threshold 0) |
| F7 | Anthropic OAuth pool rotation | account | `src/oauth/anthropic-routing.ts` `rotateAnthropicAccountOn429`, `rotateAnthropicAccountOnRefusal` | 401, 403, 429 | presence of 2+ accounts | **no, by design** (§9 C3) |
| F8 | Generic OAuth pool rotation | account | `src/oauth/generic-account-failover.ts` `rotateGenericOAuthAccountOn429`, `rotateGenericOAuthAccountOnRefusal`, `rotateAntigravityAccountOnAuthRefusal` | 429, auth refusal | presence of 2+ accounts; `oauthAccountFailover` governs only the proactive part | **no, by design** |
| F9 | API-key pool rotation | account | `src/providers/key-failover.ts` (`hasKeyPoolFailover` and the 429 swap) | 429 | `providers.<name>.apiKeyPool` with 2+ keys | **no, by design** |
| F10 | Remote Link Child, Home unreachable | local | `src/client/link-relay.ts` answers `503 "link tunnel unavailable"` (retryable) before sending the key or body | tunnel not connected, owner unproven, wait budget spent | none | n/a: no local path exists |
| F11 | Hub client, Home unreachable | local | `src/client/hub-relay.ts` answers `502 "hub relay unavailable"`; `src/client/hub-state.ts` reads "unavailable", never local state | fetch failure, oversize, redirect | none | n/a: no local path exists |

F10 and F11 show that **neither a Child nor a Hub client can serve from local providers today.** Both run the
relay-only client runtime (`src/client/runtime.ts`), which has no provider dispatch. `ocx start` refuses to
start when the client state is invalid or mismatched rather than starting standalone (`src/cli/index.ts`,
"client startup refused"). The only path back to a standalone runtime that serves local providers is
`scheduleStandaloneRecycle`, and it runs only when the link itself ends (`ocx disconnect`, a changed link
id, or a missing sidecar), never on an outage. The supervisor's display probe reports `home_unreachable` in
`GET /api/link/status` and never cuts the tunnel (`src/client/link-tunnel.ts`). What is missing on this side
is a stable error code, a per-device record of the operator's choice, and status that shows it.

These are out of scope because the target does not change: same-target retries and 429 replay
(`src/lib/upstream-retry.ts`), the Antigravity direct lane falling back to the bridge for the same request
(`src/protocols/settings.ts`, `protocols.rollout.antigravityDirect`), WebSocket to HTTP transport fallback,
and new-session account *selection*. Choosing the least-used account for a session that is not yet bound is
selection; moving a bound session or a failed request to another account is a hop.

## 4. Configuration

One additive top-level section. Every leaf is optional; absence means today's behavior.

```jsonc
"fallback": {
  // global, per kind; absent = true (allowed, today's behavior)
  "model": true,
  "account": true,
  "provider": true,
  // per provider: the provider of the target the request started on
  "providers": { "anthropic": { "account": false } },
  // per model or route: an exact public selector (combo/<id>, policy/<id>, provider/model, an alias)
  "routes": { "combo/coding": { "provider": false } },
  // per device, read on the Home: Remote Link link id (lnk_…) or Hub-client key id
  "devices": {
    "lnk_0123456789abcdef": { "localFallback": false, "model": false }
  }
}
```

- `model`, `account` and `provider` are booleans at every scope. A hop's kind is decided by what changes:
  provider differs → `provider`; same provider, different model → `model`; same model, different account or
  key → `account`. One hop has exactly one kind.
- `localFallback` exists only under `devices`. Absent means `false`: the device never serves its local
  providers when the Home is unreachable, which F10 and F11 already guarantee. The key lives on the Home
  because the Home already owns per-device records (links, Hub keys); the Child reads its own row through the
  existing management relay and shows it in its status.
- The schema goes in `src/config/schema/` with strict validation and a `src/config/load-degrade.ts` rule that
  drops a malformed leaf (treated as absent) and reports it in config diagnostics, as `classifierFallbacks`
  already does.

CLI, registered in `src/cli/capabilities.ts` so `bun run skill:surface` regenerates the skill map:

```text
ocx fallback status [--json]
ocx fallback off   [--kind model|account|provider|all] [--provider <p> | --route <selector> | --device <id|alias>]
ocx fallback on    [same flags]
ocx fallback clear [same scope flags]            # remove the override at that scope
ocx fallback local on|off --device <id|alias>    # on the Home; per-device local fallback
```

`--device` accepts a link id, a Hub key id, or the link alias from `ocx link status`. The dashboard writes
through `PUT /api/fallback` under management auth.

## 5. One resolver, one guard, one record

`src/routing/fallback-policy.ts`, on the core path, imports nothing from `src/lab/` and starts no timer:

```ts
type FallbackKind = "model" | "account" | "provider";
type FallbackScope = "route" | "provider" | "device" | "global" | "default";
resolveFallbackPolicy(config, { kind, route?, provider?, deviceId? })
  → { allowed: boolean; scope: FallbackScope; scopeKey?: string };
guardFallbackHop(config, hop: { kind, route, from, to, trigger, deviceId? })
  → { ok: true } | { ok: false; refusal: FallbackRefusal };   // records the event either way
```

Each site in §3 calls `guardFallbackHop` at the exact point it would switch targets: F1 before dispatching
the next combo target and in the picker when the first target is skipped for cooldown; F2 before returning a
non-primary model; F3 before the rewrite; F4 before the next candidate; F5 before the next classifier
candidate; F6 to F9 before moving a bound session or a failed request to another account. No site reads
`config.fallback` itself, and a source-oracle test enforces that.

The device id comes from admission. A Remote Link request arrives under the link's configured key
(`src/link/relay-auth.ts`, `src/server/admission-model-scope.ts`, `admission.kind === "configured"`), and a Hub
client under its data key. Loopback and unkeyed requests have no device scope.

The record is an in-memory ring of the last 20 hop events, taken or refused, each with `at`, `route`,
`kind`, `from`, `to`, `trigger` (a coarse code: `quota_exhausted`, `rate_limited`, `upstream_5xx`,
`cooldown`, `auth_refused`, `home_unreachable`), `outcome` and `scope`. `from` and `to` are public
selectors (`provider/model`); for an account hop they are the provider name and the word "account", never an
account id, label, email or key. No request bodies. The ring is cleared on restart.

## 6. Error contract

A refused hop answers with the **status of the failure that triggered it**, so client retry behavior does not
change (a refused 429 stays a 429), and with this body:

```json
{
  "error": {
    "type": "fallback_refused",
    "code": "fallback_refused",
    "message": "combo/coding: anthropic/claude-x failed (rate_limited). Provider fallback to openai/gpt-y is off for route combo/coding. To allow it: ocx fallback on --kind provider --route combo/coding",
    "fallback": { "kind": "provider", "scope": "route", "scopeKey": "combo/coding",
                  "from": "anthropic/claude-x", "to": "openai/gpt-y", "trigger": "rate_limited" }
  }
}
```

The response also carries `x-opencodex-fallback: refused`. A proactive refusal, where the primary is already
known to be exhausted and the hop would happen before any upstream call, answers 429 for quota and cooldown
triggers and 503 otherwise, and never contacts the fallback target. An allowed hop adds
`x-opencodex-fallback: taken`, which GOAT's parity check can read next to `x-opencodex-served-by`.

Hub down keeps today's status and retry semantics and adds stable fields. The Child's 503 and the Hub client's
502 both carry `error.code: "home_unreachable"` and `error.localFallback: false`, with the message "The Home is
unreachable. Local fallback is off for this device, so OpenCodex did not serve this request from local
providers. Retry, or allow it on the Home with: ocx fallback local on --device <id>". The existing `error` and
`retry` keys stay for older readers.

## 7. Defaults and migration

No default changes. An absent `fallback` section keeps every chain exactly as today, and an absent
`localFallback` reads `false`, which is also today's behavior. The section is additive, so nothing rewrites
existing configs. An older Home has no `fallback` field in its status, which GOAT reads as unknown.

## 8. Visibility

- `ocx status --json` gains `fallback: { policy, effective: { model, account, provider }, devices, last, recent }`.
  A Child shows its own device row (read from the Home through the management relay) and its last
  `home_unreachable` refusal.
- `GET /api/fallback` is a passive read for the dashboard and GOAT; `PUT /api/fallback` writes.
- Dashboard: a **Fallback** card in Settings with the three global switches, the list of overrides, and the
  last hop with time, route, from → to and reason; a per-provider switch on the provider page; a per-route
  switch on the combo and routing-profile editors. The Remote Link page on the Home gets "Local fallback" and
  "Chains" columns per device; on a Child it shows a read-only line, "Local fallback: off. Requests fail with
  home_unreachable while the Home is down."
- Docs: an English `docs-site/` page "Fallback off" and an update to the Remote Link page; translated locales
  get no contradicting text. When the code lands, `structure/runtime.md` (combos, Remote Hub) and
  `structure/remote-link.md` gain present-tense contract paragraphs.

## 9. Open product choices (blocking implementation)

**C1. Precedence between scopes.** The brief names this one.

| Option | Rule | Good at | Cost |
|---|---|---|---|
| A. Most specific wins | route > provider > device > global | "off everywhere except combo/coding" works | a route `true` can reopen a hop a device owner turned off |
| B. Any off wins | refuse if any applicable scope says `false` | simplest to reason about; nothing reopens a refusal | no exception is possible under a global off |
| C. Target scopes most specific, device as ceiling (**recommended**) | resolve route > provider > global, then a device `false` refuses regardless | exceptions work, and a device's "never fall back" is absolute, which matches GOAT's per-device framing | two rules to explain |

**C2. What `localFallback: true` means in OpenCodex.**

- Option A (**recommended**): a published permission only. The Child stays relay-only and keeps the 503. GOAT
  "allows a hop to a local provider instance on that device (`modelRoute: "default"`) only when … OpenCodex's
  fallback state for that scope does not forbid local providers", so it reads this flag and does the hop
  itself. No second runtime on the Child, and the "Child never serves locally" invariant stays.
- Option B: OpenCodex itself serves the request from the Child's own providers while the Home is unreachable.
  That puts the full standalone server inside the client runtime, needs local sign-ins on Children, and
  duplicates GOAT's hop.

**C3. May account rotation (F7 to F9) be switched off?** The config types record a prior maintainer decision:
reactive 429 rotation "cannot be switched off: rotating away from an account upstream has just rate-limited
only ever runs after a refusal, so stranding it while a second logged-in account sits idle is a defect rather
than a configuration choice" (`src/types/config.ts`, `anthropicAccountPool`; the same rule is restated for
`oauthAccountFailover`). The brief asks for "don't fall back to another … account". Options:

- A (**recommended**): `account: false` refuses F6 to F9. It reverses that decision only for operators who opt
  in, and the default is unchanged.
- B: F7 to F9 stay always on; `account: false` covers only F6 (Codex pool switches, including pool → signed-in
  main).
- C: account refusal only per provider, never global.

## 10. Tests (once the choices are made)

- `tests/routing/fallback-policy.test.ts`: the precedence matrix over kinds × scopes × values for the chosen
  C1, plus malformed-leaf degrade.
- One file per site, each proving refusal when off (status, body, header, fallback target never contacted)
  and unchanged behavior when on: combos, subagent fallback, hard-lock fallback, routing profile, classifier
  fallbacks, Codex pool, Anthropic, generic OAuth and API-key pools. New files land in their domain directory
  and are registered in `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected*.json`.
- Child and Hub client with the Home unreachable: `home_unreachable` body, no provider module loaded or
  called, link key and body never sent.
- Status: `ocx status --json` and `GET /api/fallback` shapes, plus a privacy check (no account ids, keys or
  bodies).
- Source oracle: only `src/routing/fallback-policy.ts` reads `config.fallback`, and the resolver stays out
  of the Lab import graph (`tests/lab/core-lab-boundary.test.ts`).
- GUI component tests beside the existing Settings and Remote Link tests; `bun run lint:gui` and
  `bun run build:gui`.
