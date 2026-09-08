# Prepare and verify combined protocol candidate

Reverify base/source heads before build. Carry exact source deltas from the scratch diff snapshots, fold independently confirmed review fixes only. Each commit contains verified contributor trailers. Do not include upstream planning notes or unrelated changes.

Layer 1 MODIFY:
scripts/test-layout/layout.json
src/claude/inbound.ts
src/claude/outbound.ts
src/responses/reasoning-envelope.ts
tests/claude-integration/claude-code-thought-signature-scope.test.ts
tests/claude-integration/claude-inbound.test.ts
tests/claude-integration/claude-outbound.test.ts
tests/claude-integration/claude-source-envelope.test.ts
tests/fixtures/test-layout-expected.json
tests/responses/reasoning-envelope.test.ts

Preserve genuine signatures; encode bounded unsigned/redacted fallback; keep structured tool results. Layer 2 NEW src/server/grok-responses-control-frame.ts and MODIFY:
src/server/grok-responses-control-frame.ts
src/server/responses/core.ts
tests/responses/responses-snapshot-repair-server.test.ts

Separate strict-client filtering from internal inspection. On a Grok metadata frame, forward no incompatible client frame; on ordinary delta, preserve unchanged; ordinary clients remain unchanged. No shared account/routing changes.

Potential follow-up tests belong only in existing responses/Claude test files after diagnosis, with independent expected values. If no valid unhandled #3807 input is established, leave production guards unchanged. #3719 cache-hit and true Anthropic signed replay cannot be certified by codec fixtures.

SoT: update docs-site/src/content/docs/guides/claude-code.md and existing translated counterparts only if #3815 makes their drop-policy statements stale. Read docs-site/AGENTS.md first. No global retention change.

Verification: user prohibits local suites/typecheck (NOT RUN). Inspect source and diff-check locally. Push task branches with --no-verify. Dispatch existing Cross-platform CI workflow on final combined head, lane all. Confirm workflow head SHA, jobs, conclusion, test/typecheck execution from logs. Final CI failure permits lower-layer CI. Keep workflow/protection configuration unchanged; suppress only task-owned redundant automatic runs when needed for requested top-first scheduling, reporting cancelled runs honestly. No real accounts are used.

## Audit amendments

New rs_ reasoning IDs are normal transport identity, not fabricated tool call pairing. Do not synthesize tool-call IDs to bypass #3807 validation.

Before acceptance, remove unbounded thinkingBuf retention introduced by #3815 or charge it to the existing TranslatorBudget retained bytes with normal fail-closed overflow. Use the established budget and error event; no silent truncation or new policy default. Cover multi-part text exactness, empty continuity fallback, and overflow with a small injected existing budget in remote regression tests. Decoder/consumer traces must prove any compact continuity marker still replays the original summary.

#3816 must use SSE last-event-field-wins semantics, including colonless/empty resets and removal of only one optional leading space. Test event-only, data-only, repeated event fields in both orders, and preservation of ordinary completion data. Keep downstream Grok WebSocket support deferred because the existing surface marker is absent there; do not claim this HTTP/SSE patch solves it.

## WP1 source refresh and scoped hardening

Previous D: roadmap locked; execute reviewed source preparation. PR #3815 advanced to 76e07d181c48dca8c80167878381e1edb5642395 during investigation, including budget fixes and translated guide changes; carry fresh source, not old snapshots. Add a third dependent hardening layer only for source-proven preservation faults. MODIFY src/responses/parser.ts: retain recognized redacted-only and empty signed envelopes even when text is empty, preserving real boundary grouping. MODIFY src/bridge.ts: preserve signed block boundaries and redacted block positions identically in streaming/buffered output; signature fragments must be assembled at owning adapter boundary. MODIFY src/claude/outbound.ts only for exact block order/text restoration where current contract permits; do not invent a new signed continuity carrier or change hide-thinking policy. If hidden signed replay needs a new policy/carrier, explicitly defer that part rather than widening scope. Existing budget/guard contracts remain.

Tests: existing tests/responses/anthropic-thinking-signature.test.ts or matching current domain file and Claude envelope tests get exact block-array roundtrip oracles; no fixture claims a live genuine signature. tests/responses/responses-compaction-routing.test.ts gets an established-history complete send_message_to_thread envelope across normal response, stored-ID continuation, v2 compaction_trigger and v1 compact endpoint, preserving real pairing and task content. If current fixture support makes a case impractical, record exact gap; no runtime seed repair.
