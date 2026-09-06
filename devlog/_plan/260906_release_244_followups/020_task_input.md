# External Codex task-input envelopes

Depends on policy; class C3. Fix public issue #3735, observed on baseline dev. Preserve the existing unpaired-tool HTTP 400 guard from #3471.

## Diff-level change map
- MODIFY src/responses/parser.ts at function_call_output classification before tool lookup: route only a complete external task-input envelope to an Ocx user message. Eligibility: type function_call_output, no call_id property (including inherited properties for direct parser calls), nonempty string id/name/namespace, nonempty fully representable text/image output. Do not require specific names, prefixes, namespaces or XML content. Existing standard tool results and custom_tool_call_output keep current path.
- NEW small src/responses/task-input.ts only if predicate/content conversion would make parser more complex: pure recognition returning supported Ocx user content or undefined, no request mutation/network/storage. Reuse existing content converters only when they preserve every accepted output part and reject invalid mixed arrays rather than silently drop them.
- MODIFY tests/responses/responses-parser.test.ts and/or existing malformed-content/parser-agent-message file: narrow positive and negative fixtures. If new test file necessary, MODIFY scripts/test-layout/layout.json and tests/fixtures/test-layout-expected.json.
- MODIFY docs-site/src/content/docs/reference/adapters.md and docs-site/src/content/docs/guides/sub-agent-surface.md and structure/04_transports-and-sidecars.md: describe external task input as user-supplied task coordination, not fabricated tool completion. Keep passthrough/compaction raw-body contracts.

Before: result-shaped external task input enters toolResult branch with undefined call id, then translated-adapter guard returns 400. After: the complete external shape enters user message with intact supported text/images; malformed/orphan tool results still fail. No secret or raw logged transcript is copied to tests.

## Activation / verifier
Remote parser tests exercise arbitrary tool names/namespaces, blank/empty content remains ineligible, multiple ordered text parts and supported images; retain exact content without orphan marker. Explicit call_id empty/null/number/undefined-own-property remain invalid, as do custom outputs missing identity, partial provenance, unsupported/mixed malformed arrays. Existing genuine call ids remain tool results. Remote endpoint/compaction/passthrough fixtures prove unchanged raw body forwarding and guard failures. ci.yml runtime jobs + typecheck/privacy establish fresh proof. Local saved log provides provenance only; no live Kiro request.

## Boundary / alternatives
No-op leaves current task creation unusable; configuration cannot distinguish this parser envelope; generic orphan-to-user repair would reverse #3471 and is rejected. Reuse current message types; no persisted schema fields. Classification is compatibility handling, not authentication: no privilege is granted by envelope metadata.


## Source follow-up folded at roadmap lock
Author yrlan-montagnier (Yrlan), GitHub id 71253160: preserve Co-authored-by: Yrlan <71253160+yrlan-montagnier@users.noreply.github.com>. Posted helper may manufacture an encrypted-content-omitted marker that makes encrypted-only input look usable; reject encrypted-only and mixed opaque/unsupported input, never use placeholder text as eligibility. Keep every pre-existing #3471 regression, adding tests rather than replacing them. Add tests/responses/responses-compaction-routing.test.ts and tests/responses/openai-responses-passthrough.test.ts to explicit remote verification. Prefer a dedicated small predicate over relocating passthrough helpers unless byte-for-byte behavior is proved.
