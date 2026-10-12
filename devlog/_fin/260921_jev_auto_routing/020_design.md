# JEV Auto Routing Design

## Goal

Add one optional `jev-auto` model to OpenCodex. Each request sent to that model
is classified by JEV (TypeSafe System One), which chooses one configured target
model and a compatible reasoning effort. Every existing provider and model
remains directly selectable and keeps its current behavior.

The integration must feel native to OpenCodex: setup and candidate selection
live in the GUI, dispatch reuses the existing Combo machinery, and no separate
Python service or recursive loopback request is required.

The behavioral reference is
[`0xNatoshi/jev-codex-router`](https://github.com/0xNatoshi/jev-codex-router):
bounded per-turn context extraction, a joint model-and-effort choice, strict
answer validation, standard service tier, fail-open routing, and local decision
telemetry. The implementation is a TypeScript adaptation to OpenCodex's routing
and security boundaries, not a copy of its HTTP relay.

## User-visible invariants

1. Installing or enabling JEV does not hide, rename, disable, reorder, or
   redirect any existing model.
2. JEV is never made the default model automatically.
3. After the operator creates the JEV Combo, the integration publishes exactly
   one additional public selector, `jev-auto`, with display name `JEV Auto`.
4. Selecting any ordinary model bypasses JEV completely.
5. Removing or disabling the JEV Auto combo removes only `jev-auto`; candidate
   models remain available individually.
6. Candidate models are edited through the existing Combo target picker. The
   initial template is seeded with the available OpenAI Luna, Sol, and Astra
   models, but users may add or remove any currently routable OpenCodex model.

## Options considered

### External JEV provider sidecar

Run the reference Python server on loopback, register it as a custom
OpenAI-Responses provider, and have it call OpenCodex again with the selected
model. This is close to the reference deployment but requires a second service,
two lifecycle systems, recursive HTTP routing, loop prevention, and custom GUI
bridging for candidate configuration.

### Native JEV provider adapter

Represent JEV as a model provider whose adapter internally re-routes to another
provider. This reuses provider credential UI but makes an adapter own recursive
dispatch and failover, responsibilities already handled by Combos. It also
risks publishing both a canonical provider/model selector and the desired
`jev-auto` alias.

### Native JEV Combo strategy

This is the selected design. A Combo already owns an alias, a list of concrete
provider/model targets, target eligibility, retries, quota cooldowns, reasoning
capability calculation, request replay, and GUI editing. The new `jev` strategy
changes only how the first eligible target and effort are chosen. Existing
Combo failure handling owns subsequent attempts.

## Configuration model

### Decision-service credential

Add a registry-backed `jev` decision-service entry for credential ownership and
GUI setup. It has these fixed properties:

- endpoint: `https://api.typesafe.ai/v1/systemone`
- API model: `jev-latest`
- key authentication
- no live model discovery
- no directly routable language models

The entry exists to reuse OpenCodex's provider API-key storage, environment
reference resolution, masking, optional OS-keychain storage, and credential
management surfaces. It must never publish a model row or accept a normal model
dispatch. The runtime reads the key only when a Combo with strategy `jev` is
selected.

`TYPESAFE_API_KEY` remains a supported environment source. A key entered in the
GUI follows the same storage and redaction rules as other provider API keys.
Management DTOs expose only credential presence and health, never the value.

### JEV Combo

Extend `OcxComboStrategy` with `jev`. A normal Combo record remains the source
of truth:

```json
{
  "combos": {
    "jev-auto": {
      "alias": "jev-auto",
      "strategy": "jev",
      "targets": [
        {
          "provider": "openai",
          "model": "gpt-5.6-luna",
          "reasoningEfforts": ["low", "medium"]
        },
        { "provider": "openai", "model": "gpt-5.6-sol" },
        { "provider": "openai", "model": "gpt-6-astra" }
      ],
      "reasoningEffortMode": "adaptive"
    }
  }
}
```

The GUI template creates this record only after an explicit user action. It
filters unavailable seed targets rather than creating broken references. The
ordinary Combo editor remains authoritative after creation.

Each target may optionally persist a non-empty `reasoningEfforts` allowlist.
Omitting it preserves the original behavior and offers every reasoning effort
advertised by that target. When present, JEV receives only the intersection of
that allowlist and the target's current advertised ladder. A stale allowlist
must never broaden capability or silently turn into an unrestricted choice.

Target order has one extra meaning for this strategy: the first eligible target
is the fail-open target when JEV is unavailable or returns an invalid answer.
The GUI labels this clearly. For the reference triptych template, Astra is
placed first for fail-open parity even if the candidate list is displayed in a
friendlier order.

No per-model capability prose is persisted in the first version. Known Luna,
Sol, and Astra targets receive the reference capability profiles. Other targets
receive neutral criteria derived from their selector, display name, declared
input modalities, context window, and supported reasoning ladder. Richer
operator-authored model profiles are intentionally deferred until their schema
and portability contract are decided.

## Runtime architecture

### Activation boundary

Only a request resolving to a Combo whose strategy is `jev` imports and invokes
the JEV selector. Normal routes and other Combo strategies execute no JEV code,
start no timers, and perform no decision-service I/O.

The JEV selector is a leaf module under `src/combos/`. It receives an already
validated Combo, the current Responses body, and concrete eligible targets. It
does not import the server composition root or dispatch requests itself.

### Per-turn flow

```text
Codex request model=jev-auto
  -> existing Combo identification and admission
  -> calculate currently eligible targets
  -> derive each target's supported effort ladder
  -> extract bounded decision state from the Responses request
  -> one HTTPS call to TypeSafe System One
  -> validate the selected target+effort pair
  -> existing Combo child dispatch to that concrete provider/model
  -> existing Combo preflight, retry, quota, and response relay
```

The selection happens once per incoming model call, including tool-result
continuations. A failed concrete attempt does not spend another JEV decision:
the existing Combo loop tries remaining eligible targets in configured order.

### Decision state

Port the bounded extraction contract from the reference implementation:

- current user request with OpenCodex/system envelope blocks removed
- bounded recent assistant intent
- the most recent tool-result digest, without tool arguments
- whether image input is present
- request/item counts and step type

The full conversation, credentials, provider headers, encrypted reasoning
payloads, tool arguments, and raw image bytes never enter the decision request.
All strings and aggregate payload size have explicit limits. Oversized or
unrecognized input degrades to fail-open instead of being truncated without a
marker or sent in full.

### Choice contract

Build one TypeSafe `choice` question whose criteria are the Cartesian product
of each eligible target and its supported reasoning efforts. A target that
advertises no reasoning control contributes one model-only choice.

Each criterion uses an opaque local choice id. Provider names and model ids are
values in the criterion, never executable instructions. A response is accepted
only when:

- the answer contains the expected question,
- the selected choice id belongs to the exact request-specific candidate set,
- optional probabilities are finite, bounded, complete, sum within tolerance,
  and agree with the winning choice,
- optional confidence is finite and within `[0, 1]`.

Confidence and probability distribution are telemetry only. They never
override a valid choice.

### Applying the choice

The chosen concrete target is dispatched through the existing Combo child
request path. JEV's effort replaces any effort attached to `jev-auto` for that
child only and is validated against the target's resolved ladder. The child is
forced to the normal/default service tier; JEV Auto does not request Fast mode.

The original request body remains the replay source for fallback attempts. No
JEV metadata, API key, or decision response is inserted into model-visible
input.

## Failure behavior

JEV Auto is fail-open at the decision boundary:

- missing key
- timeout, DNS, TLS, or network failure
- non-2xx TypeSafe response, including exhausted credits
- malformed JSON
- missing, unknown, or inconsistent choice
- no safe extractable decision state

All use the first currently eligible target. The fail-open effort is `medium`
when supported, otherwise that target's declared default/nearest supported
effort, otherwise no explicit effort.

If no target is eligible, the existing Combo-unavailable response is returned.
Once a target is chosen, existing Combo behavior remains authoritative for
provider errors, quota cooldowns, retry ordering, stream preflight, committed
output, and final error delivery.

The TypeSafe call has a four-second timeout and `redirect: "error"`. It is never
retried within the same model call. Client cancellation and server shutdown
abort it through the request signal.

## Security and privacy

- The TypeSafe endpoint is registry-fixed HTTPS. User config cannot redirect
  the JEV credential to another origin.
- The API key is resolved immediately before the request and is never copied
  into logs, request metadata, Combo state, or management DTOs.
- Error text is bounded and sanitized before logging or returning status.
- Decision logs contain selectors, effort, timing, gate, and numeric usage only.
  They do not retain extracted prompt text.
- The GUI follows existing credential-consent and CSRF rules.
- JEV cannot select a target outside the configured, currently eligible target
  set, even if the service returns an arbitrary string.
- A JEV Combo cannot target itself or another path that resolves recursively to
  the same Combo.

## GUI design

### Setup

Add a `JEV` row to the provider catalog. Its setup pane accepts the TypeSafe API
key, links to the TypeSafe console/documentation, tests only the fixed decision
endpoint, and reports configured/missing/invalid without showing the key.

After successful setup, offer `Create JEV Auto`. This creates the Combo template
but does not select it as the default model and does not change global model
visibility.

### Candidate editing

Add `JEV` to the existing Combo strategy control. Reuse the current target
editor and model inventory; do not create a second model picker. The editor:

- marks the first eligible target as the fail-open target,
- shows each target's available reasoning efforts and lets the user select the
  exact non-empty subset JEV may choose,
- treats an omitted subset as "all advertised efforts" for backward
  compatibility and resets that default when the target model changes,
- prevents direct or indirect self-reference,
- warns when a target is disabled, missing, or has no usable route,
- permits saving only when at least one concrete target is valid.

The resulting catalog contains one `JEV Auto` row with selector `jev-auto`.
Candidate models continue to appear in their original provider groups.

### Observability

The Combo detail view shows the latest decision state without prompt content:
selected target, selected effort, decision latency, gate (`apply` or fail-open
reason), and timestamp. Request logs record the same fields and identify the
served provider/model through existing attempt records.

## Compatibility and rollout

- Existing Combo records and strategies remain valid without migration.
- Configurations from a newer build that contain strategy `jev` degrade by
  disabling only that Combo on an older build; provider/model configuration is
  preserved.
- Disabling or deleting the JEV decision-service entry leaves the Combo record
  intact but makes requests fail-open.
- Disabling or deleting the Combo removes `jev-auto` on the next normal catalog
  convergence.
- No system service, Python runtime, loopback port, OpenCodex bind change, or
  automatic migration is introduced.

## Expected implementation boundaries

- `src/types/config.ts` and config schema: `jev` Combo strategy and validation.
- `src/combos/`: bounded state extraction, TypeSafe client, decision validation,
  and strategy-aware initial selection.
- `src/server/responses/core-combo.ts`: one async initial-selection seam and
  application of the selected effort; existing dispatch/retry remains intact.
- provider registry and management API: fixed JEV credential owner and bounded
  key-health test.
- `gui/src/components/combo-workspace-*`: strategy option, default template,
  fail-open labeling, and candidate editing.
- provider catalog/auth UI: JEV key setup and `Create JEV Auto` action.
- request-log DTO/UI: secret-free decision metadata.
- docs and structure ownership notes required by the touched source areas.

No broad adapter refactor, generic AI-router framework, external process
manager, or unrelated Combo behavior change belongs in this PR.

## Test design

### Pure decision tests

- bounded extraction for text, images, tool continuations, envelope-only input,
  malformed items, and oversized state
- request-specific criterion generation for mixed reasoning ladders
- valid choice acceptance and rejection of unknown, incomplete, non-finite, or
  inconsistent answers
- known reference profiles versus neutral metadata-derived profiles
- deterministic fail-open target and effort selection

### Runtime tests

- ordinary models and non-JEV Combos perform no TypeSafe request
- `jev-auto` dispatches exactly the selected provider/model and effort
- incoming model effort and Fast preference cannot override the JEV decision
- missing key and every bounded upstream failure class dispatch fail-open
- JEV is called once when the chosen model fails and normal Combo fallback runs
- self-reference and unavailable targets never enter the criteria
- cancellation aborts an in-flight decision call
- request logs contain decision metadata and no extracted text or key material

All TypeSafe traffic is mocked. Tests require no real JEV key.

### Management and GUI tests

- key values are write-only and redacted from every DTO/error path
- the fixed endpoint cannot be overridden
- setup creates one disabled-until-requested `jev-auto` catalog addition and
  never changes the default model
- target editing round-trips exact provider/model ids and preserves unrelated
  Combo fields
- target effort editing round-trips an exact non-empty subset and JEV never
  receives unchecked or newly unsupported efforts
- the JEV API key can be stored through the provider GUI and `ocx login jev`
- removal affects only `jev-auto`
- keyboard, focus, labels, loading, and error states follow existing provider
  and Combo accessibility patterns

### Verification gates

- focused Combo, routing, management, catalog, request-log, and GUI tests
- `bun run typecheck`
- `bun run test`
- `bun run privacy:scan`
- `bun run structure:check`
- `bun run prepush`
- local no-key smoke proving `jev-auto` reaches its fail-open target while a
  directly selected model bypasses JEV

A real decision smoke is deferred until the user supplies a TypeSafe key and is
reported separately from mocked and no-key coverage.

## Acceptance criteria

- Existing model/provider behavior and picker availability are unchanged.
- Enabling the integration adds exactly one opt-in `jev-auto` selector.
- GUI setup stores or references the TypeSafe key without exposing it.
- GUI users can choose the concrete models JEV is allowed to select.
- GUI users can choose the exact advertised efforts JEV is allowed to select
  for each target, while older configs with no target allowlist still mean all.
- Every JEV call chooses only from the current eligible candidates and jointly
  selects a compatible effort.
- Missing or broken JEV fails open predictably without blocking a turn.
- Existing Combo retry, quota, streaming, continuation, and cancellation
  behavior remains authoritative after selection.
- No external JEV server or additional local port is required.
- Relevant focused and full verification gates pass before the PR is opened.
