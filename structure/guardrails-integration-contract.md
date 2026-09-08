# Guardrails integration contract for staged review

Status: proposed design freeze for [#3705](https://github.com/lidge-jun/opencodex/issues/3705),
not maintainer approval. The full implementation remains a reference draft in
[#4022](https://github.com/lidge-jun/opencodex/pull/4022). This contract describes
that implementation at `273d0fe4e027b2c6e8443bbc6d6db3e424c25aa7` and the
boundaries to preserve when splitting its review. It does not describe a
feature already shipped on `dev`.

The first proposed landing contains only the independent registry, scanner,
placeholder primitives, pinned rule assets and their tests. It has no proxy
activation, config switch, Management API or dashboard page. Installing that
core alone does not protect network traffic. Its internal string-restoration
primitive is not permission to restore arbitrary provider output; the later
data-plane boundary supplies that authorization.

## Request and response ownership

`src/guardrails/activation.ts` captures one immutable policy, including the
disabled state, before request work can observe later config changes. Routing
classifies the canonical provider before acquiring a compiled registry lease.
A known excluded provider bypasses that runtime. An unknown provider is treated
conservatively; a mixed-scope combo is protected as one logical turn.

`prepareGuardrailsTurn` in `src/guardrails/turn.ts` scans a cloned semantic body
after normalization and before provider serialization/I/O. Later plaintext
materialized by replay, recovery or sidecars must be scanned before its next
send, using the same policy, mapping and aggregate budgets. Retries do not
recapture live settings or renumber an already prepared body.

The outer `demaskGuardrailsResponse` boundary restores only allowlisted
assistant prose in successful output. Adapters, request logging, stored
canonical state and executable output stay on the masked side of this
boundary. Provider authentication headers are not prompt text and are not
replaced with placeholders.

## Protocol and failure matrix

All rows below refer to enforce mode on a protected logical turn. Disabled,
excluded and detect-only behavior is described in the policy table afterward.
Paths are repository-relative; the linked tests are review entry points, not
a claim that every assertion performs live provider I/O.

| Surface and owning hook | Before provider I/O | Client restoration and failure behavior | Regression entry point |
| --- | --- | --- | --- |
| Responses HTTP: `src/server/responses/core.ts` | Mask supported input after replay/normalization; rescan recovered task text before another send. | Successful JSON restores eligible assistant fields only. Error/incomplete envelopes, executable arguments and non-assistant fields remain unchanged on the masked boundary. | [data-plane](../tests/guardrails/guardrails-data-plane.test.ts), [real proxy JSON](../tests/guardrails/guardrails-server-e2e.test.ts) |
| Chat Completions: `src/server/chat-completions.ts`, routed Responses core | Classify provider and mask supported messages/tool text before native or routed serialization. | JSON follows the prose allowlist. Chat SSE restoration waits for `[DONE]`; a choice finish event alone is not whole-stream success. | [native Chat](../tests/guardrails/guardrails-chat-native.test.ts), [JSON-to-SSE refresh](../tests/guardrails/guardrails-refresh-248.test.ts) |
| Anthropic Messages and `messages/count_tokens`: `src/server/claude-messages.ts` | Apply the same scope and captured failure policy; native traffic uses provider ID `anthropic-native`. | Messages prose may restore on success; SSE requires `message_stop`. Tool inputs and thinking/signatures are excluded. Token counts have no prose to restore. | [native Messages](../tests/guardrails/guardrails-anthropic-native.test.ts) |
| SSE: `src/guardrails/sse-demask.ts`, `src/server/sse-payload-rewrite.ts` | Reuse the prepared logical turn. | Hold masked/restored forms starting at the first restoration. Release restored forms only at `response.completed`, Chat `[DONE]`, or `message_stop`. Failure, malformed data, premature EOF or capacity fallback releases held masked forms and disables further restoration. | [terminal, EOF and capacity cases](../tests/guardrails/guardrails-data-plane.test.ts), [relay flush](../tests/responses/sse-payload-rewrite.test.ts) |
| Client Responses WebSocket: `src/server/ws-bridge.ts` and Responses core | Route each logical turn through the protected request boundary; carry its scoped mapping. | Uses the same terminal-gated response rewrite. A failed turn never restores originals into its failure frame. | [real WebSocket turns](../tests/guardrails/guardrails-server-e2e.test.ts), [WebSocket regressions](../tests/responses/ws-upstream.test.ts) |
| Compact: `src/server/responses/compact.ts` | Preserve captured combo-wide scope through native/routed handoffs; scan local plaintext compaction envelopes. | Compact output is masked machine state, not assistant prose. Retain only a scoped in-memory mapping keyed by the exact compact artifact fingerprint. | [compact policies and retention](../tests/guardrails/guardrails-compact.test.ts), [mixed-combo admission](../tests/guardrails/guardrails-refresh-248.test.ts) |
| Tool, search, image/vision sidecars: `src/guardrails/loop-messages.ts`, `src/web-search/loop.ts`, `src/images/loop.ts`, `src/vision/` | Scan supported newly materialized semantic text before the next model/sidecar send, preserving the turn's aggregate budget. This does not scan image/file bytes. | Sidecar and executable tool payloads do not receive blanket restoration. A late failure may use passthrough only where a complete admitted original can be restored safely before I/O. | [loop messages](../tests/guardrails/guardrails-loop-messages.test.ts), [vision](../tests/vision/vision-sidecar-e2e.test.ts), [search](../tests/web-search/web-search.test.ts) |
| Retry, fallback and recovered continuation: Responses core, `src/server/responses/policy-fallback.ts` | Reuse prepared state. An excluded-to-protected route transition without that state refuses before the fallback send. | Policy weakening of an enforced continuation returns `409 guardrails_policy_changed`; conflicting mappings are not borrowed across identities or threads. | [policy fallback](../tests/routing/routing-policy-fallback.test.ts), [continuations](../tests/guardrails/guardrails-continuations.test.ts), [recovered input](../tests/server/agent-task-recovery.test.ts) |

## Policy and resource invariants

| Condition | Required behavior |
| --- | --- |
| Disabled or known excluded provider | Preserve ordinary proxy behavior; no Guardrails registry/WASM activation for that route. This is not protected traffic. |
| Detect mode | Scan/count supported findings without replacing outgoing text. Do not advertise protection. |
| Default request failure policy `block` | A scan/registry failure stops the affected send; capacity errors use `413 guardrails_capacity_exceeded`, other scan failures use `400 guardrails_scan_failed`. |
| Explicit request failure policy `passthrough` | May send the complete admitted original. Never forward a partially masked body. Late transformations block when complete rollback is unavailable. Emit a metadata-only high-severity event. |
| Response restoration failure | Preserve masked output regardless of the request failure policy. Never switch the response to original secrets because passthrough was configured. |
| Hot reload | Existing turns retain their captured policy and leased registry. Changes apply to newly admitted turns. |
| Missing continuation mapping | Preserve unresolved placeholders; the process cannot recover originals from a hash, compact artifact or another thread. |

Enforced limits include 128 KiB per scanned text leaf, 2 MiB semantic text per
logical turn, 4,096 findings and a 128 MiB aggregate regex-input budget. SSE
terminal staging has a combined 2 MiB / 4,096-block cap. These are separate
budgets, not interchangeable thresholds. Continuation mappings have an
absolute lifetime of at most one hour and bounded entry/byte retention;
activity cannot extend the original expiry. Their owners are
`src/guardrails/continuations.ts` and `compact-continuations.ts`.

No mapping or original value is written to disk. Activity records bounded
metadata only. It is not a durable audit log and cannot reconstruct a lost
mapping. Unknown or opaque fields, tool/schema definitions and binary/image
content remain outside the documented text-scanning coverage.

## Operator-visible restoration behavior

The operator procedure is maintained in the public
[Guardrails guide](../docs-site/src/content/docs/guides/guardrails.md#when-values-stay-masked).
A visible placeholder can be intentional executable-field protection, a lost
mapping or fail-closed response handling. Restarting again or disabling the
feature does not recover lost values. Diagnostic reports must use synthetic
reproductions, not original secrets or production transcripts.

## Proposed review and landing order

| Unit | Review scope | Activation boundary |
| --- | --- | --- |
| 1. Independent runtime core and rule provenance | Registry, RE2 scanner, validators, conflict resolution, string placeholders, pinned dependencies/assets/licenses, package checks and isolated tests. Rule provenance belongs with this core because scanner results depend on those exact bytes. | Inert: no config or server hooks, no network protection claim. |
| 2. Data-plane integration and lifecycle | Immutable policy/config, every protocol row above, scoped provider admission, JSON/SSE/WebSocket restoration, retries/compact/continuations, sidecar budgets, metadata telemetry and regressions. | Enablement must arrive with complete coverage of the advertised protocol contract; no global switch backed by one protected route. |
| 3. Management API | Authenticated settings/rules/Tester/import/export/Activity, atomic `If-Match` mutations, preview security diff and safe DTOs. | Builds on the reviewed runtime contract; no new service or credential store. |
| 4. Dashboard and operator docs | Existing OpenCodex components, five Guardrails sections, truthful protection status, consequence confirmations, responsive checks and public docs. | Exposes only capabilities already supplied by the reviewed API/runtime. |

This is a review plan, not four approved or independently mergeable features.
The first draft is extracted at the existing pinned base. The full draft stays
open as a reference; it is not rebased along the release train while direction
is pending. Later units may be reviewed as a stack, but only under the
repository's normal target-branch and readiness rules.

If maintainers prefer the earlier single non-streaming JSON spike, keep it a
non-mergeable/test-only seam exercise. Its scope must not be presented as
production protection for Chat, SSE, WebSocket or continuations.

## Maintainer decisions still required

| Boundary | Evidence to inspect before sponsorship |
| --- | --- |
| Product contract and split | Confirm the hook/failure matrix, operator behavior and whether core-first or a JSON-only spike is preferred. |
| Rule update channel | Donor/Gitleaks pins, per-file hashes, generated parity fixtures, licenses and manual update review; no runtime remote rule download. |
| RE2/WASM and package installation | Exact npm integrity, loader/binary hashes, embedded-source attribution, bounded scanner work, disabled-path imports and cross-platform package checks. |
| Management mutations | Authentication, JSON import validation, `If-Match`, atomic rollback, bounded RE2 compilation and metadata-only responses. |
| Synthetic test exceptions | Review the [contribution record](../CONTRIBUTING.md#guardrails-synthetic-test-fixtures); allowances are per verified test value, not permission to publish credentials. |

A maintainer must confirm the design and own the security review before adding
`maintainer-sponsored`. The author does not self-assign that label, resolve
unreviewed findings, or mark GitHub CI green from local receipts. The four
readiness boxes remain tied to the exact reviewed head.
