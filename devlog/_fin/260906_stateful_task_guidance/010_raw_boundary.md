# Align the stateful raw conversation boundary

## Exact diff map

- MODIFY src/server/responses/collaboration.ts: import the existing pure
  externalTaskInputContent helper. In isConversationalItem, recognize a complete
  external task envelope with helper(item) !== undefined, alongside existing
  agent_message and user/assistant message handling. Do not duplicate its shape
  validator or alter statefulRawInsertionIndex's replay-prefix/fallback logic.
- MODIFY tests/codex-integration/multi-agent-compat.test.ts near injectDeveloperMessage:
  stateful external envelope alone and after a leading ordinary call result must
  receive guidance before the external task in both parsed context and raw input.
  Reparse the stored raw body and compare role/content order. Add an expanded
  replay-prefix case so historical external inputs are not selected as the new
  boundary. Keep ordinary stateful protocol, compaction and guidance-dedup tests.
- MODIFY docs-site/src/content/docs/guides/sub-agent-surface.md and
  structure/04_transports-and-sidecars.md: distinguish unchanged payload content
  from intentional generated-guidance placement; both representations use the
  same complete-envelope boundary during stateful injection.

Before: parsed [developer, user] while raw [external-envelope, developer].
After: parsed [developer, user], raw [developer, external-envelope], and reparsed
role/content order agrees. Leading protocol results remain before guidance;
historical replay-prefix items remain in place.

## Activation and boundary proof

The new predicate executes only when stateful guidance inspects raw input. Tests
set previous_response_id, invoke the real injector and assert raw/parsed/reparsed
arrays. Ordinary tool outputs with call_id remain protocol items because the
shared helper rejects them. Invalid/partial/opaque envelopes retain their current
classification; the complete validator is already covered by parent regressions.

No persisted schema, configuration or role changes. Existing input shape -> shared
validation -> raw insertion index -> stored raw input -> later parser is the full
data flow. The helper remains pure and adds no optional subsystem dependency.
Review uses the actual diff; all runtime checks execute in GitHub Actions.

## An audit amendment

Use the parse-time previous_response_id pattern from multi-agent-compat.test.ts:1075-1089 for envelope-alone and leading-result cases. The raw body must contain that field before parseRequest and retain it during reparse; do not copy the post-hoc parsed.previousResponseId assignment fixture at 1029. For historical-prefix coverage use the 1043-1072 pattern with explicit `_replayPrefixLen` and `_continuationConversationMessageIndex`, and put an old external envelope inside that preserved prefix. Assert parsed boundary before injection as well as raw/parsed/reparsed ordering. This closes the auditor's false-green fixture concern.
