# Lane D — OPENCODEX current-state inventory: history, rollout, usage, and Responses

## Evidence baseline and scope

| Checkout | Verified commit | Evidence |
|---|---|---|
| OPENCODEX | `7612e4c4f81544a250c3eea9fe8ca85d8022e765` | `git rev-parse HEAD`; commit subject `fix(routing): source capability evidence from explicit catalog provenance (#1799)` |
| UPSTREAM codex-rs | `9dd22890f5ff47e4af128c20e32b9758a61d78d2` | `git -C /Users/jun/Developer/codex/121_openai-codex rev-parse HEAD`; commit subject `Add an LRU baseline to skill shadow selection (#38197)` |

This is an inventory of OPENCODEX only. No upstream behavior is inferred here. “Conversation history” is separated into three distinct stores because OPENCODEX treats them differently:

| Store | Owner | Contents | Used on live `/v1/responses` request path? |
|---|---|---|---|
| `$CODEX_HOME/sessions/**/rollout-*.jsonl`, `$CODEX_HOME/archived_sessions/*` and `state_5.sqlite` | Codex | Codex thread/session history and listing metadata | No. Read or modified by integration migration/residue/storage workflows, not to construct ordinary Responses requests. |
| `$OPENCODEX_HOME/responses-state.json` and `responses-state-spill/` | OPENCODEX | Bounded `previous_response_id` continuation items plus provider-private continuation state | Yes. Expanded before request parsing. |
| `$OPENCODEX_HOME/usage.jsonl` and `routing-history.sqlite` | OPENCODEX | Request metadata, route attempts, status, timing, normalized usage; no prompts | No prompt replay. Used for usage summaries and management request-history views. |

`$CODEX_HOME` resolves from `CODEX_HOME`, otherwise the platform default `~/.codex`; `sqlite_home` in Codex `config.toml`, then `CODEX_SQLITE_HOME`, can relocate `state_5.sqlite` (`src/codex/paths.ts:6` `resolveCodexHome`, `src/codex/paths.ts:26` constants, `src/codex/paths.ts:76` `resolveCodexSqliteHome`, `src/codex/paths.ts:107` `resolveCodexStateDbPath`). `$OPENCODEX_HOME` is separate and defaults to `~/.opencodex` (`src/config.ts:643` `resolveConfigDir`, `src/config.ts:1661` `getConfigDir`).

## 1. Codex rollout/session JSONL parsing

### Direct answer

**Yes.** OPENCODEX parses rollout JSONL in two production subsystems, delegates that parser into a third, and has one isolated runtime-smoke script that parses a temporary Codex session:

1. history-provider migration/restore (`src/codex/history-provider.ts`),
2. native-residue classification (`src/codex/native-residue.ts`), and
3. archived-session restore, which calls `readThreadFieldsFromRollout` (`src/storage/cleanup.ts`), and
4. the OpenAI-provider-option runtime smoke (`scripts/openai-provider-option-runtime-smoke.ts`).

The parsers are schema-sensitive. They require the current top-level envelope `{type, payload}` and specific payload keys. A new envelope that moves or renames `type`/`payload` would not be understood:

| Consumer | Required current shape | Failure behavior if envelope changes |
|---|---|---|
| `parseSessionMetaLine` | top-level `type === "session_meta"`; object `payload` | Returns `null`; provider migration skips the rollout or restore cannot reconstruct fields (`src/codex/history-provider.ts:355`). |
| `extractUserMessagePreview` | top-level `event_msg` with payload `type/message/content`, or top-level `response_item` with payload message/role/content | Returns no preview; reconstructed `first_user_message` becomes empty (`src/codex/history-provider.ts:419`). |
| `rolloutSessionMetaPayload` | every nonblank line must parse as an object; session metadata is top-level `type === "session_meta"` with object `payload` | Marks classification `indeterminate` on malformed/unknown session-meta payload; an envelope that hides the record type is treated as a non-session-meta line, eventually “no session_meta metadata” (`src/codex/native-residue.ts:156`, `src/codex/native-residue.ts:502`). |

No rollout parser found in the ordinary `/v1/responses` ingress or adapter path. The only response-history expansion there is the OPENCODEX continuation store described later.

### Rollout/session inventory

