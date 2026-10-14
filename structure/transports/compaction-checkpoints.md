# Compaction Checkpoints On Later Turns

After a compaction, Codex's replacement history is its recent user requests followed by one user
message that starts with `SUMMARY_PREFIX` from `src/responses/compaction.ts`; routed remote
compaction v1 returns the same shape through `buildCompactV1Output`. Decoded `ocx1:` items follow
the [decoded checkpoint continuation](responses.md#decoded-checkpoint-continuation) contract.

## Retained requests before a plaintext checkpoint

With opt-in `compactionDropRetainedRequests`, `src/server/responses/request-prepare.ts` passes the
raw request input through `src/responses/compaction-retained-requests.ts` before parsing, so
translated adapters and the native passthrough see the same input. Plain-text user messages in
front of the latest user message starting with `SUMMARY_PREFIX` are removed.

- Kept: the checkpoint, earlier checkpoints, contextual wrappers (`<...>`, `# AGENTS.md`,
  `# Context from my IDE`), user messages with non-text parts, assistant and tool items, and
  everything after the checkpoint.
- Unchanged: inputs carrying `compaction_trigger`, inputs whose only checkpoint is an opaque native
  blob or a decoded `ocx1:` item, and every request while the option is absent or `false`.
- A replayed `previous_response_id` prefix shrinks by the removed items it contained
  (`shrinkPreviousResponseReplayPrefix` in `src/responses/state.ts`). The continuation cache stores
  `_rawBody`, so it records the shortened input until Codex next sends the full history.
- Codex's stored thread is never modified; the removal is request-local.

`tests/responses/compaction-retained-requests.test.ts` establishes the selection rules and the
outbound wire on a Responses passthrough and a translated Chat route with the option on, off and
absent. It does not establish model behavior.

> Decision record: [ADR-7105](../decisions/ADR-7105-retained-requests-before-checkpoint.md)
