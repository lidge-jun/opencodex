# 030 — management API and dashboard (PF-02, PF-03, PF-04, PF-11)

No new top-level page. Each existing screen answers one question:

| Screen | Hash | Question |
|---|---|---|
| Integrations → API / Keys | `#integrations/keys` | How do I connect, and which path would this request take? |
| Providers → detail / settings | `#providers` | Which wire does this provider receive, and who decided that? |
| Models → Compatibility | `#models/compatibility` | Which protocol pair and feature is backed by which Lab evidence? |
| Models → Combos / Routing | `#models/combos`, `#models/routing` | What does each candidate do, and what do all candidates guarantee? |
| Logs | `#logs` | What did this request actually do, attempt by attempt? |

The GUI never re-implements protocol policy. It imports the leaf contract
(`src/protocols/contract.ts`, `features.ts`, `dto.ts`) for vocabulary and validation, and gets
every decision from the server.

## Management routes

| Route | Packet | Mutates | CLI |
|---|---|---|---|
| `GET /api/protocols` | PF-03 | no | `ocx api protocols`, bare `ocx api policy` (PF-12) |
| `POST /api/protocols/plan` | PF-03 | no | `ocx api explain` (PF-12) |
| `PATCH /api/protocols/settings` | PF-04 | yes | `ocx api policy` with a setting flag (PF-12) |

All three live in `src/server/management/protocol-routes.ts`, are mounted lazily from
`src/server/management-api.ts` under the `/api/protocols` namespace, and are declared in
`src/server/management/route-registry.ts`. They carried a `deferred-verb` exemption owned by PF-12
until PF-12 declared the three `api` capabilities in `src/cli/capabilities.ts`
(`src/cli/api-protocols.ts`) and removed it. Existing `/api/providers`, `/api/logs`, `/api/request-history` and `/api/lab/*` are
reused, not duplicated.

## PF-02 observed path trace

Server:

- `src/protocols/trace.ts` (server side, no GUI import): entry marks and attempt marks kept in
  WeakMaps keyed by the request log context and attempt objects, so `RequestLogContext` does not
  grow. `markProtocolEntry(logCtx, { inbound, lane, reasonCodes, features })` with lane
  `native | bridge`; `markProtocolBlocked(logCtx, { inbound, reasonCodes, features })`;
  `markAttemptProtocolPath(attempt, { mode, requestPath, responsePath? })`;
  `protocolTraceForRequest(logCtx, attempts)` derives `ProtocolTraceV1` at finalize.
- Derivation without an explicit attempt mark: Responses inbound → `responses,responses`
  (adapter `openai-responses`) or `responses,ir,<wire>`; Chat/Messages lane `native` →
  `<in>,<in>`; lane `bridge` → `<in>,responses` for a Responses upstream, otherwise
  `<in>,responses-internal,ir,<wire>`. No attempt and no native/blocked mark → no trace.
- Entry marks: `src/server/chat-completions.ts` (native vs bridge; features from the Chat body;
  reason codes for why the native lane declined), `src/server/claude-messages.ts` (caller-forward
  native passthrough, bridge, disabled surface and compatibility reject as blocked). The Responses
  ingress needs no mark.
- `src/server/request-log.ts` is 4 lines under the 2000-line threshold. First move
  `filterRequestLogs` and `filteredRequestLogCount` byte-for-byte into
  `src/server/request-log-filter.ts` (re-exported from `request-log.ts`), then add
  `protocolTrace?: ProtocolTraceV1` to `RequestLogEntry`, compute it in `addFinalRequestLog`,
  persist it through the usage row (`src/usage/log.ts` `PersistedUsageEntry`, validated with
  `parseProtocolTraceV1` on read) and hydrate it back in `requestLogEntryFromPersistedUsage`.
- `/api/logs` spreads the entry, so the DTO carries the trace with no route change. Add a
  `protocolMode` query filter (`native | translated | legacy-bridge | blocked | none`) in
  `request-log-filter.ts`.

Dashboard:

- `gui/src/components/protocols/ProtocolBadge.tsx`: compact `Chat → Chat` style path label with
  the mode as text, not colour alone. Rows without a trace show nothing in the list.
- `gui/src/components/protocols/ProtocolTracePanel.tsx`: a section in the Logs detail dialog —
  inbound, final mode, request/response path (internal Responses hop labelled as internal),
  reason codes, feature effects, per-attempt paths. A row without a trace says "no path data"
  instead of guessing.
- Logs filter: protocol mode, client-side in `gui/src/pages/logs-filter.ts` beside the existing
  filters.

## PF-03 planner and preview

Server:

- `src/protocols/plan.ts` (leaf, pure): `planProtocol(input): ProtocolPlanV1`. Input is a
  snapshot: `inbound`, `requestedModel`, `routeKind`, `candidates[]` (provider, model, adapter,
  `nativeEligible`, `declineReasons`), `features`, `surfaces`, `settings`, `policyRevision`,
  `basis`. It computes each candidate's path with the same rules PF-02 uses for observed paths,
  its feature effects, eligibility under the unrepresentable policy, and the
  guaranteed/partial feature sets. A disabled surface yields `blocked` with `surface-disabled`.