| File and symbol | Read/write | Exact extraction or reasoning | Scope and bounds |
|---|---|---|---|
| `src/codex/history-provider.ts:355` `parseSessionMetaLine` | Parse | Parses one JSONL line; accepts only `type: "session_meta"` plus object `payload`. Exposes the whole payload and reads `model_provider`/`source`. | Malformed or other record types return `null`. |
| `src/codex/history-provider.ts:374` `readLatestSessionMeta` | Read/parse | Reads the whole plain rollout, scans backward, returns the last parseable `session_meta` (last-writer-wins). | No size cap in this function. |
| `src/codex/history-provider.ts:405` `textFromContentParts` | Parse | Extracts `text` or `input_text` strings from content arrays. | Used only for first-user-message reconstruction. |
| `src/codex/history-provider.ts:420` `extractUserMessagePreview` | Parse | Extracts the first user preview from `event_msg.payload.message/content` or `response_item.payload` where `type: message`, `role: user`. | Does not reconstruct full conversation history. |
| `src/codex/history-provider.ts:459` `readThreadFieldsFromRollout` | Read/parse | Reads plain JSONL or bounded zstd JSONL, then reconstructs thread listing fields. | `.jsonl.zst` decompression is capped at 64 MiB (`src/codex/history-provider.ts:9`, `src/codex/history-provider.ts:472`). |
| `src/codex/history-provider.ts:486` `parseThreadFieldsFromRolloutText` | Parse | Last session meta: `id`, `model_provider` (default `openai`), `source` (default `cli`), optional `cwd`, `history_mode`, `cli_version`; first user preview; derives `hasUserEvent`. | Full text split into lines; returns `null` without a parseable session meta/id. |
| `src/codex/history-provider.ts:72` `appendRolloutLine` | Write | Appends one JSONL line with `O_APPEND`; fsync best effort. | Used for provider/source migration metadata, not conversation turns. |
| `src/codex/history-provider.ts:107` `patchFirstLineProviderInPlace` | Read/write/parse | Reads line 1, verifies session id, length-preservingly rewrites `model_provider`, reparses, writes at offset 0. | Hard stop at 16 MiB for a newline-less/corrupt first line (`src/codex/history-provider.ts:111`). |
| `src/codex/history-provider.ts:530` `updateSessionMeta` | Read/write/reason | Clones the latest session-meta record, verifies `payload.id`, changes only provider/source, refreshes timestamp, patches line 1 best effort, appends the new record. | An id mismatch or unparseable latest meta makes it a no-op. |
| `src/codex/history-provider.ts:689` `syncCodexHistoryProvider` | Read/write | Coordinates `state_5.sqlite` thread rows and rollout metadata for legacy `openai`↔`opencodex` history tagging. | Integration migration/restore only. Uses DB busy timeout/retry. |
| `src/codex/history-provider.ts:705` `syncCodexHistoryProviderUnsafe` | Read/write | Selects `threads(id, rollout_path, model_provider, source, has_user_event)`, backs up originals, updates rollouts and rows. | Only resumable `cli`/`vscode` or selected legacy `exec` rows. |
| `src/codex/history-provider.ts:780` `restoreCodexHistoryProvider` | Read/write | Restores backed-up provider/source/user-event values and updates referenced rollouts. | Backup is OPENCODEX-owned `codex-history-backup-<hash>.json` (`src/codex/history-provider.ts:23`). |
| `src/codex/native-residue.ts:156` `rolloutSessionMetaPayload` | Parse | Validates JSON object envelope and session-meta payload shape. | Unknown non-session-meta record types are ignored; malformed lines fail closed. |
| `src/codex/native-residue.ts:176` `consumeRolloutLines` | Parse | Streams lines and retains first and latest session-meta payloads. | Does not retain conversation items. |
| `src/codex/native-residue.ts:416` `classifyReferencedRollout` | Read/parse/reason | Reads the rollout in 64 KiB chunks, validates file identity/races, requires first/latest ids and provider metadata, reports residue if either provider is `opencodex`. | Refuses rollouts over 64 MiB (`src/codex/native-residue.ts:82`, `src/codex/native-residue.ts:439`). |
| `src/codex/native-residue.ts:531` `classifyHistoryDatabase` | Read/parse/reason | Reads all `threads(id, rollout_path, model_provider)`, validates referenced rollouts, and detects routed residue. | Read-only DB open; any schema/read uncertainty is `indeterminate`. |
| `src/storage/cleanup.ts:222` `normalizeArchivedRolloutPath` | Path reasoning | Accepts only one file directly under `archived_sessions/`, normalizes `.jsonl.zst` to logical `.jsonl`, explicitly rejects active `sessions/`. | No content read. |
| `src/storage/cleanup.ts:276` `listArchivedCandidates` | Read metadata | Lists archived `.jsonl`/`.jsonl.zst`, groups physical variants, orders by mtime/size. | Never walks active sessions. |
| `src/storage/cleanup.ts:444` `collectPinnedArchivedRolloutPaths` | DB/path reasoning | Reads pinned thread rollout paths and excludes matching archived candidates. | Content not parsed. |
| `src/storage/cleanup.ts:2297` `reconstructThreadRowFromRollout` | Read/parse | Calls `readThreadFieldsFromRollout` to reconstruct old quarantined thread rows. | Used only when a legacy cleanup manifest lacks complete satellite snapshots. |
| `src/storage/cleanup.ts:2484` legacy restore loop | Read/parse/write | Locates restored plain/zstd rollout and reconstructs required `threads` columns. | Fails restore if required session metadata cannot be reconstructed. |
| `src/storage/scanner.ts:89` `walkFiles`, `src/storage/scanner.ts:172` `scanStorage` | Read metadata | Measures active/archived session bytes/counts/mtime/largest paths; opens newest state/log DB immutably for row counts. | Does not parse JSONL content; performs zero writes (`src/storage/scanner.ts:17`). |
| `scripts/openai-provider-option-runtime-smoke.ts:343` isolated runtime evidence | Read/parse | Recursively finds the one temporary session JSONL, parses every line, extracts first `session_meta.payload` and first `turn_context.payload`, then asserts `turn_context.model` and `session_meta.model_provider` (`scripts/openai-provider-option-runtime-smoke.ts:350`). | Diagnostic/final-gate script only; schema-sensitive and would throw if the expected temporary rollout/envelope changed. |
| `src/codex/inject.ts:1012` history-job dispatch | Orchestration | Integration apply/restore can schedule the history-provider job after Codex config/catalog handling. | Not part of request ingress. |
| `src/codex/sync.ts:60` `syncModelsToCodex` | Orchestration | Syncs Codex catalog/config and reports whether config, catalog, cache, or history changed. | It does not parse rollouts itself. |

