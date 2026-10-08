# JEV Decision Routing

This document owns the JEV Combo decision contract: the canonical TypeSafe preset, self-hosted
System One rows, the decision backends, the request-path integration, the dashboard surfaces,
and the content-free statistics projection. Provider and adapter selection in general stays in
[Providers And Adapters](../providers-and-adapters.md).

`src/providers/registry/entries-extended.ts` owns the canonical `jev` key preset at
`https://api.typesafe.ai/v1/systemone` with adapter `jev-decision`. It is a credential owner, not an
inference route: the registry marks it `credentialOnly`, its adapter is deliberately absent from the
routable adapter registry, live discovery is disabled, no default/static model is published, and
key login returns unknown without probing a nonexistent model catalog. The normal `ocx login jev`
flow and provider-workspace API-key panel both persist the same credential-only row. Combo validation
rejects every `jev-decision` row as a target; `src/codex/catalog/gather-capture.ts` never gathers one.
`src/server/management/provider-routes.ts` tests those rows through `probeJevDecisionProvider`
(no user prompt, sanitized status); a retargeted `jev` row reports not-applicable and sends nothing.

The request path consumes a configured literal/reference key only when the row still matches the
canonical registry transport, with `TYPESAFE_API_KEY` and the standard provider-derived
`JEV_API_KEY` as explicit environment fallbacks. A same-named custom destination cannot receive
either credential through the JEV client; a retargeted `jev` row is ignored, never a custom
destination. Automated coverage mocks TypeSafe; live-key behavior is an operator smoke boundary. A Combo's `decisionProvider` selects the service: omitted or `"jev"` (stored as omission) is that
canonical path with `jev-latest`; any other id must be an enabled `jev-decision` row with a full
`/systemone` `baseUrl` and a `defaultModel`/`models[0]`, sending only its own `apiKey` (a TypeSafe
env reference or foreign keychain entry makes it unusable). `allowLocalCleartextPost` in
`src/lib/provider-outbound.ts` admits `http:` only with the row's explicit `allowPrivateNetwork`, a
`localhost`/loopback/RFC 1918/ULA host whose answers stay in that set, and no proxy. Options go out as
strings (Ollama requires them); under 2 or over 26 fail open locally (`no_choices`/`invalid`), unusable
rows reuse `missing_key`, and `decisionTimeoutMs` (1000..120000) replaces the 4 s default.

Decision backends. `src/combos/jev-dispatch.ts` derives the backend from the Combo and never stores
it: `decisionModel` set means `model`, a `decisionProvider` other than `jev` means `systemone`, and
neither means `typesafe`; setting both is a config error. The System One path is `src/combos/jev.ts`
unchanged, so the TypeSafe request bytes stay pinned by `tests/fixtures/jev-typesafe-request-golden.json`.
`src/combos/jev-model-backend.ts` asks an ordinary opencodex route for `{"choice":"<key>"}` over the
same bounded state and option map, under the same deadline, bounds, and fail-open gates;
`src/combos/jev-decision-contract.ts` holds the constants the GUI shares. The server glue
`src/server/responses/jev-model-invoke.ts` runs that choice as a fresh internal `/v1/responses` turn
with `tools: []`, its own send budget and turn lease, the parent's admission scope only, explicit null
caller credentials, no caller headers or history, a 1024-token `max_output_tokens` ceiling that
also sizes the spend reservation, and a 64 KiB bounded response; it is flagged
`internalDecisionCall`, which `src/server/responses/request-prepare.ts` uses to keep caller-scoped
memory and shadow-call rewrites off the decision turn and to refuse JEV Combo reentry. Save-time
recursion and route checks live in
`src/server/management/decision-model-validation.ts` (a decision model may not resolve, after Fast
or effort selector normalization, to its own Combo, any JEV Combo, or a `jev-decision` row; a provider
PATCH cannot turn a referenced row into one). `src/server/management/decision-routes.ts` serves
`POST /api/combos/decision-test`, one synthetic two-option probe of a saved or unsaved method (the
body's `decisionProvider` / `decisionModel` select the method, none means TypeSafe; `comboId` only
scopes the recursion rules, and a disabled, model-less or non-System-One row is refused by name), and
`GET /api/combos/decision-discovery`, read-only System One and catalog hints built by
`src/server/management/decision-discovery.ts`. Persisted decisions carry an optional `backend`, and
the usage aggregate reports per-backend counts and latency with older rows as `unknown`.

