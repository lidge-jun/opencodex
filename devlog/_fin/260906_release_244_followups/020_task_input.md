# External Codex task-input envelopes

Depends on policy; class C4 for protocol admission. Fix public issue #3735, observed on baseline dev. Preserve the existing unpaired-tool HTTP 400 guard from #3471.

## Diff-level change map

- MODIFY src/responses/parser.ts at function_call_output classification before tool lookup: route only a complete external task-input envelope to an Ocx user message. Eligibility: type function_call_output, no call_id property (including inherited properties for direct helper calls), nonempty string id/name/namespace, nonempty fully representable text/image output. Do not require specific names, prefixes, namespaces or XML content. Existing standard tool results and custom_tool_call_output keep current path.
- NEW src/responses/task-input.ts: pure recognition returning supported Ocx user content or undefined, no request mutation/network/storage. Reuse existing content converters only when they preserve every accepted output part and reject invalid mixed arrays rather than silently drop them.
- MODIFY tests/responses/responses-parser.test.ts, tests/responses/responses-compaction-routing.test.ts and tests/responses/openai-responses-passthrough.test.ts with narrow positive/negative fixtures. No new test file or layout registry entry is needed.
- MODIFY docs-site/src/content/docs/reference/adapters.md and docs-site/src/content/docs/guides/sub-agent-surface.md and structure/04_transports-and-sidecars.md: describe external task input as user-supplied task coordination, not fabricated tool completion. Keep passthrough/compaction raw-body contracts.

Before: result-shaped external task input enters toolResult branch with undefined call id, then translated-adapter guard returns 400. After: the complete external shape enters user message with intact supported text/images; malformed/orphan tool results still fail. No secret or raw logged transcript is copied to tests.

## Activation / verifier

Remote parser tests exercise arbitrary tool names/namespaces, blank/empty content remains ineligible, multiple ordered text parts and supported images; retain exact content without orphan marker. Explicit call_id empty/null/number/undefined-own-property remain invalid, as do custom outputs missing identity, partial provenance, unsupported/mixed malformed arrays. Existing genuine call ids remain tool results. Remote endpoint/compaction/passthrough fixtures prove unchanged raw body forwarding and guard failures. ci.yml runtime jobs + typecheck/privacy establish fresh proof. Local saved log provides provenance only; no live Kiro request.

## Boundary / alternatives

No-op leaves current task creation unusable; configuration cannot distinguish this parser envelope; generic orphan-to-user repair would reverse #3471 and is rejected. Reuse current message types; no persisted schema fields. Classification is compatibility handling, not authentication: no privilege is granted by envelope metadata.


## Source follow-up folded at roadmap lock

Author yrlan-montagnier (Yrlan), GitHub id 71253160: preserve Co-authored-by: Yrlan <71253160+yrlan-montagnier@users.noreply.github.com>. Posted helper may manufacture an encrypted-content-omitted marker that makes encrypted-only input look usable; reject encrypted-only and mixed opaque/unsupported input, never use placeholder text as eligibility. Keep every pre-existing #3471 regression, adding tests rather than replacing them. Add tests/responses/responses-compaction-routing.test.ts and tests/responses/openai-responses-passthrough.test.ts to explicit remote verification. Prefer a dedicated small predicate over relocating passthrough helpers unless byte-for-byte behavior is proved.

## Task-input cycle P refresh at 25c8d2b4e

The preceding D landed policy #3739 and actual Maintain/Admin settings. Issue #3735 is still open and the author has no open PR; retain the account-linked Yrlan trailer. Source parser at lines 150-160 currently recognizes only message/agent_message as the continuation conversation boundary. Compute the optional external content once near effectiveType and include a recognized envelope in that existing boundary predicate. In the function_call_output branch, clear pendingReasoning, emit a user message and continue; leave the ordinary result branch and core guard unchanged.

Concrete new leaf: src/responses/task-input.ts exports externalTaskInputContent(item: unknown): string | OcxContentPart[] | undefined. It imports only type OcxContentPart and existing isObj/inputContentParts. Require exact function_call_output, no call_id property, nonblank id/name/namespace, and a nonblank string or fully supported array. Array parts are input_text/text/output_text with string text or input_image with nonblank string image_url and optional auto/low/high/original detail. Normalize output_text to input_text before calling the existing input converter; original image detail maps to high by that converter. Require at least one nonblank text or usable image. Reject any unsupported/opaque/malformed member, invalid detail or file-id-only reference as a whole; placeholder text never establishes eligibility. Preserve accepted text bytes, order and image references; no raw-body mutation or helper relocation from passthrough.

Field chain: external JSON shape -> pure leaf validation -> parser user message + existing `_continuationConversationMessageIndex` -> translated adapter's existing user-content serialization. No new persisted field/schema/config. Passthrough and compact use unchanged raw body. Tests include pending reasoning reset and previous_response_id boundary index=0 for a new envelope without a replay prefix, alongside all old #3471 controls.

Dispatch: main owns new leaf, parser, endpoint/passthrough regressions and English/structure docs; a bounded worker owns only tests/responses/responses-parser.test.ts. Independent A/C reviewer reads named leaf/parser boundaries. No local tests/typecheck/build; remote ci.yml runtime/gates and existing parser/compaction/passthrough suites provide proof. Parser leaves add no core/Lab dependency. No-op/configuration cannot fix this shape; existing input converter is reused behind strict validation.