## 2. `~/.codex` state inventory relevant to this lane

| Surface | Owner/symbol | Current behavior |
|---|---|---|
| Home/path resolution | `src/codex/home.ts:135` `defaultCodexHome`; `src/codex/home.ts:143` `resolveCodexHomeDir` | Uses explicit `CODEX_HOME` or platform `~/.codex`; has WSL Windows-profile discovery. |
| Canonical paths | `src/codex/paths.ts:26` | Defines `config.toml`, `opencodex.config.toml`, `opencodex-catalog.json`, `models_cache.json`. |
| SQLite root | `src/codex/paths.ts:76` | Parses root `sqlite_home`; precedence is Codex config, `CODEX_SQLITE_HOME`, effective home. |
| Codex config/profile | `src/codex/inject.ts:641` `injectCodexConfig` | Reads `config.toml`, computes managed routing/profile changes, and atomically writes config/profile after admission; preserves external model-provider configs. |
| Catalog/cache | `src/codex/sync.ts:60` plus `src/codex/catalog/sync.ts:1592` `syncCatalogModels` | Refreshes OPENCODEX catalog and Codex model cache before injection. This is model metadata, not conversation content. |
| Main Codex credentials | `src/codex/auth-collision.ts:36` `readCodexTokensResult` | Reads and parses `$CODEX_HOME/auth.json` tokens without logging them. These credentials authorize native forwarding and WHAM quota probes; they are not usage history. |
| Thread DB and rollouts | `src/codex/history-provider.ts:689`; `src/codex/native-residue.ts:531` | Migration/residue logic described above. |
| Active/archived session storage | `src/storage/scanner.ts:172`; `src/storage/cleanup.ts:276` | Scanner measures both; cleanup mutates only archived sessions and associated DB rows, never active sessions. |
| Management storage view | `src/server/management-api.ts:35-38` imports; routed through management handlers at `src/server/management-api.ts:208` | Resolves Codex home and exposes scan/cleanup operations through management APIs. It does not expose rollout conversation bodies. |

## 3. Usage/token accounting and quota display

### Accounting data flow

| Stage | File and symbol | Source and normalized fields |
|---|---|---|
| Canonical shape | `src/types.ts:410` `OcxUsage` | `inputTokens`, `outputTokens`, optional absolute `contextTotalTokens`, `totalTokens`, cached read/write split, reasoning output, estimated flag. Cache detail is a subset and is not added twice (`src/types.ts:401`). |
| Native Responses passthrough extraction | `src/server/request-log.ts:542` `applyResponseLogMetadata`; `src/server/request-log.ts:563` `usageFromResponsesPayload` | Reads upstream `response.usage`/`usage`, supporting Responses `input_tokens/output_tokens` and chat-style `prompt_tokens/completion_tokens`, plus cached/write/reasoning details. |
| Routed OpenAI Responses adapter | `src/adapters/openai-responses.ts:1277` `usageFromResponsesPayload` | Reads upstream Responses usage into `OcxUsage` for adapter events. |
| OpenAI Chat adapter | `src/adapters/openai-chat.ts:1147` `usageFromOpenAIChat` | Reads provider `prompt_tokens`, `completion_tokens`, cached and reasoning details. Requests streaming usage with `stream_options.include_usage` (`src/adapters/openai-chat.ts:1337`). |
| Other adapters | Examples: `src/adapters/anthropic.ts:520`, `src/adapters/google.ts:288`, `src/adapters/command-code.ts:311`, `src/adapters/kiro-events.ts:72` | Normalize provider-specific usage frames; Cursor/Kiro can be marked estimated when authoritative per-turn usage is unavailable (`src/usage/log.ts:162`). |
| Bridge capture | `src/server/responses/core.ts:4122` streaming and `src/server/responses/core.ts:4193` JSON | Receives raw adapter usage before Responses wire normalization and places it on request/attempt log context. |
| Local fallback estimate | `src/server/request-log.ts:989` `finalizedUsage` | If usage is absent, can persist an input-token estimate with output 0; combines an estimate with reported usage conservatively and caps estimates at known context windows. |
| Durable ledger | `src/usage/log.ts:154` `usageLogPath`; `src/usage/log.ts:442` `appendUsageEntry` | Appends normalized request rows to `$OPENCODEX_HOME/usage.jsonl`, mode `0600`. |
| Summary | `src/usage/summary.ts:290` onward | Aggregates requests/attempts, input/output/cache/reasoning/total tokens, models/providers/accounts, and estimated cost. |
| Management usage API | `src/server/management/logs-usage-routes.ts:197` | `GET /api/usage` reads a bounded snapshot of `usage.jsonl`, summarizes it, and caches by exact ledger revision and pricing-overlay version. |
| Management request history | `src/server/management/request-history-routes.ts:1` | `GET /api/request-history` is request telemetry, not chat content. It queries a derived SQLite projection. |
| Request-history index | `src/routing/history/indexer.ts:1` `Derived request-history index` | Incrementally indexes complete rows from canonical `usage.jsonl` into rebuildable `$OPENCODEX_HOME/routing-history.sqlite`; records over 1 MiB are omitted from the projection, never from the ledger (`src/routing/history/indexer.ts:76`). |