`src/combos/jev.ts` extracts bounded user-task, previous-assistant, and latest-tool-output text plus
the tool name and boolean signals; raw image data, tool arguments, encrypted reasoning, headers, and
the JEV credential are excluded. All three text samples omit recognized Codex protected envelopes
and Claude Code `<system-reminder>` blocks before clipping, including nested and unclosed blocks.
Only an envelope-only `codex_internal_context` goal outside a reminder may supply a fallback task;
reminder-only text supplies no task. Reminder-free inputs keep their existing sampling behavior.
It owns the joint target/effort choice map, strict response
validation, canonical `jev-latest` destination, default four-second deadline, no-redirect policy, bounded response,
and caller-cancellation propagation. Missing credentials or safe state, transport failures, and invalid
answers fail open to the first eligible target; no response can escape the configured choice map.
The direct TypeSafe and System One decision destinations are checked against the parent API key's
resolved provider/model scope before reading decision credentials or extracting state. A denied
optional decision uses the existing fail-open inference target without sending a decision request;
management probes and unrestricted admissions retain their existing behavior.
Telemetry never retains extracted state or credentials.

The optional `targets[].modelProfile` note is validated at the Combo management input
boundary to a non-empty string of at most 512 characters; tab, line feed and carriage
return are allowed for multi-line notes, every other C0 control character and DEL is
refused, and the value is stored sparsely.
`src/combos/jev.ts` sends a configured target note as `state.operator_notes` on a
JEV decision, keyed by target; built-in `instructions.model_profiles` and the
target/effort allowlist stay authoritative. The note reaches TypeSafe with each
applicable decision, so operators must keep secrets and private paths out of it.
An absent note leaves the prior decision payload shape intact.

`src/server/responses/core-combo.ts` computes current eligibility, asks JEV once for the initial pick,
applies the validated effort, and removes caller `service_tier` on the Responses child body. The
opt-in native Chat lane builds a separate body in `src/server/responses/core-combo-native.ts` and
does not apply that JEV effort override. A retryable child failure re-enters the ordinary Combo
fallback loop from the untouched request without another JEV call. Request and attempt
`requestedEffort` labels retain an applied differing JEV effort as `caller->forced`, followed by
later child transitions; native children omit the unapplied override and preserve their own
transitions. Absent or unchanged forced efforts keep the existing label.
`src/server/responses/combo-requested-effort.ts` owns this pure label calculation.
Each target may carry an optional non-empty `reasoningEfforts` allowlist. Omission keeps the
backward-compatible all-advertised behavior; a present list is intersected with current capabilities,
and an empty intersection removes that target from the JEV choice map rather than broadening it.
Direct models and every other Combo strategy bypass this path. The shared Combo editor owns the GUI
checkboxes and `Create JEV Auto` template. Inside that editor, a JEV Combo's `Decision method`
section (`gui/src/components/combo-workspace-jev-decision.tsx`) chooses TypeSafe, a System One row,
or an opencodex model route, with the timeout and a Test probe; there is no separate decisions page.

JEV setup stays inside those existing shells. A configured `jev-decision` provider Overview exposes
**Create JEV Auto**, which navigates to the registered `models/combos/jev-auto` action hash.
`gui/src/pages/Combos.tsx` owns that one-shot add intent and normalizes the hash when the modal
closes; `ComboWorkspace` and `combo-workspace-add-modal.tsx` reuse the ordinary Combo form and target
editor with a pure template from `combo-workspace-data.ts`. The template includes only currently
available Astra/Sol/Luna rows, remains fully editable, marks the first eligible row as fail-open,
and displays known effort ladders. The JEV provider is hidden from the target picker because it owns
only the decision credential. Existing model rows, default selection, and direct picker behavior are
unchanged; an existing `jev-auto` id or alias disables or reports the quick action.
An existing JEV Combo adds a lazy **Stats** detail tab. It polls only while visible, uses the
management API's JEV projection, and keeps decision-service tokens separate from physical model
tokens. Config remains the ordinary editable Combo form, including per-target effort allowlists.

`src/usage/jev-stats.ts` owns the parallel content-free JEV projection. Its retained accumulator is
keyed by Combo and stable preset boundary, shares concurrent reads, verifies append identity and LF
digest, clones before folding a suffix, and starts a fresh accumulator after a rebuild-required
scan. It counts physical sends from `attempts[].sendCount`, ignores zero-send rows for fallback
detection, and folds identities beyond 255 concrete rows into one explicit overflow row while
preserving global totals. Up to four JEV projections participate in the same app-owned memory budget
and eviction path as ordinary usage aggregates. Read failure returns HTTP 500 rather than a partial
projection.
