# OCX-11 fallback off — design

> Written 2026-10-21, revised 2026-10-22 after the supervisor decisions (§9) · implemented in PR #7482.
> Consumer: GOAT hub design, goat-si/goat PR #684 (ADR-0021 §1.6, design doc §1.6 and DH3).
> The present-tense contract is [structure/fallback-policy.md](../../../structure/fallback-policy.md).

## 1. Goal

Give the operator one clear way to say "do not fall back; fail with a clear error instead", for two families:

- **Hub down.** A Remote Link Child or Hub client whose Home is unreachable never silently serves from
  its own local providers, and the operator can see and set the per-device local fallback permission.
- **Fallback chains.** Model and provider fallback (combos, subagent fallback, the main-account
  hard-lock fallback, routing profiles) can be refused per scope: global, per provider, per model or
  route, and per device.

Defaults stay exactly as they are today (§7).

## 2. Terms adopted from GOAT

ADR-0021 §1.6 and its design doc define the hub-down policy. This note reuses these terms verbatim:

- "a Child never silently serves its local providers when the Home is unreachable, and model, account and
  provider fallback chains can be turned off per scope" (design §1.6, describing this package). The
  account part is settled differently: see §9 C3.
- "**local fallback** opt-in per device" (DH3: "pause plus decision item; local fallback opt-in per device").
  GOAT's switch is `hub.devices[alias].localFallback`; the OpenCodex key is
  `fallback.devices.<deviceId>.localFallback`, so the leaf reads the same on both sides.
- "goal work on that device **pauses** (health condition `HubUnreachable`), people's own threads see
  OpenCodex's 503 as today". OpenCodex keeps that 503 and adds `code: "home_unreachable"` (§6).
- "GOAT reads that state; it never changes OpenCodex fallback settings", shown as "**on, off, unknown**
  when the Home predates OCX-11". The Home advertises `fallback-policy/1` in `/readyz` `features`;
  GOAT reads its absence as unknown.
- "**GOAT fallback**" (ADR-0018 chains) is GOAT's word for moving GOAT work to another provider instance.
  OpenCodex never uses that phrase; its own hops are "model fallback", "provider fallback" and "local
  fallback".

## 3. Inventory

A fallback is a hop that serves a request from a **different model** or a **different provider** than
the one chosen or requested.

| # | Fallback | Kind | Where | Governed |
|---|---|---|---|---|
| F1 | Combo failover | provider or model | `src/server/responses/core-combo.ts` `executeComboResponses`; decisions in `src/combos/failover.ts`, picker in `src/combos/resolve.ts` | yes: reactive hop at the dispatch loop, proactive for a cooling first `failover` target |
| F2 | Subagent model fallback | model or provider | `src/codex/subagent-model-fallback.ts` `applySubagentModelFallback` | yes, proactive |
| F3 | Main-account hard-lock fallback | provider or model | `src/server/responses/main-hard-lock-routing.ts` `applyMainHardLockFallbackOverride` | yes, proactive |
| F4 | Routing-profile fallback | provider or model | `src/server/responses/policy-fallback.ts` `handleResponsesWithPolicyFallback` | yes, reactive |
| F5 | Claude Code classifier fallbacks | — | `src/claude/inbound-model-options.ts` | not a hop: the first configured entry always wins, with no availability check |
| F6–F9 | Codex pool account switch (including pool → signed-in main), Anthropic OAuth, generic OAuth and API-key pool rotation | — | `src/codex/routing/selection.ts`, `src/oauth/anthropic-routing.ts`, `src/oauth/generic-account-failover.ts`, `src/providers/key-failover.ts` | not a fallback: intra-pool rotation (§9 C3) |
| F10 | Remote Link Child, Home unreachable | local | `src/client/link-relay.ts` | no local path exists; 503 gains `home_unreachable` |
| F11 | Hub client, Home unreachable | local | Codex on a Hub client talks to the Hub URL directly; the local listener carries only the dashboard relay (`src/client/hub-relay.ts`, 502) | no local path exists; 502 gains `home_unreachable` |

Neither client kind can serve from local providers: both run the relay-only client runtime
(`src/client/runtime.ts`), `ocx start` refuses an invalid client state instead of starting standalone
(`src/cli/index.ts`), and the standalone recycle runs only when the link itself ends, never on an outage.
`tests/clients/client-home-unreachable.test.ts` pins this with a load-time import-graph check.

Out of scope because the target does not change: same-target retries (`src/lib/upstream-retry.ts`),
the Antigravity direct lane's bridge fallback (`src/protocols/settings.ts`), transport fallbacks.

### Fallback versus intra-pool rotation