### Does accounting read Codex-local state?

| Surface | Answer | Evidence |
|---|---|---|
| Per-request usage/token accounting | **No rollout/session reads.** Usage comes from upstream provider response frames or OPENCODEX estimates and is persisted in `$OPENCODEX_HOME/usage.jsonl`. | `src/server/request-log.ts:542`, `src/server/request-log.ts:563`, `src/server/request-log.ts:989`, `src/usage/log.ts:442`. |
| Context admission estimate | **No Codex-local history reads.** It walks the already-received parsed request: prompts, messages, thinking, tool calls/results, tools, and image approximations. | `src/server/responses/input-admission.ts:89` `estimateInputTokens`. |
| Native model metadata used by logging/admission | **Limited Codex-local metadata read, not conversation state.** Service-tier support can read Codex catalog metadata (`src/server/request-log.ts:520`); native context windows come from static catalog metadata (`src/server/responses/input-admission.ts:128`). | Paths cited. |
| Provider quota bars | **Live provider-account state, separate from request usage.** `GET /api/provider-quotas` calls provider quota endpoints through `fetchProviderQuotaReports`; native ChatGPT quota uses WHAM. | `src/server/management/provider-routes.ts:342`; `src/providers/quota.ts:1014`; `src/providers/quota.ts:1964`. |
| Native Codex quota credential | **Reads `$CODEX_HOME/auth.json` only to authorize WHAM.** The quota values themselves come from `https://chatgpt.com/backend-api/wham/usage`. | `src/codex/auth-api.ts:681`, `src/codex/auth-api.ts:700`. |
| Quota cache | **OPENCODEX-local, not Codex-local.** Percent/reset-credit snapshots live at `$OPENCODEX_HOME/codex-quota-cache.json`. | `src/codex/quota.ts:24`; WHAM parsing at `src/codex/quota.ts:439`. |
| Codex quota management view | Reads the in-memory/disk quota cache, not rollouts. | `src/codex/auth-api.ts:1640` `GET /api/codex-auth/quota`. |

## 4. `/v1/responses` inbound lifecycle

### End-to-end path

| Order | File and symbol | Behavior |
|---:|---|---|
| 1 | `src/server/index.ts:1187` HTTP route | Auth/origin/admission, request-log context, then `handleResponses`; final logging can be deferred until a native stream terminal. |
| 1b | `src/server/index.ts:1427`, `src/server/index.ts:1534` WS route | Converts each `response.create` frame into an internal POST body with `stream: true` and invokes the same handler. |
| 2 | `src/server/responses/core.ts:1572` `handleResponsesInner` | Reads/decompresses bounded JSON, handles combo dispatch, local continuation expansion, encrypted-task normalization, parses request. |
| 3 | `src/server/responses/core.ts:1035` `applyFinalRouteRequestNormalization` | Rewrites selected model/stream/store/service-tier/guidance/effort after final route selection. |
| 4 | `src/server/responses/core.ts:1942` input admission | Estimates full parsed input and may return 413; skips compaction turns. |
| 5 | `src/server/responses/core.ts:2242` passthrough or translated adapter branch | OpenAI Responses passthrough builds from `_rawBody`; other adapters build provider-specific requests from parsed context/options. |
| 6a | `src/server/responses/core.ts:2781` passthrough SSE | Tees native SSE for bounded inspection/logging/continuation recording while relaying to client. |
| 6b | `src/server/responses/core.ts:2852` passthrough JSON | Reads max 32 MiB, logs usage, optionally records continuation, repairs/reframes output. |
| 6c | `src/server/responses/core.ts:4087` translated stream; `src/server/responses/core.ts:4151` translated JSON | Parses adapter events, applies terminal/empty-completion guards, builds Responses SSE/JSON, captures usage and continuation state. |

### Field-by-field inbound behavior

