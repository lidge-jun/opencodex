---
title: Guardrails
description: Opt-in sensitive-data detection and reversible placeholders inside the opencodex proxy.
---

Guardrails is an optional data-protection layer built into opencodex. It scans supported text fields
before an LLM request leaves the proxy. In enforcement mode it replaces detected values with
per-turn placeholders such as `<STRIPE_ACCESS_TOKEN_1>` and restores only eligible assistant prose
on the way back to the same client.

Guardrails is disabled by default. It adds no separate server, port, database, dashboard, or
monitoring stack.

:::caution
Guardrails reduces accidental disclosure through supported proxy fields. It is not a general DLP
system, and it cannot prevent a model from inferring or rephrasing information that was otherwise
available to it.
:::

## Enable it from the dashboard

Open **Guardrails** in the opencodex sidebar. The workspace has five bookmarkable sections:

| Section | Hash | Purpose |
| --- | --- | --- |
| Overview | `#guardrails` | Enablement, registry health, counters, top rules/categories, and recent metadata-only activity |
| Rules | `#guardrails/rules` | Search, filter, enable/disable, import/export, and manage custom rules |
| Tester | `#guardrails/tester` | Scan synthetic sample text through this OpenCodex Management API without sending it to an LLM provider or storing it server-side |
| Activity | `#guardrails/activity` | Inspect the bounded in-memory metadata ring |
| Settings | `#guardrails/settings` | Provider coverage, mode, failure policy, data types, and keyword prefilter |

The first switch is an explicit opt-in. The safe initial settings are:

- mode: **Enforce masking**;
- processing failure: **Block request**;
- all current and future providers protected;
- all six data types enabled;
- keyword prefilter off.

Changes apply to newly admitted logical turns. A request or stream that has already started keeps
the immutable settings and placeholder mapping it began with.

### CLI and Management API