A **fallback** changes *what* answers: another model or another provider, with different capabilities,
pricing, privacy terms or quality. An operator can reasonably refuse that.

**Intra-pool rotation** changes only *which credential* answers for the same provider and model: the
next account of an OAuth pool or the next key of an API-key pool when one is rate-limited, or the Codex
pool's move away from an account at its usage threshold. The request, model and provider are unchanged.
The maintainer rule recorded in `src/types/config.ts` says rotating away from an account upstream has
just rate-limited "only ever runs after a refusal, so stranding it while a second logged-in account sits
idle is a defect rather than a configuration choice". OCX-11 keeps that rule: rotation is resilience
inside one pool and these controls do not govern it. An operator who wants one account only configures
one account, or pauses the others, with the existing pool controls.

## 4. Configuration

```jsonc
"fallback": {
  "model": true,                                  // absent = true
  "provider": true,
  "providers": { "anthropic": { "model": false } },
  "routes": { "combo/coding": { "provider": false } },
  "devices": { "lnk_0123456789abcdef": { "localFallback": false, "model": false } }
}
```

A hop's kind is decided by what changes: provider differs → `provider`; same provider, different model →
`model`. A malformed leaf reads as absent and diagnostics name the section. Device keys are a link id
or a Hub data key id; the resolver maps a request's admission key id to its link through the link store.

CLI: `ocx fallback status|off|on|clear [--kind model|provider|all] [--provider|--route|--device]` and
`ocx fallback local on|off --device <id|alias>`. Management: `GET|PUT /api/fallback`.

## 5. Resolver

`src/routing/fallback-policy.ts`: `resolveFallbackPolicy`, `fallbackHopKind`, `guardFallbackHop` (records
and refuses) and a 20-entry event ring. Nothing else reads `config.fallback` on the request path.
`src/routing/fallback-state.ts` builds the `ocx.fallback/1` view and applies the scoped write.

## 6. Error contract

A refused hop answers with the status of the failure that triggered it (with its `Retry-After`), or 429
for proactive quota/cooldown/hard-lock refusals and 503 otherwise, and:

```json
{ "error": { "type": "fallback_refused", "code": "fallback_refused", "message": "… To allow it: ocx fallback on --kind provider --route combo/coding",
  "fallback": { "kind": "provider", "scope": "route", "scopeKey": "combo/coding", "from": "a/m", "to": "b/n", "trigger": "rate_limited" } } }
```

plus `x-opencodex-fallback: refused`. A taken hop is recorded in status; no header is added to the
answering response, because the combo and policy responses are built deep in child dispatch.

Hub down keeps status and retry semantics: `{ "error": "link tunnel unavailable", "code": "home_unreachable", "message": "…" }`
on a Child (503) and `{ "error": "hub relay unavailable", "code": "home_unreachable", … }` on a Hub
client's dashboard relay (502).

## 7. Defaults and migration

No default changes and no migration: absent `fallback` keeps every chain as it was, and an absent
`localFallback` reads false, which is what a Child already does.

## 8. Visibility

`ocx status --json` `fallback` (live, the Home's over the link on a Child, or the local policy), `GET
/api/fallback` (also over the link relay, aliases omitted), `/readyz` `fallback-policy/1`, and the
dashboard Fallback panel on the Dashboard overview and on Remote Link. Events carry time, site, route, kind, from, to,
trigger, outcome, scope and device id; never bodies, keys or account identities.

## 9. Decisions (supervisor, 2026-10-22)

- **C1 precedence: accepted.** Route > provider > global, most specific first; a device set to off always refuses.
- **C2 `localFallback: true`: accepted as permission only.** OpenCodex keeps answering 503 when the Home is
  unreachable; GOAT reads the flag and moves the work itself (ADR-0021 §1.6, "pause + decision item").
- **C3 account rotation: overridden.** Account-pool 429 rotation stays not switchable; the maintainer rule
  in `src/types/config.ts` stands. Rotation is intra-pool resilience, not fallback, so the `account` kind
  is out of OCX-11 (§3, "Fallback versus intra-pool rotation").

## 10. Tests

`tests/routing/fallback-policy.test.ts` (81-case precedence matrix, degrade, device identity, contract,
privacy), `tests/responses/responses-combo-fallback-off.test.ts`, `tests/routing/routing-policy-fallback-off.test.ts`,
`tests/routing/subagent-model-fallback-off.test.ts`, `tests/codex-integration/main-account-hard-lock-fallback-off.test.ts`,
`tests/server/fallback-routes.test.ts`, `tests/clients/client-home-unreachable.test.ts`, `tests/cli/cli-fallback.test.ts`,
`tests/server/readyz-features.test.ts` and `gui/tests/fallback-panel.test.tsx`.