The accepted top-level schema is `src/responses/schema.ts:139` `responsesRequestSchema`. Zod parses known fields into `data`, while `parseRequest` also preserves the original/expanded object as `_rawBody` (`src/responses/parser.ts:703`). Therefore a field can be ignored by translated adapters yet still survive an OpenAI Responses passthrough.

| Field | Validation/read | Internal rewrite/use | Forward/drop behavior |
|---|---|---|---|
| `store` | Optional boolean at `src/responses/schema.ts:151`. `parseRequest` does not copy it into `OcxRequestOptions`; later code reads `_rawBody.store`. | Canonical ChatGPT forward route defaults an omitted value to `false`, preserving explicit values (`src/server/responses/core.ts:1083`). `rememberResponseState` ordinarily skips `store:false`, while forced passthrough/Kiro/Cursor paths may still retain bounded local continuation state (`src/responses/state.ts:1164`). | OpenAI Responses raw passthrough preserves explicit values. Stateless Responses providers force `store:false` (`src/adapters/openai-responses.ts:790`). When `store:false`, item `id` fields are stripped because upstream cannot resolve stored items (`src/adapters/openai-responses.ts:119`). Translated non-Responses adapters do not receive a `store` field. |
| `previous_response_id` | Optional string at `src/responses/schema.ts:152`; copied to `parsed.previousResponseId` at `src/responses/parser.ts:703`. | Before parsing, `expandPreviousResponseInput` looks up OPENCODEX continuation state and prepends stored items (`src/server/responses/core.ts:1609`; `src/responses/state.ts:986`). Cross-task scope mismatch removes the id (`src/responses/state.ts:1000`). Spill corruption/missing is a structured 400 (`src/server/responses/core.ts:1614`). Duplicate full client-carried history is detected and not prepended (`src/responses/state.ts:1010`). | Canonical forward always strips it after requiring local replay for safety; API-key Responses keeps an unexpanded id for real server-side continuation but strips it after local expansion; stateless providers always strip it (`src/adapters/openai-responses.ts:750`, `src/adapters/openai-responses.ts:790`). Combo children delete it after expansion to prevent double prepend (`src/server/responses/core.ts:1244`). Translated adapters consume the expanded context, not the id. |
| `prompt_cache_key` | Optional string at `src/responses/schema.ts:154`; copied to `options.promptCacheKey` at `src/responses/parser.ts:686`. | Used for provider transport/key affinity (`src/server/responses/core.ts:2063`) and as one candidate in Anthropic account session affinity (`src/server/responses/core.ts:2000`). | Raw OpenAI Responses passthrough preserves it. OpenAI Chat forwards it only when provider config opts into `promptCacheKey` (`src/adapters/openai-chat.ts:1298`). Other translated adapters do not receive the top-level field merely because it was present. |
| `instructions` | Optional string/null at `src/responses/schema.ts:142`. Nonempty string is read at `src/responses/parser.ts:330`. | Appended to `context.systemPrompt`; system-role input messages are also flattened into the same system prompt (`src/responses/parser.ts:420`). | Translated adapters receive it as system context, not a Responses top-level field. Raw OpenAI Responses passthrough retains the original field. Empty/null instructions do not add system context. |
| `input` string | Optional string or item array at `src/responses/schema.ts:141`. | String becomes one user message (`src/responses/parser.ts:334`). | Translated to provider message format; raw passthrough retains the string unless another sanitizer rewrites the body. |
| `input[]` message items | Item schema at `src/responses/schema.ts:36-103`; parsing loop begins `src/responses/parser.ts:337`. | User/developer → messages; system → system prompt; assistant → assistant content/phase. Images stay structured; inline file bytes become a marker, not prompt bytes (`src/responses/parser.ts:37`). | Unknown item types can pass schema via the loose catch-all and remain in `_rawBody`, but the translated parser ignores unhandled types. |
| `input[]` reasoning | `reasoning` item schema at `src/responses/schema.ts:52`. | Summary text preferred over content; OPENCODEX reasoning envelopes decoded; plaintext thinking attached to the proper assistant/tool-call turn; opaque native encrypted-only reasoning is not exposed (`src/responses/parser.ts:455`). | Passthrough sanitation can strip OPENCODEX envelopes/raw reasoning content and item ids depending on target/store (`src/adapters/openai-responses.ts:38`, `src/adapters/openai-responses.ts:119`). |
| `input[]` calls/results | Schemas at `src/responses/schema.ts:60-91`. | Function/custom/local-shell/tool-search calls and outputs are paired into assistant/tool-result history (`src/responses/parser.ts:501`, `src/responses/parser.ts:543`, `src/responses/parser.ts:566`, `src/responses/parser.ts:609`). Malformed call arguments default to `{}`. | OpenAI Responses passthrough has orphan repair, adjacency normalization, id sanitation, and tool compatibility rewrites (`src/adapters/openai-responses.ts:611`, `src/adapters/openai-responses.ts:660`, `src/adapters/openai-responses.ts:1363`). |
| `input[]` compaction | Loose item acceptance; explicit handling at `src/responses/parser.ts:356` and `src/responses/parser.ts:373`. | `compaction_trigger` flags a compaction request and is not a message. Stored `compaction`/`compaction_summary`/`context_compaction` becomes a summary user message; payload-less `context_compaction` is only a boundary marker. | Routed compaction replaces tools/structured output and adds the compaction prompt (`src/server/responses/core.ts:2215`). Passthrough sanitizer converts OPENCODEX `ocx1:` compaction items to plain messages but leaves genuine OpenAI opaque blobs (`src/adapters/openai-responses.ts:141`). |
| top-level `reasoning` | Optional nullable `{effort?, summary?}` at `src/responses/schema.ts:132`, `src/responses/schema.ts:150`. | `ultra`→`max`; only known effort strings retained; summary absent/`none` sets `hideThinkingSummary` (`src/responses/parser.ts:673`). Final routing can cap/clamp effort and mutate `_rawBody.reasoning.effort` (`src/server/responses/core.ts:1157`, `src/server/responses/core.ts:1173`); shadow calls force low (`src/server/responses/core.ts:1681`). | Raw passthrough preserves it subject to model capability/spark/summary sanitizers (`src/adapters/openai-responses.ts:167`, `src/adapters/openai-responses.ts:190`). Native `/responses/compact` explicitly drops top-level reasoning before forwarding (`src/server/responses/compact.ts:401`). Translated adapters map `options.reasoning` to their wire format. |
| `include[]` | Accepted as `unknown` at `src/responses/schema.ts:161`. | **Not read by `parseRequest` and no other top-level `include` consumer was found in `src/responses`, `src/server/responses`, or adapters.** | Preserved only through `_rawBody` on OpenAI Responses passthrough. Dropped implicitly on translated provider requests because no internal option carries it. No focused `include[]` test was found. |

