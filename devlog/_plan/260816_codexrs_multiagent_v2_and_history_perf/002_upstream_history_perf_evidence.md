# Lane B — upstream conversation-history performance rework

Research target: `openai/codex` checkout at `9dd22890f5ff47e4af128c20e32b9758a61d78d2` (2026-08-16 checkout state).  
Planning target: OPENCODEX checkout at `7612e4c4f81544a250c3eea9fe8ca85d8022e765`.

## Executive reconstruction

This was not one provider-API optimization. It was a local history-stack redesign with three related layers:

1. Rollout JSONL remained the durable source, but paginated rollouts gained monotonically increasing `ordinal` values, canonical turn lifecycle records, and `SessionMeta.history_mode = "paginated"`.
2. A separate SQLite projection (`thread_history_1.sqlite`) materializes turns/items and supports bounded turn/item pages. App-server and TUI callers can request only the page they need instead of hydrating an entire transcript.
3. The largest directly provable request-count reduction is commit `332eac4b858a40575a55f21026ecf8cb662e539c`, which removed an N+1 SQLite query in summary paging: the old code issued one item query for each returned turn; the new query joins the first user and final agent item into the turn-page query.

The supplied `27.6s -> 1.7s` and “~98% fewer requests” benchmark numbers do not appear in the reachable commit messages, source comments, or tests. They are therefore **UNVERIFIED as benchmark measurements**. The mechanism and approximate percentage are independently reproducible from code: for 741 turns with the app-server maximum of 100 turns/page, the dominant SQL count falls from about `8 page queries + 741 per-turn summary queries = 749` to about `8 joined page queries`, a `98.93%` reduction. These are local SQLite requests, not `/v1/responses` provider requests.

## Commit ledger

All requested abbreviated anchors resolve to these exact commits in the upstream checkout:

