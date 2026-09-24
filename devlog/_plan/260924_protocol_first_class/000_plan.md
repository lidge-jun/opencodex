# 260924 Protocol first class — plan

Responses stays the first-class feature surface. What changes is that Chat Completions and
Anthropic Messages stop needing the public Responses JSON/SSE as a mandatory intermediate to
reach the shared execution policy. Same-wire requests keep their source representation;
cross-wire requests convert through the adapter-neutral IR; one execution owner keeps account
selection, affinity, send budget, retry, cancellation and logging.

## Outcome

```text
Responses / Chat / Messages request
  -> source body kept + lazily parsed intent
  -> shared admission, routing, execution policy
  -> final provider / model / credential settled
  -> per-attempt protocol plan
       same wire        : native builder from the source body
       different wire   : codec -> IR -> target builder
       not migrated yet : legacy bridge (internal Responses), labelled as such
       not expressible  : refused before any send (when policy = reject)
  -> upstream

same wire     : upstream -> safe relay + observation -> client wire
different wire: upstream -> AdapterEvent -> client encoder
```

## Non-goals

- Files, Batches and Responses CRUD APIs; every beta feature; lossless behavior for arbitrary
  custom providers; emulating every Responses-only feature on Chat or Messages.
- A second or third execution engine. Native lanes reuse the shared attempt, budget, cancel
  and log owners; they do not copy them.
- Renaming the Responses schema and calling it a neutral IR.
- Forwarding arbitrary headers or body fields to every provider unchecked.
- Guessing native support from a provider name in the GUI.
- A shadow mode that sends two inferences. Shadow compares plans only.
- Presenting one successful connection as protocol verification.

## Invariants every work packet keeps

1. The planner never selects a provider. It consumes the route the router settled
   (`ResolvedModelPolicy` precedence: hard-pin, explicit override, ingress-scoped registry
   default, provider default) and decides only the wire within that route.
2. No native lane may bypass admission scope, send budget, affinity, key failover, cancellation,
   request logging or spend accounting. A native lane that lands before its safety wiring is
   not acceptable in any order.
3. Every fallback candidate builds its request from the source envelope. An earlier candidate's
   deleted fields or injected headers are never the next candidate's input.
4. Plan and trace records carry only fixed vocabulary (`src/protocols/contract.ts`) and
   identifiers the server already exposes. No prompt, tool argument, token, signature or key.
5. `native` (a delivery mode) and `VERIFIED` (a Lab evidence verdict) are different axes and
   are never merged into one badge.
6. Every rollout switch defaults off and changes nothing while off
   (`resolveProtocolSettings`, `src/protocols/settings.ts`).
7. The core request path stays free of Lab imports
   (`tests/lab/core-lab-boundary.test.ts`).
8. Files at their file-size cap (`tests/fixtures/file-size-baseline.json`) do not grow; code
   moves out first. `src/server/request-log.ts` sits at 1996 of a 2000-line threshold.

## Work packets and stack order

Each packet is one pull request, stacked on the previous one. PF numbers are work ids, not
GitHub numbers.

| Packet | Branch | Scope | Doc |
|---|---|---|---|
| PF-01 | `feat/pf01-protocol-contract` | vocabulary, feature dispositions, 18-cell baseline, plan/trace DTOs, settings keys | [010](010_contract_and_baseline.md) |
| PF-02 | `feat/pf02-protocol-trace` | observed path trace on request/attempt rows, persisted; Logs badge, detail, filter | [030](030_gui_and_management_api.md#pf-02-observed-path-trace) |
| PF-03 | `feat/pf03-protocol-plan` | pure planner, `GET /api/protocols`, `POST /api/protocols/plan`, API page preview | [030](030_gui_and_management_api.md#pf-03-planner-and-preview) |
| PF-05 | `feat/pf05-inference-primitives` | shared execution context, attempt and delivery primitives, client-wire marker | [020](020_engine_and_codecs.md#pf-05-shared-inference-primitives) |
| PF-04 | `feat/pf04-api-surfaces` | Messages exposure split from Claude integration, settings PATCH, API cards | [030](030_gui_and_management_api.md#pf-04-api-surface-settings) |
| PF-06 | `feat/pf06-source-envelope` | source envelope, codecs, unrepresentable guard | [020](020_engine_and_codecs.md#pf-06-source-envelope-and-guard) |
| PF-09 | `feat/pf09-direct-encoders` | AdapterEvent to Chat/Messages encoders behind `directEncoders` | [020](020_engine_and_codecs.md#pf-09-direct-client-encoders) |
| PF-07 | `feat/pf07-native-chat-combos` | eligible Chat candidates in combos/policy send natively | [020](020_engine_and_codecs.md#pf-07-native-chat-candidates-in-combos) |
| PF-08 | `feat/pf08-managed-messages-native` | key-auth Anthropic targets receive `/v1/messages` natively | [020](020_engine_and_codecs.md#pf-08-managed-native-messages) |
| PF-11 | `feat/pf11-protocol-evidence-gui` | provider protocol panel, compatibility pair filters, combo guarantees, deep links | [030](030_gui_and_management_api.md#pf-11-evidence-combo-and-provider-views) |
| PF-10 | `feat/pf10-auth-opaque-state` | beta allowlist, OAuth native Messages, cross-domain opaque state guard | [020](020_engine_and_codecs.md#pf-10-auth-and-opaque-state) |
| PF-12 | `feat/pf12-protocol-rollout` | shadow plan comparison, docs, not-migrated inventory | [040](040_acceptance_and_rollout.md) |

PF-05 lands before PF-04 because PF-06 through PF-09 build on its primitives and PF-04 does
not; the dependency order, not the id order, decides the stack.

## Verification policy for this unit

Each pull request records exactly what ran. Unit tests are written beside each change and
registered in the test layout; whether they were executed is stated per PR, never implied.
Default flips for rollout switches are out of scope until the acceptance scenarios in
[040](040_acceptance_and_rollout.md) have recorded evidence.