### Other observed top-level mutations

| Mutation | Evidence |
|---|---|
| Routed model namespace/virtual model rewrites mutate `_rawBody.model`. | `src/server/responses/core.ts:1052`, `src/server/responses/core.ts:1099`. |
| Provider policy may force `_rawBody.stream = false`. | `src/server/responses/core.ts:1076`. |
| Service tier can be injected/deleted based on route capability. | `src/server/responses/core.ts:1114`, `src/server/responses/core.ts:1524`. |
| Multi-agent guidance inserts a developer item into parsed context and raw input. | `src/server/responses/core.ts:1137`; insertion implementation `src/server/responses/collaboration.ts:452`. |
| Plaintext task payloads mislabeled as encrypted content are rewritten in raw `input` before parsing. | `src/server/responses/core.ts:1624`. |
| Canonical forward rejects and therefore drops `max_output_tokens` and `metadata`. | `src/adapters/openai-responses.ts:801`. |
| Stateless Responses providers drop `previous_response_id`, `conversation`, `background`, `metadata`, and `prompt`, then force `store:false`. | `src/adapters/openai-responses.ts:767`. |

## 5. Long inputs, compaction, truncation, and caching

| Mechanism | Current behavior | Evidence |
|---|---|---|
| Request-body cap | Accepts identity/zstd/gzip/deflate JSON up to 256 MiB decompressed; rejects larger bodies with 413. This is byte admission, not semantic truncation. | `src/server/request-decompress.ts:15`, `src/server/request-decompress.ts:190`, `src/server/request-decompress.ts:237`. |
| Translation memory budget | Per request, retained translation buffers are capped at 32 MiB and one tool-call argument at 2 MiB; overflow maps to 413 `translation_buffer_limit`. | `src/lib/translator-budget.ts:1`; `src/server/responses/core.ts:1651`. |
| Context-size admission | Estimates all parsed system/messages/thinking/tool args/tool schemas/images and refuses only above `known ceiling × 2.5`; unknown ceiling fails open. Returns 413 telling the client to start a new session or choose a larger model. | `src/server/responses/input-admission.ts:81`, `src/server/responses/input-admission.ts:128`, `src/server/responses/input-admission.ts:159`; call site `src/server/responses/core.ts:1942`. |
| Automatic truncation on ordinary turns | **None found.** The admission gate explicitly says it is not a context manager or compaction trigger. Ordinary over-limit input is rejected, not shortened. | `src/server/responses/input-admission.ts:2-11`. |
| Parser-level content omission | Malformed blocks are ignored; remote image URLs remain structured; inline `input_file.file_data` bytes are replaced by a marker. This is protocol normalization, not old-turn truncation. | `src/responses/parser.ts:37-82`. |
| Remote compaction v2 | `compaction_trigger` makes a routed model summarize with `COMPACT_PROMPT`; bridge emits exactly one synthetic `compaction` item containing `ocx1:` + base64 summary. Later input decodes it to a summary message. | `src/responses/compaction.ts:1-53`; `src/server/responses/core.ts:2215`; bridge flags at `src/server/responses/core.ts:4121`. |
| Remote compaction v1 | `/v1/responses/compact` forwards to supported native compact upstreams; routed models are internally converted to v2 summarization, then return recent user messages plus summary. Retained user-message budget is 20k tokens approximated as 80k chars, newest-first with partial oldest tail. | Route `src/server/index.ts:1071`; handler `src/server/responses/compact.ts:267`; retention `src/responses/compaction.ts:56-123`; routed conversion `src/server/responses/compact.ts:656-716`. |
| Compaction input admission | Compaction turns bypass the context 413 gate so a full context can be shrunk. | `src/server/responses/core.ts:1944`. |
| Post-compaction continuation | Compaction turns are deliberately not recorded in OPENCODEX continuation state, because `_rawBody` contains pre-compaction history and replay would rehydrate it. | `src/server/responses/core.ts:2257`, `src/server/responses/core.ts:4130`, `src/server/responses/core.ts:4201`. |
| Local `previous_response_id` cache | Stores request input + response output, prepends it on continuation, detects a full client-carried duplicate, and binds scoped entries to client task ids. | `src/responses/state.ts:986`, `src/responses/state.ts:1010`, `src/responses/state.ts:1164`. |
| Continuation cache bounds | 1,000 ids, 1-hour TTL, 64 MiB resident cap; oversized resident entries spill durably; snapshot write retains max 2 MiB per resident entry and 24 MiB total; existing snapshot parse capped at 32 MiB. Dedicated spill payload cap is 256 MiB. | `src/responses/state.ts:17-30`; pruning `src/responses/state.ts:853`; spill cap `src/responses/spill-store.ts:61-67`. |
| Continuation persistence | Best-effort, debounced `$OPENCODEX_HOME/responses-state.json`; dedicated spills in `$OPENCODEX_HOME/responses-state-spill/`. Cache is not a source of truth. | `src/responses/state.ts:402`, `src/responses/state.ts:597`; `src/responses/spill-store.ts:151`. |
| Prompt caching | Anthropic adapters can add up to four ordered `cache_control` breakpoints based on `cacheRetention`; native Anthropic may also use top-level automatic caching. | `src/adapters/anthropic.ts:64-162`, `src/adapters/anthropic.ts:925`. |
| `prompt_cache_key` | Forwarded only on supported/opted-in wires and also used for affinity/transport selection; OPENCODEX does not maintain a prompt-content cache keyed by it. | `src/responses/parser.ts:686`, `src/adapters/openai-chat.ts:1298`, `src/server/responses/core.ts:2000`, `src/server/responses/core.ts:2063`. |
| Reasoning replay cache | Separate process-local, provider/account/model/thread-scoped bounded cache for pairing raw reasoning with tool calls; never logged or persisted. | `src/responses/reasoning-replay-cache.ts:1-18`, `src/responses/reasoning-replay-cache.ts:187`. |
| Management “request history” | Caches/indexes request telemetry only. It never supplies conversation text to models. | `src/server/management/request-history-routes.ts:1-11`, `src/routing/history/indexer.ts:1-9`. |