This contribution is dashboard and Management API first. The 13 Guardrails endpoints are
documented in the [Management API reference](/reference/management-api/#guardrails), but a
dedicated non-interactive `ocx guardrails` command is intentionally deferred as one complete
follow-up. The existing `ocx gui` command only opens the dashboard and is not presented as a CLI
client for those endpoints.

## Choose the mode and failure policy

Mode and failure policy are separate controls:

| Setting | Behavior |
| --- | --- |
| `enforce` | Masks detected values before upstream I/O and restores issued placeholders only in non-executable assistant text. |
| `detect` | Counts request findings but preserves the baseline wire payload produced by the normal opencodex protocol translation and leaves the provider response unchanged. It does **not** protect data sent to the provider and does not persist the request for Responses continuation replay. |
| `block` | Default failure policy. A scanner, registry, traversal, or capacity failure stops the request before upstream I/O. |
| `passthrough` | Explicit fail-open policy. A Guardrails processing failure may send the original, unmasked request upstream. The dashboard keeps a permanent warning while this policy is selected and records a high-severity metadata event when it is used. |

The selected failure policy applies consistently to Responses, Chat Completions, native and routed
Messages, and `messages/count_tokens`. Block failures stop before upstream I/O; passthrough
failures forward the admitted original request rather than a partially transformed body.

Switching Guardrails off, selecting detect-only mode, or enabling passthrough requires a consequence
confirmation in the dashboard.

## Choose protected providers

An enabled Guardrails policy protects all providers by default. In **Settings**, clear a provider
checkbox to switch to selected-provider mode. Requests routed directly to unchecked providers are
not scanned or masked. This is a security-relevant reduction in coverage, so the dashboard shows a
consequence confirmation and a persistent warning.

The selection uses canonical provider IDs from `config.providers`, not model names, account labels,
or display names. The built-in native Anthropic credential path has the stable ID
`anthropic-native` and can be selected independently from a routed provider named `anthropic`.
That synthetic ID is reserved and cannot also be used as a configured provider name.
Selected-provider mode never auto-enables a newly configured provider; switch back to all-provider
mode if new providers should inherit protection automatically.

Removed provider IDs remain visible as **not configured** so stale intent can be repaired. If a
selected scope contains only removed or disabled configured providers, the dashboard reports
**No providers protected**: scanning may still work in the local Tester, but current provider
traffic is not covered.

Each concrete policy-fallback attempt is evaluated against its provider ID. A combo is unprotected
only when every physical target is unchecked; a mixed combo is conservatively protected as one
logical turn so its fallback attempts cannot mix raw and placeholder state. A protected attempt
keeps one immutable policy, masked request body, and placeholder mapping for its lifetime. A
policy attempt that starts on an unchecked provider is stopped locally if fallback would cross
to a checked provider with raw input. A continuation that
already carries a Guardrails enforce marker cannot resume through an unchecked provider; opencodex
returns HTTP `409 guardrails_policy_changed` before upstream I/O.

## Data types and rules

The built-in registry contains 272 rules. Of those, 266 are pinned donor rules: 46 manually
curated rules from `guardrails-llm-filter` and 220 rules generated from a pinned Gitleaks
configuration. Six additional MIT-licensed OpenCodex rules cover strongly labelled API-key,
password, secret/keyring, private-key, infrastructure-URI assignments, and ASCII email addresses
with punycode domains without modifying the donor assets or their provenance hashes. The scanner
uses RE2 through exact-pinned
`re2-wasm@1.0.2`; it never falls back to JavaScript `RegExp`.
Infrastructure URI detection also accepts a bounded angle-bracket placeholder in the host position.
This lets a repeated scan protect remaining userinfo credentials in partially masked text without
treating an ordinary URI that has no password as a secret.
OpenCodex verifies the stock loader and WASM hashes, then raises the fixed WASM heap to 64 MiB only
in process memory so all reviewed matchers and repeated scans fit without modifying installed
dependency files. The release package gate repeats 300 full-registry scans after a fresh npm
install.

| ID | Data type |
| --- | --- |
| `1` | Credentials |
| `2` | API keys |
| `3` | Access tokens |
| `4` | IP addresses |
| `5` | Personal data |
| `6` | Custom |

The Rules section shows metadata and IDs, not the built-in regex source. You can disable a built-in
rule or add up to 100 local custom rules. A custom rule is declarative and bounded:

- rule ID: `^[a-z0-9_.-]{1,128}$`;
- RE2 pattern: at most 4096 UTF-8 bytes;
- placeholder type: `^[A-Z][A-Z0-9_]{0,63}$`;
- required bounded arrays for `keywords`, `banlist`, `validators`, and
  `masking.captureGroups` (use `[]` when unused), plus a required `groupPriority`.
  `groupPriority` is reserved compatibility metadata and does not currently change rule precedence;
- optional `minLength` and `entropy` constraints. Capture-group numbers are unique ordered
  alternatives: the scanner masks the first non-empty group, not every listed group.

The complete effective registry is validated and compiled before a write is committed. A malformed
rule, conflicting placeholder type, or failed import leaves the prior configuration active.

The keyword prefilter is off by default. When enabled, it skips only built-in rules whose parsed
RE2 expression proves that every possible match contains one of the rule's declared keywords.
Custom rules and built-in rules without that proof always execute, so the optimization preserves
detection recall.

## Test a rule safely

The Tester accepts at most 128 KiB of UTF-8 text. It sends the sample to the Management API of the
OpenCodex instance shown in the dashboard, where the effective registry returns a masked preview
plus metadata-only findings. The sample is never sent to an upstream LLM provider and is not stored
in configuration, request logs, telemetry, or browser storage. In connected mode it can traverse
the configured OpenCodex hub, so use synthetic values and never paste real secrets.

Clearing the Tester cancels an in-flight scan. Reloading the page also discards the input and result.
The custom-rule editor can send its current unsaved rule to the Tester. The draft is included only
in that local simulation request; it is not added to the active registry until **Save rule** succeeds.

Import uses a versioned JSON bundle and requires **Merge** or **Replace**. opencodex performs a dry
run before applying it. Merge adds only new, non-conflicting custom rules and preserves the current
enabled/mode/failure policy, provider scope, data types, built-in toggles, and keyword-prefilter setting. Replace
applies the bundle settings and custom-rule list as a whole and requires a consequence confirmation.
The Replace preview distinguishes rules that will be created or replaced from byte-equivalent rules
that remain unchanged, so its security diff does not overstate the mutation.
Export contains only safe settings and declarative custom rules, never findings, prompt text,
originals, or placeholder maps.

## Covered request and response fields

Guardrails covers the current opencodex LLM surfaces:

- `POST /v1/responses` over JSON, SSE, and the client-facing WebSocket upgrade;
- `POST /v1/chat/completions` over JSON and SSE;
- routed and native `POST /v1/messages` over JSON and Anthropic SSE;
- `POST /v1/messages/count_tokens` request text;
- native and routed `POST /v1/responses/compact`;
- supported text material introduced by local compaction, recovery, web-search, vision, and
  additional upstream rounds.

For Responses history, hosted `web_search_call.action.query` and string entries in
`web_search_call.action.queries` are treated as semantic text and scanned before replay.

Only semantic text leaves understood by the current parser are scanned. Model IDs, URLs, headers,
metadata, JSON Schema definitions, tool definitions, images, audio/video payloads, file IDs,
reasoning/thinking/signatures, genuine ciphertext, and unknown opaque item types are not scanned.
Model-visible `input_file.filename` text is scanned; opaque `input_file.file_id` and file bytes are
not.
For supported structured tool inputs and outputs, Guardrails also uses a bounded property name as
detection context. For example, a string value under an `API_KEY`, `password`, `SECRET_KEYS`, or
`PrivateKey` property can match a contextual rule even when the value has no provider-specific
prefix. Only the original string value is replaced and retained in the per-turn mapping; the
property name is never added to that mapping. Control properties that merely contain words such as
`TOKEN` in a longer mode/enablement name are not treated as secrets by these supplemental rules.
One semantic text leaf is limited to 128 KiB and one logical turn to 2 MiB across leaves. A separate
128 MiB regex-work budget multiplies UTF-8 bytes by the number of rules that actually execute after
keyword prefiltering, so a turn below 2 MiB can still be rejected when many always-scan rules apply.
Exceeding any limit is a whole-request capacity failure, never a partial mask.

Successful client-facing JSON and SSE restore issued placeholders in assistant text. Executable
output stays masked, including function-call arguments, custom-tool input, Anthropic `tool_use`
input, shell/computer actions, and tool-search payloads. This is deliberate: an upstream model must
not be able to turn a placeholder into a locally executable copy of the original secret.

Response restoration is fail-safe and bounded. If a successful response cannot be classified as
JSON or SSE, contains malformed JSON/UTF-8, or exceeds the 32 MiB JSON output limit, opencodex
returns it with placeholders still masked and records a metadata-only demask warning. It never
partially restores an oversized or malformed response.

If a placeholder remains inside a tool call, pass only that placeholder or obtain the value through
an independently authorized secret mechanism. Guardrails does not offer an “unmask tool arguments”
option.

## Debugging with placeholders

Source snippets, configuration, logs, and tool output may contain placeholders such as `<IPV4_1>`,
`<IPV6_1>`, or `<OPENCODEX_URL_WITH_CREDS_1>`. These tokens can be produced by local Guardrails
processing and do not prove that the literal token exists in the source file.

When a placeholder limits debugging:

- do not infer the original value or edit the source merely to replace the token;
- use placeholder identity where possible: the same placeholder refers to the same original value
  within the current mapping;
- continue with visible structure and safe derived properties such as address family,
  loopback/private/public classification, or subnet membership;
- if the exact value is required, temporarily disable only the relevant data type or built-in rule,
  such as `ip-addrs.*`, for an isolated check, then enable it again;
- do not switch to `detect` or `passthrough`, or disable credential rules, solely to simplify
  debugging. Detect mode sends the original text upstream, and passthrough may fail open.

See [Proxy API Formats](/reference/proxy-formats/) for protocol-specific framing.

## Continuations and compacted history

The reversible mapping exists only in process memory and is bounded by time, entry count, and bytes.
Responses continuation inheritance requires all three:

- a valid `previous_response_id`; and
- the same non-empty continuation lane derived from `x-codex-parent-thread-id`, `thread-id`, or
  `session_id`/`session-id` (a parent and a more specific child/session ID are paired when both
  are present); and
- the same admission identity: configured-key ID, process-wide environment credential identity, or
  trusted loopback admission.

An unscoped or cross-thread request cannot retrieve originals. Mappings expire in at most one hour,
and chain activity does not extend the original absolute expiry. A proxy restart, expiry, or memory
eviction removes the mapping; an unknown placeholder then stays a placeholder.
Configured keys are isolated from one another. Environment admission is intentionally one
process-wide identity, while loopback admission relies on the proxy's local-process trust boundary;
neither form makes a mapping available to another thread.

Compact responses intentionally remain masked machine state. opencodex associates the exact returned
compact artifact with a thread-scoped fingerprint in memory so the next request can inherit the same
mapping without writing originals into the artifact or to disk.

An enforced Responses continuation can resume after the enforce registry or settings change. It
keeps previously issued mappings until their original expiry and scans new values with the current
enforce registry. Switching that continuation to detect or disabled returns HTTP `409` with code
`guardrails_policy_changed`; start a new session before weakening the policy.

## Activity and privacy boundary

Overview and Activity use a bounded, one-hour, in-memory metadata ring. It contains only:

- timestamp, protocol surface, mode, result, and registry generation;
- counts, data-type/rule IDs, aggregate latency, and severity;
- retention size and eviction counts.

It never stores request/response text, masked text, originals, placeholder mappings, headers,
credentials, or Tester input. It is operational feedback, not a durable audit log. Request logging
and usage diagnostics also remain on the masked side of the client-facing restore boundary for an
enforced turn.

The Responses state snapshot and spill store contain masked canonical state plus, when needed, only
the safe marker `{ "enforced": true, "policyRevision": "…" }`. Originals and mappings are never
written there. Guardrails makes no extra disk-privacy claim for traffic processed while the feature
is disabled.

## Configuration example

```json
{
  "guardrails": {
    "enabled": true,
    "mode": "enforce",
    "failurePolicy": "block",
    "providerScope": { "mode": "all" },
    "enabledDataTypes": [1, 2, 3, 4, 5, 6],
    "disabledBuiltinRuleIds": [],
    "customRules": [],
    "keywordPrefilterEnabled": false
  }
}
```

Prefer the dashboard or scoped Management API so the effective registry is validated before the
write commits. A malformed optional `guardrails` section found during startup is ignored with a
warning when it was not explicitly enabled. If the malformed section contains `enabled: true`,
opencodex preserves the opt-in and falls back to the built-in `enforce`/`block` policy. Unrelated
provider/account configuration is preserved in both cases.

See [Configuration](/reference/configuration/#guardrails-sensitive-data-placeholders) and the
[Management API](/reference/management-api/#guardrails) for field and endpoint details.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| A known placeholder remains after restart or a long pause | The in-memory mapping is unavailable. Resend full text in a new turn rather than trying another thread's mapping. |
| HTTP `409 guardrails_policy_changed` | Start a new session after changing from enforce to detect/off or routing a protected continuation through an unchecked provider. |
| A rule or import is rejected | Fix the reported RE2/schema conflict; the previous active registry is still in use. |
| A request is blocked with `guardrails_capacity_exceeded` | Reduce the semantic text/findings or split the work. Do not switch to passthrough unless unmasked fail-open behavior is acceptable. |
| A tool call contains a placeholder | Expected security behavior. Executable fields are never restored. |
| Activity is empty after restart | Activity is an in-memory operational view, not an audit log. |