| Commit | Date | Verified subject | Role |
|---|---:|---|---|
| `99915080b6ce1d7c0788edc72f116455bd77fcd6` | 2026-08-11 | Store model history in response item envelopes (#38045) | Introduces the in-memory envelope; initially it contains only `item`. |
| `63002bdb26c939925f3fa59b9575cc0a3564cb45` | 2026-08-10 | Extract persisted history types into a dedicated crate (#37871) | Moves persisted rollout types from `protocol` to `codex-history`. |
| `4bb7ee3472830bda4d58996e4ff0106e7bef0f3f` | 2026-08-07 | Add rollout migration tooling and background migration (#37348) | Manual CLI, startup migration, journal/recovery path. |
| `6bb6e9045f728f172ee1c68e6dc56ce6a53cbdb8` | 2026-08-05 | Add legacy rollout migration to paginated history (#37175) | Canonical legacy-to-paginated conversion and one-way state promotion. |
| `aac9f842473ac6a05d417dd76ce8b89bdb3b707d` | 2026-08-06 | Preserve legacy semantics during rollout migration (#37191) | Preserves rollback/subagent/compaction semantics during canonicalization. |
| `e87e2b495bcf8aa1950e2bb24cc95bfdc6fd473a` | 2026-08-04 | Support includeTurns reads for paginated threads (#36993) | Makes `thread/read(includeTurns:true)` hydrate paginated turns. |
| `449f099f1cad470fa4f63dcc198f8d6cb8944cde` | 2026-08-04 | Harden paginated history handling in the TUI (#36951) | Bounded TUI history paging/fallback hardening. |
| `4496ba3fd5645af57779fc6a468c270a0b23cfb7` | 2026-08-11 | Use session metadata to validate thread history paths (#38033) | Validates a rollout path by its first `SessionMeta.id`. |
| `ed390a5dc4b5e859ca7411ea5a81cd96470fb748` | 2026-08-11 | Filter live rollout items in place (#38034) | Allocation reduction in live-item filtering; no wire/schema change. |
| `4ef836f883c38ba6d39e6920f335ce6452b7de33` | 2026-08-12 | Distinguish rollout IDs from thread IDs (#38127) | Allows multiple rollout IDs/files for one thread ID. |
| `3a6f747d77d770c74203e051abeccc66d4a06d3b` | 2026-08-11 | Preserve harness metadata across conversation history (#38058) | Adds persisted optional metadata beside response payloads. |
| `d6ca19d99b8188062795315850aed34d25c8f037` | 2026-08-11 | Add turn-aware response item injection (#38047) | Makes injection persistence/flush turn-aware. |
| `c2bcb9a26b5bdbdc66c48cf3bc3bb382568e800c` | 2026-08-07 | Reuse parent compactions in Guardian review sessions (#37513) | Seeds Guardian review history from parent compaction. |
| `bd5b55e403e867f957e371840377cd284023f98c` | 2026-07-22 | Track compaction time in turn profiles (#34835) | Adds local turn-profile timing. |
| `b9ba969f3996cc73b6c8129bbc1606caad2192a9` | 2026-08-04 | Enable remote compaction for Amazon Bedrock (#36981) | Makes `/v1/responses/compact` provider-visible for Bedrock. |
| `4bd5b9fd0933c4399351bd59364a96a8fb99cd33` | 2026-08-04 | Keep image resize notices attached during remote compaction (#36956) | Changes compact-request `input` retention, not its schema. |

Additional causal commits not in the supplied anchor list:

| Commit | Verified subject | Why it matters |
|---|---|---|
| `5267e805fb830891c0b23376bcd9cbd382c3473c` | feat(app-server): add history_mode to thread (#29927) | Establishes the compatibility floor: metadata discovery remains available, unsupported full-history operations fail closed. |
| `332eac4b858a40575a55f21026ecf8cb662e539c` | Load turn summaries with paginated queries (#36384) | Direct N+1 SQL removal behind the request-count reduction. |
| `8bfa49e350edb065889332c72854d06f0e7ce50f` | Paginate transcript history in TUI | Starts bounded TUI transcript loading. |
| `3b8d22ec2c75bf8fcd6048c34039344795ff7a0a` | Improve paginated TUI history loading | Continues the incremental-loading path. |
| `dbcd837c20cd891f3de4bb3976c7f643d0b2fb93` | Paginate TUI transcript history | Establishes the paged transcript flow later hardened by `449f099f1`. |

## 1. Old and new rollout/history formats

### Ownership and serde types

At `63002bdb2`, persisted history types move out of `codex-rs/protocol/src/protocol.rs` into the dedicated `codex-rs/history` crate. At current HEAD:

- `codex-rs/history/src/lib.rs:36` (`ResponseItemEnvelope`) owns model-history envelopes.
- `codex-rs/history/src/lib.rs:46` (`CodexHarnessMetadata`) owns harness-only metadata.
- `codex-rs/history/src/lib.rs:91` (`RolloutItem`) owns persisted rollout variants.
- `codex-rs/history/src/lib.rs:137` (`CompactedItem`) owns compacted replacement history.
- `codex-rs/history/src/lib.rs:195` (`RolloutLine`) owns each JSONL record: `timestamp`, optional `ordinal`, and flattened `item`.
- `codex-rs/history/src/rollout_payload.rs:20` (`RolloutItemWire`) is the serde-facing tagged wire representation.
- `codex-rs/history/src/rollout_payload.rs:117` (`CompactedItemWire`) provides the compatibility sidecar for replacement-history metadata.

The important distinction is that “new history” is two things, not one replacement file:

- JSONL remains authoritative durable storage.
- `codex-rs/state/thread_history_migrations/0001_thread_history.sql:1` projects it into `thread_turns`, `thread_items`, and `thread_history_projection_state`, whose checkpoint is `(next_rollout_byte_offset, next_rollout_ordinal)`.
- The projection database filename is `thread_history_1.sqlite` (`codex-rs/state/src/sqlite.rs:34`, `SqliteDb::for_thread_history` at line 158).

### Concrete JSONL shape

An old/legacy rollout response item has no ordinal. Removing only whitespace, this is a complete valid legacy line:

```json
{"timestamp":"2025-01-03T12:00:00.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}
```

A paginated line has an explicit ordinal. This exact shape is asserted by `codex-rs/history/src/tests.rs:39` (`response_item_rollout_line_preserves_shape`):

```json
{"timestamp":"2025-01-03T12:00:00.000Z","ordinal":7,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}
```

Migration does more than add a number. `codex-rs/thread-store/src/local/rollout_migration/canonicalizer.rs:81` (`write_head_session_meta`) rewrites the head metadata as paginated, clears `history_base` and the subagent boundary after canonicalizing inherited history, and `write_item` at line 458 serializes every output line with `ordinal: Some(next_ordinal)`. Migration tests at `codex-rs/thread-store/src/local/rollout_migration_tests.rs:287` verify a paginated first `SessionMeta`, contiguous ordinals, and SQLite materialization.

The new state is marked by `SessionMeta.history_mode`, whose enum is `Legacy` (serde default) or `Paginated` at `codex-rs/protocol/src/protocol.rs:700` (`ThreadHistoryMode`). It is not a replacement for `RolloutLine.ordinal`: both are part of the contract.

## 2. The response item envelope

Current in-memory fields (`codex-rs/history/src/lib.rs:36`, `ResponseItemEnvelope`) are:

```rust
pub struct ResponseItemEnvelope {
    pub item: ResponseItem,
    pub metadata: Option<CodexHarnessMetadata>,
}
```

`CodexHarnessMetadata` is currently a closed, empty struct (`codex-rs/history/src/lib.rs:46`). The envelope intentionally separates context consumed by Codex/harnesses from the `ResponseItem` sent to a model.

Chronology matters:

- `99915080b` introduced an in-memory envelope containing only `item`; it did **not** itself change the persisted `response_item` JSON shape.
- `3a6f747d7` added optional envelope metadata and persisted it as a sibling of `payload`, while preserving the old payload shape.

Exact metadata-bearing wire shape, asserted at `codex-rs/history/src/tests.rs:66` (`response_item_envelope_stores_metadata_beside_rollout_payload`):

```json
{"timestamp":"2025-01-03T12:00:00.000Z","ordinal":7,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]},"metadata":{}}
```

There is no envelope `version` field. Compatibility/version markers live around it:

- `SessionMeta.history_mode`: legacy vs paginated file semantics.
- `RolloutLine.ordinal`: projection order/checkpoint contract.
- Startup migration ID `legacy_to_paginated_v1` (`codex-rs/thread-store/src/local/rollout_migration/startup.rs:33`).
- Pending migration journal under `$CODEX_HOME/rollout-migrations/<thread-id>.pending`.
- SQLite migration/projection tables, including `rollout_migration_state` and `rollout_migration_skips` from `codex-rs/state/migrations/0047_rollout_migration_state.sql:1`.

For compacted histories, current `CompactedItemWire` stores `replacement_history` as raw response items and optional aligned `replacement_history_metadata` as a sibling sidecar. `TryFrom<CompactedItemWire>` at `codex-rs/history/src/rollout_payload.rs:170` accepts a missing legacy sidecar and rejects a mismatched sidecar length. Tests at `codex-rs/history/src/tests.rs:137` (`response_item_replacement_history_preserves_shape`) and line 166 (`compacted_replacement_history_stores_metadata_in_an_aligned_sidecar`) cover both shapes.

Unknown fields inside current empty metadata are ignored on read (`codex-rs/history/src/tests.rs:100`, `response_item_envelope_ignores_unknown_harness_metadata_fields`). The inverse claim—every arbitrarily old binary safely reading every future metadata extension—is **UNVERIFIED**; it depends on that binary's serde policy and predates this contract.

## 3. Migration, publication, and compatibility

### Background versus on-read

Legacy-to-paginated conversion is not an on-read mutation.

- Manual entry point: `codex migrate-rollouts`; arguments include `--apply`, `--thread`, `--max-mib-per-second`, `--json`, and `--verbose` (`codex-rs/cli/src/migrate_rollouts.rs:20`). It is dry-run unless `--apply` is supplied.
- Background entry point: `4bb7ee347` adds startup migration behind `BackgroundPaginatedRolloutMigration`; `codex-rs/core/src/thread_manager.rs:388` checks it and spawns migration at line 399. Current feature metadata marks it under development and disabled by default (`codex-rs/features/src/lib.rs:962`).
- Startup traversal: `codex-rs/thread-store/src/local/rollout_migration/startup.rs:51` reads migration cursor/skips/pending state, scans the startup window, applies eligible files, and advances the pre-scan cursor. `CURSOR_LOOKBACK_SECONDS` at line 36 sets the lookback to 48 hours.
- Read-time work only materializes or advances the SQLite projection for a rollout already marked paginated (`codex-rs/thread-store/src/local/thread_history_materialization.rs:19`, `materialize_to_sqlite`). It does not silently convert a legacy rollout.

### Where migration writes

`codex-rs/thread-store/src/local/rollout_migration.rs:321` (`migrate_rollout_path`) and line 467 (`migrate_one_rollout`) implement this publication sequence:

1. Read/validate `SessionMeta` and current mode.
2. Record a pending journal in `$CODEX_HOME/rollout-migrations/`.
3. Canonicalize into a sibling staging file named `.<rollout filename>.paginated.tmp`.
4. Build and verify the `thread_history_1.sqlite` projection.
5. Re-stat the legacy source. If length or modification time changed, abort with a conflict rather than replacing the newer source (`migrate_one_rollout`, lines 603–613).
6. Atomically rename the staged paginated rollout over the source (lines 616–629), then finalize the journal.

Journal recovery can reconstruct a missing projection from a rollout that was published before a crash; `codex-rs/thread-store/src/local/rollout_migration_tests.rs:1828` exercises that case. The JSONL file remains the durable recovery source.

`aac9f8424` adds rollback plans/replay and preserves legacy compaction, fork/history-base, subagent, and rollback semantics while canonicalizing. `6bb6e9045` deliberately treats promotion as one-way in SQLite so stale legacy metadata cannot downgrade an already paginated thread.

### Forward/backward compatibility matrix

| Writer / file | Reader | Verified behavior |
|---|---|---|
| Older Codex writes a legacy file; newer Codex reads it | Newer | `history_mode` defaults to `Legacy`; normal legacy replay remains available. Manual/background migration may later promote it. |
| Older Codex appends while newer Codex is migrating | Newer migrator | New writers use locks; an older writer does not. The final source length/mtime recheck detects an observed change and aborts publication, preserving the legacy file. Safety against a write in the narrow interval after the final stat and before rename is **UNVERIFIED** from the inspected code. |
| Newer Codex reads paginated JSONL with absent/stale SQLite projection | Newer | Materialization resumes from `thread_history_projection_state`; pending-journal recovery can rebuild after interrupted publication. |
| History-aware older release sees a newer paginated thread | Compatibility-floor releases | Foundational commit `5267e805fb830891c0b23376bcd9cbd382c3473c` records fail-closed behavior: metadata-only list/read remains possible, while full history read/resume/mutation is rejected when the release cannot honor the history mode. |
| Pre-`history_mode` binary reads paginated JSONL | Truly old | **UNVERIFIED / unsupported.** Ignoring unknown `ordinal` or `metadata` does not prove it understands canonical `ItemCompleted` events, inheritance collapse, or rollout IDs. |
| Newer writer adds sibling `metadata`; immediately older envelope-aware reader reads it | Older | Payload shape is deliberately preserved by `3a6f747d7`; serde readers that ignore unknown sibling fields remain compatible. Universal compatibility with all old binaries is **UNVERIFIED**. |
| Newer Codex writes paginated; older Codex writes a separate legacy rollout for the same thread | Newer | `4ef836f88` separates rollout identity from thread identity, and the state DB's selected `rollout_path` is authoritative. Startup scanning can consider the new legacy file; no last-file-wins guarantee should be inferred from filename alone. |

Rollout filenames now encode this distinction through `codex-rs/rollout/src/rollout_file_name.rs:1` (`RolloutFileName`): ordinary rollouts can use the thread ID, while reverted/alternate rollouts carry a distinct rollout ID. Code must not parse a filename suffix and assume it is always the thread ID.

## 4. Paginated thread history and `includeTurns`

The app-server protocol is camelCase on the wire.

### Existing read with optional full hydration

`codex-rs/app-server-protocol/src/protocol/v2/thread.rs:1487` (`ThreadReadParams`) and line 1497 (`ThreadReadResponse`):

```text
thread/read params:    { threadId, includeTurns? }
thread/read response:  { thread }
```

`e87e2b495` makes `includeTurns: true` work for paginated stored and loaded threads. The compatibility implementation is intentionally expensive: `codex-rs/app-server/src/request_processors/thread_processor.rs:2806` (`paginated_thread_full_turns`) hydrates all projected turns. It should not be confused with bounded pagination.

`Thread` exposes experimental `historyMode` at `codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs:222` and `turns` in the same `Thread` struct; turns are populated only for operations that explicitly need them (resume/rollback/fork or read with `includeTurns`).

### New bounded methods

Registration is in `codex-rs/app-server-protocol/src/protocol/common.rs:680`:

```text
thread/turns/list params:
  { threadId, cursor?, limit?, sortDirection?, itemsView? }
response:
  { data, nextCursor?, backwardsCursor? }

thread/items/list params:
  { threadId, turnId, cursor?, limit?, sortDirection? }
response:
  { data: [{ turnId, item }], nextCursor?, backwardsCursor? }
```

The exact Rust definitions are `ThreadTurnsListParams/Response` at `codex-rs/app-server-protocol/src/protocol/v2/thread.rs:1518` / line 1537 and `ThreadItemsListParams/Response` at line 1552 / line 1580. `itemsView` values are `notLoaded`, `summary`, and `full` (`codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs:268`, `Turn`, and line 293, `TurnItemsView`).

Resume also gained bounded bootstrap fields:

- Request: `excludeTurns?` and `initialTurnsPage?` (`ThreadResumeParams`, `codex-rs/app-server-protocol/src/protocol/v2/thread.rs:326`).
- Page request: `{ limit?, sortDirection?, itemsView? }` (`ThreadInitialTurnsPageParams`, line 466).
- Response: `initialTurnsPage?`, `turnsBackwardsCursor?`, `itemsBackwardsCursor?` (`ThreadResumeResponse`, line 405).

Current TUI history code requests five turns and up to 100 items at a time, with a 400-item scan cap (`codex-rs/tui/src/app_server_session/history.rs:26`). Its `thread_turns_page` and `thread_items_page` calls are at lines 116–151; `hydrate_initial_thread_history` at line 194 uses bounded pages for paginated threads and retains the full-read fallback for legacy threads. This is the path established by `8bfa49e3` / `3b8d22ec` / `dbcd837c` and hardened by `449f099f1`.

## 5. Source of the “~98% fewer requests”

### The proven N+1

Commit `332eac4b858a40575a55f21026ecf8cb662e539c` states the defect precisely: loading the summary view issued a separate item query for every returned turn.

Before that commit, `list_turns` first fetched a page of turn rows, then for `itemsView = Summary` looped over those rows and called `load_summary_items` once per turn. `load_summary_items` issued a separate `SELECT ... FROM thread_items` query for that turn.

After that commit/current HEAD:

- `codex-rs/thread-store/src/local/thread_history/read.rs:95` (`list_turns`) consumes `turn.summary_items` returned by paging; only a synthetic inherited fork boundary needs a fallback item query.
- `codex-rs/thread-store/src/local/thread_history/segment_paging.rs:44` (`page_turn_rows`) uses a `page_turns` CTE and two joins to `thread_items` to return each turn's first user item and final agent item in the same query.
- App-server caps `thread/turns/list` at 100 turns (`THREAD_TURNS_DEFAULT_LIMIT` / `THREAD_TURNS_MAX_LIMIT`, `codex-rs/app-server/src/request_processors/thread_processor.rs:4714`); `thread_turns_page_size` at line 4721 defaults to 25 and clamps at 100.

For a 741-turn flat transcript requested at the 100-turn cap:

```text
old dominant SQL count:  ceil(741 / 100) + 741 = 8 + 741 = 749
new dominant SQL count:  ceil(741 / 100)       = 8
reduction:                (749 - 8) / 749       = 98.93%
```

This arithmetic explains “~98% fewer requests” without treating the supplied benchmark as verified. Fixed metadata/lineage queries and synthetic fork-boundary fallbacks are omitted from both sides, so this is a mechanism-level count, not an instrumented end-to-end total.

### What it did not optimize

- It did not remove one LLM/provider request per conversation turn. There was no such replay loop on `/v1/responses`.
- It optimizes `itemsView = Summary`. The full compatibility path still loads full items per turn: `paginated_thread_full_turns` calls `paginated_turn_full_items`, which loops over turns and calls `thread_store.list_items` (`codex-rs/app-server/src/request_processors/thread_processor.rs:2767`).
- TUI pagination separately reduces app-server RPC payload and startup hydration: five turns/100 items are loaded initially instead of the whole transcript. That is related user-visible latency work, but it is not the N+1 SQL commit.
- `ed390a5d` is an in-place filtering/allocation optimization, not the source of the request reduction.

The exact `27.6s` and `1.7s` timings, hardware, database cache state, RPC sequence, and profiler trace remain **UNVERIFIED** from the local checkout.

## 6. Provider-wire impact

### Core persistence/pagination path is local-only

The normal Responses request schema remains `ResponsesApiRequest` in `codex-rs/codex-api/src/common.rs:252`: `model`, `instructions`, `input`, `tools`, `tool_choice`, `parallel_tool_calls`, `reasoning`, `store`, `stream`, `stream_options`, `include`, `service_tier`, `prompt_cache_key`, `text`, and `client_metadata`.

None of the envelope, migration, SQLite projection, `includeTurns`, turn-list, item-list, rollout-ID, or N+1-query commits changes those fields. Before model submission, `ContextManager::for_prompt` maps envelopes back to raw `ResponseItem`s (`codex-rs/core/src/context_manager/history.rs:172`), stripping harness metadata. `3a6f747d7` explicitly keeps harness metadata away from model providers.

No inspected history commit introduces or changes `store`, `previous_response_id`, or `prompt_cache_key` reuse. In particular, pagination cursors are app-server/local-history cursors; they are not provider continuation IDs.

### Supplied anchors with provider-visible effects

1. **Remote compaction (`b9ba969f3`)**: Bedrock gains remote compaction support. Codex sends `POST /v1/responses/compact`. `CompactionInput` at `codex-rs/codex-api/src/common.rs:26` contains exact fields `model`, `input`, `instructions`, `tools`, `parallel_tool_calls`, `reasoning`, `service_tier`, `prompt_cache_key`, and `text`; the endpoint path is `fn path()` at `codex-rs/codex-api/src/endpoint/compact.rs:35` and the sending function is `compact_input` at line 71 [corrected in round-2 audit]. A Responses proxy sees this request.
2. **Image resize notice retention (`4bd5b9fd0`)**: changes which response items stay together in the remote compact request's existing `input` array. It adds no field, but a proxy can observe changed compact-body content.
3. **Guardian parent compaction reuse (`c2bcb9a26`)**: feature-gated Guardian review sessions can start with the parent's encrypted compaction response item. That item becomes review-session model input, so it is provider-visible content with no new request field.
4. **Turn-aware injection (`d6ca19d99`)**: changes when injected response items are associated/flushed in local history. Injected items remain model-visible on a later turn as before; this commit does not introduce a new provider-wire field.
5. **Compaction timing (`bd5b55e4`)**: `compaction_ms` is turn-profile telemetry, not model request data.


---

Evidence only (LEXICO-SPLIT-01). The prescriptive roadmap that once ended this file
lives in [000_plan.md](000_plan.md), [020_phase2_history_mode_awareness.md](020_phase2_history_mode_awareness.md),
[030_phase3_rollout_identity_and_previews.md](030_phase3_rollout_identity_and_previews.md), and
[050_phase5_compact_wire_verification.md](050_phase5_compact_wire_verification.md).