## 6. Test coverage inventory

### Responses ingress and lifecycle

| Test file and anchors | Covered behavior |
|---|---|
| `tests/responses-parser.test.ts:5` | Core parser, tool schemas, phase, tool choice, `service_tier`, `prompt_cache_key`, structured output, files/images, compaction replay, additional tools, reasoning effort normalization. |
| `tests/responses-parser-agent-message.test.ts:4` | Agent-message/reasoning turn boundaries. |
| `tests/responses-parser-malformed-content.test.ts:22` | Malformed content blocks, null/object containers, image/file omission/markers, adapter build resilience. |
| `tests/responses-inbound-store-default.test.ts:37` | Omitted versus explicit `store` across canonical forward, key-auth Responses, and noncanonical forward gateways. |
| `tests/responses-state.test.ts:108` | `previous_response_id` storage/expansion/scope, `store:false`, forced continuation, spill/persistence/TTL/size bounds, corrupt/missing state, compaction-marker provenance, provider continuation state. |
| `tests/continuation-dedup.test.ts:58` | Exact client-carried replay deduplication, ordering, provider-authored identity requirement, bounded fingerprints. |
| `tests/issue-702-expired-replay-state.test.ts:246` | Fail-closed expired/corrupt forward replay, fresh local expansion, and API-key preservation of native `previous_response_id`. |
| `tests/openai-responses-passthrough.test.ts:241` | Passthrough sanitization: reasoning, ids/store, prompt cache key, previous-response stripping, stateless fields, tools, summaries, compaction compatibility. |
| `tests/openai-chat-hardening.test.ts:504` | `prompt_cache_key` opt-in forwarding/drop behavior. |
| `tests/responses-compaction.test.ts:43` | Compaction envelope encode/decode, parser trigger/summary behavior, v1 retained user-message output. |
| `tests/responses-compaction-routing.test.ts:139`, `tests/responses-compaction-routing.test.ts:437`, `tests/responses-compaction-routing.test.ts:557`, `tests/responses-compaction-routing.test.ts:639` | Native/routed compact routing, auth/pool/fallback/circuit behavior and compact request output contract. |
| `tests/input-admission.test.ts:34`, `tests/input-admission.test.ts:96`, `tests/input-admission.test.ts:154` | Context ceiling resolution, whole-input estimation, images/tool schemas/thinking, tolerance and fail-open behavior. |
| `tests/responses-tool-conformance.test.ts:39` | `additional_tools`, tool-kind discrimination, tool-search history, stream/JSON parity. |
| `tests/adapter-tool-conformance.test.ts:74` | Instructions entering translated adapter context along with tool behavior. |