- `src/protocols/plan-snapshot.ts` (server side): builds the snapshot from config without side
  effects — `routeModel` (synchronous; no fetch, refresh or write), `captureRouteStaticPolicy`,
  `resolveWireProtocolOverride` with the inbound's wire spelling, `routeConcreteModel` for each
  combo target, and `isNativeChatRouteEligible` for Chat candidates. Messages caller-forward
  passthrough depends on the caller's credential and is reported with
  `caller-credential-required`, never assumed. Unknown models produce a plan with
  `routeKind: "unknown"`, no candidates and `unknown-model`.
- `GET /api/protocols` → `{ schemaVersion: 1, contractVersion, policyRevision, surfaces, settings, features: PROTOCOL_FEATURES }`.
- `POST /api/protocols/plan` body `{ model: string, inbound: Protocol, features?: ProtocolFeature[] }`
  (bounded: model ≤ 200 chars, at most 24 features, unknown keys rejected with 400) →
  `ProtocolPlanV1` with `basis: "preview"`. Never reads a request body sample, never logs input.

Dashboard (`#integrations/keys`):

- `gui/src/protocol-api.ts`: fetch + validate with `isProtocolPlanV1`; cache key is
  `apiBase + model + inbound + sorted features + policyRevision`; an older server that answers
  404 disables the panel quietly.
- `gui/src/components/protocols/ProtocolPlanPanel.tsx` and `FeatureDispositionList.tsx`: a
  "Request path preview" section in `ApiKeysWorkspace` (new section anchor after the endpoints
  section): model picker from the existing model list, inbound selector, feature toggles, and a
  Preview button. It states that preview sends nothing and costs nothing, shows per-candidate
  path, mode, fidelity, feature effects, reasons and the policy revision, and separates
  "guaranteed by all candidates" from "some candidates only".
- The existing per-protocol "Test" button stays the explicit live test; its result keeps saying
  that one success is a connection test, not verification.

## PF-04 API surface settings

- `resolveApiSurfaceSettings` becomes the only reader: `claudeInboundDisabled` in
  `src/server/claude-messages.ts` (both `/v1/messages` and `/v1/messages/count_tokens`),
  `buildApiAccessEndpoints` in `src/server/management/api-access.ts` (adds
  `surfaces: { responses, chat, messages }` with `enabled` and `source`; keeps
  `claudeCodeEnabled` for older dashboards), and the dashboard.
- `PATCH /api/protocols/settings` body `{ messagesEnabled?: boolean, unrepresentable?: "legacy" | "reject", rollout?: Partial<...> }`
  through the existing config mutation path (locked, atomic). Disabling Messages writes
  `apiSurfaces.messages.enabled = false` **and** `claudeCode.enabled = false` in the same save, so
  an older binary after rollback cannot reopen the endpoint. Enabling writes only
  `apiSurfaces.messages.enabled = true`. The `claudeCode` subtree is written through the same
  helper the Claude settings route uses, respecting its hand-edit protection.
- Dashboard: the endpoints panel becomes three API cards (Responses, Chat Completions, Messages)
  with state, endpoint, source ("explicit", "inherited from Claude settings", "invalid value —
  closed") and, for Messages, a toggle plus a link to the Claude page. A disabled Messages card
  stays visible.
- Upgrade/rollback matrix to record: absent → inherit; explicit false + old binary → closed;
  explicit true + `claudeCode.enabled=false` + old binary → closed (safe direction).

## PF-11 evidence, combo and provider views

- `GET /api/protocols?provider=<name>` adds `provider: { name, adapter, adapterSource, authMode, upstream, modelOverrides: [{ model, adapter, source }] }`
  from the provider's resolved static policy (`adapterSource` from `ResolvedModelPolicy`
  provenance; `hard-pin | operator | registry | provider-default`). Bounded to 64 overrides.
- `gui/src/components/provider-workspace/ProviderProtocolPanel.tsx` in provider settings:
  labels the adapter as "upstream wire this provider receives", shows the decision source and
  model overrides, and saves only through the existing `onUpdateProvider` → `PATCH /api/providers`.
  It never looks like an API exposure switch.
- Compatibility matrix: inbound and upstream protocol filters in
  `gui/src/pages/compatibility-matrix-shared.ts` / `CompatibilityMatrix.tsx`, mapping Lab
  identities with `protocolFromLabProtocol`. Absent Lab data reads "unverified", never "failed"
  or "unsupported".
- Combo detail (`gui/src/components/combo-workspace-detail-panel.tsx`): per-candidate path and
  the guaranteed/partial feature split from `POST /api/protocols/plan`.
- Deep links through the existing hash route helpers: plan panel → provider settings and
  compatibility; Logs trace → compatibility for that pair.