Field-specific coverage result:

| Field | Focused coverage found? |
|---|---|
| `store` | Yes — `tests/responses-inbound-store-default.test.ts:37`; continuation effects in `tests/responses-state.test.ts:291`. |
| `previous_response_id` | Yes — `tests/responses-state.test.ts:108`, `tests/continuation-dedup.test.ts:58`, `tests/issue-702-expired-replay-state.test.ts:246`, `tests/openai-responses-passthrough.test.ts:843`. |
| `prompt_cache_key` | Yes — parser at `tests/responses-parser.test.ts:191`, raw passthrough at `tests/openai-responses-passthrough.test.ts:785`, chat opt-in at `tests/openai-chat-hardening.test.ts:504`. |
| `instructions` | Indirect translated-adapter coverage at `tests/adapter-tool-conformance.test.ts:74`; no dedicated parser-only instructions test found. |
| `input[]` | Broad parser/malformed/tool/compaction coverage in the parser and conformance files above. |
| top-level `reasoning` | Yes — `tests/responses-parser.test.ts:410`; passthrough sanitization beginning `tests/openai-responses-passthrough.test.ts:472`. |
| `include[]` | **No focused test found.** |

### Rollout/session and Codex-state reads

| Test file and anchors | Covered behavior |
|---|---|
| `tests/codex-history-provider.test.ts:98` | Latest session meta, append-not-rewrite, id mismatch, first-line provider patch, large first-line metadata, provider restore/eject, DB retry/no-op/migration. |
| `tests/codex-native-residue.test.ts:627` | DB↔rollout provider consistency, first/latest metadata, malformed/oversized/BOM/chunk-split/missing rollout, backup references, fail-closed classification. |
| `tests/storage-cleanup.test.ts:325` | Archived-only listing, active-session exclusion, `.jsonl`+`.zst` grouping/path normalization. |
| `tests/storage-cleanup.test.ts:1389` | Legacy quarantine restore reconstructs production thread fields from rollout JSONL. |
| `tests/storage-cleanup.test.ts:1475` | Bounded compressed-only rollout reconstruction. |
| `tests/storage-scanner.test.ts:105` | Session/archive byte inventory, immutable DB row counts, unreadable DB behavior, zero-write invariant. |
| `tests/codex-inject-integration.test.ts:366` | External provider config remains byte-identical so existing session history remains visible. |
| `tests/codex-history-job.test.ts`, `tests/codex-history-worker.test.ts`, `tests/codex-history-writer.test.ts`, `tests/codex-history-reachability.test.ts` | History job/worker serialization, writer/retry boundaries, and module reachability around the same provider migration. |
| `tests/api-storage.test.ts`, `tests/api-storage-cleanup.test.ts` | Management storage scan/cleanup API surfaces. |
| `tests/openai-provider-option-tooling.test.ts:38` | Validates the smoke/final-gate evidence artifact shape; the temporary rollout parsing itself runs in the script final gate rather than a unit test. |

## Inventory conclusions

| Question | Current-state answer |
|---|---|
| Does OPENCODEX parse Codex rollout JSONL? | Yes, for provider/source migration, native-residue verification, and legacy archived-session restoration. It extracts session metadata and at most the first user-message preview, not the full conversation for inference. The parsers are envelope/schema-sensitive. |
| Does usage/quota read rollout history? | No. Per-request usage comes from provider response frames or local estimates. Quotas come from provider quota endpoints (native ChatGPT via WHAM), with `$CODEX_HOME/auth.json` used only as credentials and `$OPENCODEX_HOME` used for caches/ledgers. |
| How are the named inbound fields handled? | `store` is raw-body policy; `previous_response_id` is locally expanded and target-conditionally stripped; `prompt_cache_key` is preserved plus used for affinity where supported; `instructions` becomes system context; `input[]` is deeply normalized; `reasoning` is mapped/capped/sanitized; `include[]` is passthrough-only and disappears on translated wires. |
| What happens to very long input? | Byte/translation/context gates reject oversized ordinary turns. OPENCODEX does not truncate old turns automatically. It implements explicit Codex remote compaction v1/v2 and bounded local continuation/spill caches. |
| What tests exist? | Strong coverage exists for parsing, continuation, passthrough sanitization, compaction, admission, rollout migration/residue, and archived restore. No focused top-level `include[]` test was found; instructions coverage is indirect. |
