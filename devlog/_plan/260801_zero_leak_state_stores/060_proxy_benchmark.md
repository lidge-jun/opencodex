# 060 — proxy no-leak benchmark evidence

Date: 2026-08-01  
Work phase: wp7  
Depends on: 010–055 landed and re-audited  
Status: COMPLETE — matrix populated from commit-pinned source evidence

## Purpose

This is the only document allowed to make a comparative superiority claim for the unit.
It compares production TypeScript-based LLM proxies from opened source, separates
translation-duty products from pure relays, and distinguishes a finite theoretical bound
from operational cleanup that merely “usually happens.” LiteLLM and one-api are retained
as non-TypeScript context rows and are excluded from the TypeScript-only headline cohort.

## Evidence rules

- Prefer commit-pinned GitHub source URLs, then release notes/issues for historical
  context. Repository home pages are discovery pointers, not sufficient proof.
- Record source-open date, commit/tag, exact file/function, bound dimensions, and cleanup
  trigger. Search snippets and README claims are not implementation evidence.
- Classify count, per-entry bytes, aggregate bytes, TTL, admission, active-resource
  ownership, and upstream cancellation independently.
- A process restart is not an eviction policy. External Redis/DB is not app-owned RAM,
  but client/request buffers and local registries still count.
- “No continuation store” is not automatically stronger when the product is a pure relay;
  translation duty and replay semantics must be called out.
- Any ambiguous cell is `UNKNOWN`, not `PASS`.

## Evidence URL ledger

All sources were opened on 2026-08-01. Dates below are commit dates, not source-open dates.

| Subject | Discovery URL | Exact source permalink | Resolved revision and date | Opened at wp7 | Notes |
|---|---|---|---|---|---|
| Portkey Gateway | https://github.com/Portkey-AI/gateway | <https://github.com/Portkey-AI/gateway/blob/669825cbe89ee51569918b8f78a9db486fd69dd4/src/handlers/chatCompletionsHandler.ts#L12-L24> | `669825cbe89ee51569918b8f78a9db486fd69dd4`, 2026-05-25 | 2026-08-01 | TypeScript cohort; relay/router with cache and stream handling. |
| Claude Code Router | https://github.com/musistudio/claude-code-router | <https://github.com/musistudio/claude-code-router/blob/4a152d959c016b476220339e856c9f4f94624c42/packages/core/src/gateway/http/io.ts#L290-L317> | `4a152d959c016b476220339e856c9f4f94624c42`, 2026-07-31 | 2026-08-01 | TypeScript cohort; translation, continuation, diagnostics, and managed runtime. |
| punkpeye mcp-proxy | https://github.com/punkpeye/mcp-proxy | <https://github.com/punkpeye/mcp-proxy/blob/e298da80322da0a1d1edcf5c83be00bd103ad43a/src/startHTTPServer.ts#L58-L75> | `e298da80322da0a1d1edcf5c83be00bd103ad43a`, 2026-07-29 | 2026-08-01 | TypeScript cohort; pure MCP/session relay, so translation-only categories may be N/A. |
| LiteLLM | https://github.com/BerriAI/litellm | <https://github.com/BerriAI/litellm/blob/23de7a15d9d40006ee596e617475ba101d60c5e9/litellm/caching/in_memory_cache.py#L28-L44> | `23de7a15d9d40006ee596e617475ba101d60c5e9`, 2026-08-01, branch `litellm_internal_staging` | 2026-08-01 | Python non-TypeScript context; only supplied cache/stream anchors are scored. |
| LiteLLM issue 6404 | https://github.com/BerriAI/litellm/issues/6404 | <https://github.com/BerriAI/litellm/issues/6404> | Issue opened 2024-10-23; closed `not_planned` by automation 2025-05-26 after reopen | 2026-08-01 | Historical issue evidence only; weak closure evidence, not implementation proof. |
| one-api | https://github.com/songquanpeng/one-api | <https://github.com/songquanpeng/one-api/blob/8df4a2670b98266bd287c698243fff327d9748cf/common/config/config.go#L57-L60> | `8df4a2670b98266bd287c698243fff327d9748cf`, 2025-02-21 | 2026-08-01 | Go non-TypeScript context; external Redis/DB state is separated from local maps. |
| lru-cache precedent | https://github.com/isaacs/node-lru-cache | <https://github.com/isaacs/node-lru-cache/blob/16b3a916662ab449d496b7b4b4f04132565d1d28/src/index.ts> | `16b3a916662ab449d496b7b4b4f04132565d1d28`, 2026-07-07 | 2026-08-01 | Precedent only; not a competitor row. |
| cacache precedent | https://github.com/npm/cacache | <https://github.com/npm/cacache/blob/6e8eb4d7e82694149c34fbb0fbe5441628fc1703/lib/content/write.js> | `6e8eb4d7e82694149c34fbb0fbe5441628fc1703`, 2026-06-18 | 2026-08-01 | Spill precedent only; not a competitor row. |
| OpenCodex | repository under this unit | <https://github.com/lidge-jun/opencodex/blob/17faddd24/src/server/request-decompress.ts#L88-L131> | `17faddd24`, 2026-08-01 | 2026-08-01 | Gap-closure commit; source/tests were re-opened from the local git object. The formed GitHub permalink resolves after the already-landed local commit is pushed; wp7 did not push. |

## Comparison categories

`PASS` means a finite production-code contract and its relevant negative/boundary test
were both found. `PARTIAL`, `FAIL`, `N/A`, and `UNKNOWN` preserve the distinctions in the
frozen reports; an adjacent mechanism is not promoted to proof of the requested category.

1. request/body admission before large allocation;
2. upstream abort on client disconnect/cancel;
3. per-stream frame and producer-queue bounds;
4. tool/reasoning/output translator aggregate bounds;
5. continuation/replay count + TTL + per-entry + aggregate bytes;
6. durable spill ordering and explicit missing/corrupt replay semantics;
7. content/blob cache provenance, per-entry bytes, aggregate bytes, TTL/LRU;
8. diagnostic rings: count and value-byte bounds;
9. stale-key TTL sweep and config-generation reconciliation;
10. active turns/sockets/workers/flights admission caps;
11. serialized-tail/backlog admission;
12. background process/session lifecycle;
13. process-wide retained-store byte budget and deterministic demotion order;
14. observe-only, privacy-safe app-owned byte metrics;
15. security boundary for secret-file atomic writes/ACL memo lifecycle;
16. normal 20+ parallel tool-call acceptance without truncation.

## Competitor matrix — frozen 2026-08-01

| Category | OpenCodex | Portkey | Claude Code Router | mcp-proxy | LiteLLM | one-api |
|---|---|---|---|---|---|---|
| 1. Request admission | PASS | FAIL | FAIL | FAIL | UNKNOWN | UNKNOWN |
| 2. Disconnect abort | PASS | UNKNOWN | PASS | UNKNOWN | UNKNOWN | UNKNOWN |
| 3. Stream/frame queue | PASS | FAIL | PARTIAL | FAIL | UNKNOWN | UNKNOWN |
| 4. Translator aggregate | PASS | UNKNOWN | PARTIAL | N/A | UNKNOWN | UNKNOWN |
| 5. Continuation dimensions | PASS | N/A | PASS | PASS | UNKNOWN | N/A |
| 6. Spill + explicit replay miss | PASS | N/A | PASS | PARTIAL | UNKNOWN | UNKNOWN |
| 7. Blob/cache dimensions | PASS | PARTIAL | N/A | N/A | PARTIAL | FAIL |
| 8. Diagnostic value bytes | PASS | UNKNOWN | PASS | N/A | UNKNOWN | UNKNOWN |
| 9. Expiry/reconciliation | PASS | PARTIAL | PASS | N/A | UNKNOWN | UNKNOWN |
| 10. Active admission | PASS | UNKNOWN | FAIL | FAIL | UNKNOWN | PARTIAL |
| 11. Tail admission | PASS | UNKNOWN | PASS | N/A | UNKNOWN | UNKNOWN |
| 12. Background lifecycle | PASS | N/A | PASS | PARTIAL | UNKNOWN | UNKNOWN |
| 13. Global retained budget | PASS | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |
| 14. App-byte observability | PASS | PARTIAL | PARTIAL | PARTIAL | UNKNOWN | UNKNOWN |
| 15. Secret-file hardening | PASS | FAIL | PASS | N/A | UNKNOWN | UNKNOWN |
| 16. 20+ call acceptance | PASS | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |

OpenCodex summary: **16 PASS, 0 PARTIAL, 0 FAIL, 0 UNKNOWN**.

For LiteLLM and one-api, `UNKNOWN` means the frozen context report supplied no
category-specific implementation anchor. LiteLLM’s optional stream-duration guard is
disabled by default and does not prove a frame/producer-queue bound, so category 3 remains
`UNKNOWN`; its finite generic cache is `PARTIAL` because the supplied evidence does not
establish content/blob provenance. one-api’s disabled-by-default memory cache becomes
unbounded when enabled, while its rate limiter bounds each key but not key cardinality.

## Per-competitor evidence rows

### OpenCodex

| Category | Verdict | Commit | File/function | Source URL | Exact bound/behavior | Test URL | Caveat |
|---|---|---|---|---|---|---|---|
| 1 | PASS | `17faddd24` | `readBoundedJsonRequestBody`; management body reader | <https://github.com/lidge-jun/opencodex/blob/17faddd24/src/server/request-decompress.ts#L88-L131> | Honest declarations are rejected before `arrayBuffer`; data-plane is 256 MiB and management JSON is 4 MiB, with post-read/decompression enforcement for lying or absent lengths. | <https://github.com/lidge-jun/opencodex/blob/17faddd24/tests/request-decompress.test.ts#L102-L128> | Request buffering still occurs for undeclared bodies, but the finite cap is enforced immediately after read. |
| 2 | PASS | `17faddd24` | active-turn abort ownership | <https://github.com/lidge-jun/opencodex/blob/17faddd24/src/server/lifecycle.ts#L28-L75> | Each admitted turn owns abort controllers and releases them deterministically. | <https://github.com/lidge-jun/opencodex/blob/17faddd24/tests/passthrough-abort.test.ts#L92-L128> | Translation and relay paths share the lifecycle contract. |
| 3 | PASS | `17faddd24` | adapter queue/preflight and translator frame constants | <https://github.com/lidge-jun/opencodex/blob/17faddd24/src/adapters/run-turn-queue.ts#L5-L80> | Queue backlog defaults to 1,024 and preflight retains at most 16 leading heartbeats; SSE/Cursor frames have explicit byte caps. | <https://github.com/lidge-jun/opencodex/blob/17faddd24/tests/run-turn-queue.test.ts#L106-L115> | Heartbeats are lossy before the first material event by design. |
| 4 | PASS | `17faddd24` | `TranslatorBudget` | <https://github.com/lidge-jun/opencodex/blob/17faddd24/src/lib/translator-budget.ts#L1-L6> | Tool arguments are 2 MiB each and aggregate turn/SSE limits are 32 MiB with typed overflow. | <https://github.com/lidge-jun/opencodex/blob/17faddd24/tests/translator-budget.test.ts#L20-L37> | Translation-duty category. |
| 5 | PASS | `17faddd24` | Responses continuation store | <https://github.com/lidge-jun/opencodex/blob/17faddd24/src/responses/state.ts#L16-L25> | One-hour TTL, count cap, per-entry snapshot cap, 24 MiB snapshot cap, and 64 MiB resident aggregate cap. | <https://github.com/lidge-jun/opencodex/blob/17faddd24/tests/responses-state.test.ts#L1260-L1305> | Translation/replay duty. |
| 6 | PASS | `17faddd24` | response spill durable publish/read/delete | <https://github.com/lidge-jun/opencodex/blob/17faddd24/src/responses/spill-store.ts#L250-L325> | File fsync precedes no-replace publish, directory fsync follows publish/unlink, and replay distinguishes `missing` from `corrupt`. | <https://github.com/lidge-jun/opencodex/blob/17faddd24/tests/responses-state.test.ts#L604-L618> | Directory fsync is best-effort on filesystems/Windows handles that reject it. |
| 7 | PASS | `17faddd24` | Cursor content-addressed blob store | <https://github.com/lidge-jun/opencodex/blob/17faddd24/src/adapters/cursor/native-exec.ts#L80-L125> | Provenance-aware blobs have 15-minute TTL, 16 MiB per entry, and 64 MiB aggregate eviction. | <https://github.com/lidge-jun/opencodex/blob/17faddd24/tests/cursor-blob.test.ts#L850-L881> | Provider-specific content store. |
| 8 | PASS | `17faddd24` | provider/injection diagnostic rings | <https://github.com/lidge-jun/opencodex/blob/17faddd24/src/lib/debug-log-buffer.ts#L10-L34> | Rings retain 2,000 entries and truncate each retained UTF-8 value to 16 KiB. | <https://github.com/lidge-jun/opencodex/blob/17faddd24/tests/debug.test.ts#L135-L153> | Boundary suite also covers UTF-8 truncation markers at lines 207–225. |
| 9 | PASS | `17faddd24` | global state-store registrations | <https://github.com/lidge-jun/opencodex/blob/17faddd24/src/lib/state-store-registrations.ts#L75-L100> | Continuation and Antigravity replay TTL owners are registered alongside generation reconcilers. | <https://github.com/lidge-jun/opencodex/blob/17faddd24/tests/state-store-sweeper.test.ts#L75-L129> | Inventory test is intentionally hand-maintained to expose omissions. |
| 10 | PASS | `17faddd24` | active turn and resource admission gates | <https://github.com/lidge-jun/opencodex/blob/17faddd24/src/server/lifecycle.ts#L28-L75> | Active turns cap at 256; sockets, workers, flights, and background shells have separate finite gates. | <https://github.com/lidge-jun/opencodex/blob/17faddd24/tests/active-registry-admission.test.ts#L28-L90> | Caps are resource-specific rather than one global concurrency scalar. |
| 11 | PASS | `17faddd24` | OAuth/image serialized tails and Grok apply flight | <https://github.com/lidge-jun/opencodex/blob/17faddd24/src/oauth/store.ts#L318-L423> | Pending mutation/image work has finite admission and timeout; a Grok singleton is joinable for 120 s, busy until 10 min, then replaceable by identity. | <https://github.com/lidge-jun/opencodex/blob/17faddd24/tests/grok-management-api.test.ts#L59-L103> | The repair closes indefinitely pinned singleton-flight state. |
| 12 | PASS | `17faddd24` | Cursor background shell lifecycle | <https://github.com/lidge-jun/opencodex/blob/17faddd24/src/adapters/cursor/native-exec-shell.ts#L287-L400> | Session ownership, idle/absolute timers, close confirmation, shutdown, and admission lease release are explicit. | <https://github.com/lidge-jun/opencodex/blob/17faddd24/tests/cursor-native-exec-shell.test.ts#L197-L320> | Direct-child close, not kill request alone, releases ownership. |
| 13 | PASS | `17faddd24` | app-owned memory controller | <https://github.com/lidge-jun/opencodex/blob/17faddd24/src/lib/app-owned-memory.ts#L43-L59> | 256 MiB eviction target, deterministic category order, and explicit 512 MiB worst-case pinned ceiling contract. | <https://github.com/lidge-jun/opencodex/blob/17faddd24/tests/app-owned-memory.test.ts#L82-L97> | The hard ceiling is a contract over independently capped pin-capable owners, not an RSS limit. |
| 14 | PASS | `17faddd24` | management system metrics | <https://github.com/lidge-jun/opencodex/blob/17faddd24/src/server/management/system-routes.ts#L75-L99> | Observe-only app-owned snapshots expose retained/evictable/pinned bytes without request bodies or identifiers. | <https://github.com/lidge-jun/opencodex/blob/17faddd24/tests/app-owned-memory.test.ts#L92-L97> | App-owned bytes are not total process RSS. |
| 15 | PASS | `17faddd24` | Windows secret ACL hardening | <https://github.com/lidge-jun/opencodex/blob/17faddd24/src/lib/windows-secret-acl.ts#L387-L427> | Required writes fail closed on timeout, including memo hits; atomic publication is prevented and the temp is scrubbed. | <https://github.com/lidge-jun/opencodex/blob/17faddd24/tests/windows-secret-acl.test.ts#L295-L318> | Optional read probes may still soft-fail. |
| 16 | PASS | `17faddd24` | OpenAI Chat parallel stream assembly | <https://github.com/lidge-jun/opencodex/blob/17faddd24/src/adapters/openai-chat.ts#L685-L718> | Index-keyed interleaved calls are assembled without a small arbitrary call-count truncation. | <https://github.com/lidge-jun/opencodex/blob/17faddd24/tests/openai-chat-parallel-stream.test.ts#L50-L67> | Boundary test accepts 24 interleaved calls. |

### Portkey Gateway

| Category | Verdict | Commit | File/function | Source URL | Exact bound/behavior | Test URL | Caveat |
|---|---|---|---|---|---|---|---|
| 1 | FAIL | `669825cbe` | `chatCompletionsHandler` | <https://github.com/Portkey-AI/gateway/blob/669825cbe89ee51569918b8f78a9db486fd69dd4/src/handlers/chatCompletionsHandler.ts#L12-L24> | Calls `c.req.json()` without a pre-allocation body gate. | n/a | No boundary test was identified in the frozen report. |
| 2 | UNKNOWN | `669825cbe` | retry timer abort | <https://github.com/Portkey-AI/gateway/blob/669825cbe89ee51569918b8f78a9db486fd69dd4/src/handlers/retryHandler.ts#L4-L49> | A timer abort exists, but the report did not establish client-disconnect ownership. | n/a | Ambiguity stays UNKNOWN. |
| 3 | FAIL | `669825cbe` | stream accumulation | <https://github.com/Portkey-AI/gateway/blob/669825cbe89ee51569918b8f78a9db486fd69dd4/src/handlers/streamHandler.ts#L61-L207> | Stream frames/arrays are accumulated without a finite byte or queue contract. | n/a | Relay path. |
| 7 | PARTIAL | `669825cbe` | cache service and memory backend | <https://github.com/Portkey-AI/gateway/blob/669825cbe89ee51569918b8f78a9db486fd69dd4/src/shared/services/cache/index.ts#L342-L391> | Count and TTL controls exist, but no per-entry or aggregate byte budget was found. | n/a | Cache provenance/byte dimensions are incomplete. |
| 9 | PARTIAL | `669825cbe` | `MemoryCacheBackend.cleanup` | <https://github.com/Portkey-AI/gateway/blob/669825cbe89ee51569918b8f78a9db486fd69dd4/src/shared/services/cache/backends/memory.ts#L195-L219> | Periodic expiry cleanup exists; config-generation reconciliation was not established. | n/a | Cleanup is cache-local. |
| 14 | PARTIAL | `669825cbe` | cache `getStats` | <https://github.com/Portkey-AI/gateway/blob/669825cbe89ee51569918b8f78a9db486fd69dd4/src/shared/services/cache/backends/memory.ts#L170-L192> | Statistics expose counts, not app-owned retained bytes. | n/a | Not a process-wide observe-only byte metric. |
| 15 | FAIL | `669825cbe` | `FileCacheBackend` | <https://github.com/Portkey-AI/gateway/blob/669825cbe89ee51569918b8f78a9db486fd69dd4/src/shared/services/cache/backends/file.ts#L65-L95> | Directory/file creation and writes do not set restrictive modes or an ACL hardening boundary. | n/a | Cache file, not necessarily a secret file; scored against the category’s file-security contract. |

Portkey `N/A` cells are categories 5, 6, and 12 from the frozen report. Categories
4, 8, 10, 11, 13, and 16 remain `UNKNOWN` because the report supplied no exact
category-specific implementation proof.

### Claude Code Router

| Category | Verdict | Commit | File/function | Source URL | Exact bound/behavior | Test URL | Caveat |
|---|---|---|---|---|---|---|---|
| 1 | FAIL | `4a152d959` | `readRequestBody` | <https://github.com/musistudio/claude-code-router/blob/4a152d959c016b476220339e856c9f4f94624c42/packages/core/src/gateway/http/io.ts#L290-L317> | Reads the request body before a finite pre-allocation admission check. | <https://github.com/musistudio/claude-code-router/blob/4a152d959c016b476220339e856c9f4f94624c42/packages/core/test/unit/gateway/http-boundary.test.mjs> | Existing HTTP boundary tests do not prove pre-allocation rejection. |
| 2 | PASS | `4a152d959` | request pipeline abort wiring | <https://github.com/musistudio/claude-code-router/blob/4a152d959c016b476220339e856c9f4f94624c42/packages/core/src/gateway/request/pipeline.ts#L201-L228> | Client disconnect aborts upstream work. | <https://github.com/musistudio/claude-code-router/blob/4a152d959c016b476220339e856c9f4f94624c42/packages/core/test/integration/gateway/gateway-client-disconnect.test.mjs> | Directly tested. |
| 3 | PARTIAL | `4a152d959` | HTTP piping/sampler | <https://github.com/musistudio/claude-code-router/blob/4a152d959c016b476220339e856c9f4f94624c42/packages/core/src/gateway/http/io.ts#L290-L317> | Piping limits retention in the common path and an 8 MiB sampler exists, but no complete producer-queue byte contract was established. | <https://github.com/musistudio/claude-code-router/blob/4a152d959c016b476220339e856c9f4f94624c42/packages/core/test/unit/gateway/http-boundary.test.mjs> | Common-path streaming is stronger than unbounded collection, but incomplete for this category. |
| 4 | PARTIAL | `4a152d959` | translation loop | <https://github.com/musistudio/claude-code-router/blob/4a152d959c016b476220339e856c9f4f94624c42/packages/core/src/gateway/request/pipeline.ts> | A four-iteration limit exists, but an `arrayBuffer` path lacks an aggregate translator-byte contract. | n/a | Iteration count is not an aggregate byte bound. |
| 5 | PASS | `4a152d959` | context archive | <https://github.com/musistudio/claude-code-router/blob/4a152d959c016b476220339e856c9f4f94624c42/packages/core/src/gateway/context-archive.ts#L130-L169> | Continuation archive has TTL, count, per-entry, and aggregate-byte controls. | <https://github.com/musistudio/claude-code-router/blob/4a152d959c016b476220339e856c9f4f94624c42/packages/core/test/unit/agents/context-archive.test.mjs> | Translation/replay duty. |
| 6 | PASS | `4a152d959` | context archive store | <https://github.com/musistudio/claude-code-router/blob/4a152d959c016b476220339e856c9f4f94624c42/packages/core/src/gateway/context-archive/store.ts#L174-L230> | SQLite BLOB storage has explicit miss states and replay depth 32. | <https://github.com/musistudio/claude-code-router/blob/4a152d959c016b476220339e856c9f4f94624c42/packages/core/test/unit/agents/context-archive.test.mjs> | Durable DB-backed spill. |
| 8 | PASS | `4a152d959` | route trace | <https://github.com/musistudio/claude-code-router/blob/4a152d959c016b476220339e856c9f4f94624c42/packages/core/src/observability/route-trace.ts> | Route traces cap retained diagnostic value bytes at 256 KiB. | <https://github.com/musistudio/claude-code-router/blob/4a152d959c016b476220339e856c9f4f94624c42/packages/core/test/unit/observability/route-trace.test.mjs> | Diagnostic-specific. |
| 9 | PASS | `4a152d959` | context archive TTL reload | <https://github.com/musistudio/claude-code-router/blob/4a152d959c016b476220339e856c9f4f94624c42/packages/core/src/gateway/context-archive/store.ts#L174-L230> | A one-second TTL reload/sweep path was found and tested. | <https://github.com/musistudio/claude-code-router/blob/4a152d959c016b476220339e856c9f4f94624c42/packages/core/test/unit/agents/context-archive.test.mjs> | Scoped to the archive owner. |
| 10 | FAIL | `4a152d959` | gateway request pipeline | <https://github.com/musistudio/claude-code-router/blob/4a152d959c016b476220339e856c9f4f94624c42/packages/core/src/gateway/request/pipeline.ts> | No finite active-request concurrency cap was found. | n/a | Other local caps do not substitute for active admission. |
| 11 | PASS | `4a152d959` | request-log admission store | <https://github.com/musistudio/claude-code-router/blob/4a152d959c016b476220339e856c9f4f94624c42/packages/core/src/observability/request-log-limits.ts> | Request logs enforce 128 MiB, 2,000/20,000 count controls, and TTL. | <https://github.com/musistudio/claude-code-router/blob/4a152d959c016b476220339e856c9f4f94624c42/packages/core/test/integration/observability/request-log-store.test.mjs> | Serialized observability backlog. |
| 12 | PASS | `4a152d959` | core runtime supervisor | <https://github.com/musistudio/claude-code-router/blob/4a152d959c016b476220339e856c9f4f94624c42/packages/core/src/gateway/core-runtime/supervisor.ts> | Managed child ownership and teardown are explicit. | <https://github.com/musistudio/claude-code-router/blob/4a152d959c016b476220339e856c9f4f94624c42/packages/core/test/unit/gateway/gateway-runtime-change.test.mjs> | Background runtime lifecycle. |
| 14 | PARTIAL | `4a152d959` | request-log/route-trace stats | <https://github.com/musistudio/claude-code-router/blob/4a152d959c016b476220339e856c9f4f94624c42/packages/core/src/observability/request-log-store.ts> | Some bounded owners expose statistics, but no complete process-wide app-owned byte snapshot was established. | <https://github.com/musistudio/claude-code-router/blob/4a152d959c016b476220339e856c9f4f94624c42/packages/core/test/integration/observability/request-log-store.test.mjs> | Partial observability only. |
| 15 | PASS | `4a152d959` | context archive store files | <https://github.com/musistudio/claude-code-router/blob/4a152d959c016b476220339e856c9f4f94624c42/packages/core/src/gateway/context-archive/store.ts#L174-L230> | Directory/file modes are explicitly 0700/0600. | <https://github.com/musistudio/claude-code-router/blob/4a152d959c016b476220339e856c9f4f94624c42/packages/core/test/unit/agents/context-archive.test.mjs> | POSIX mode contract; Windows ACL parity was not claimed. |

Claude Code Router category 7 is `N/A`; categories 13 and 16 remain `UNKNOWN` because
the frozen report did not establish a global retained budget or 20+ parallel-call boundary.

### punkpeye mcp-proxy

| Category | Verdict | Commit | File/function | Source URL | Exact bound/behavior | Test URL | Caveat |
|---|---|---|---|---|---|---|---|
| 1 | FAIL | `e298da803` | `getBody` | <https://github.com/punkpeye/mcp-proxy/blob/e298da80322da0a1d1edcf5c83be00bd103ad43a/src/startHTTPServer.ts#L58-L75> | Buffers the body without a pre-allocation admission gate. | <https://github.com/punkpeye/mcp-proxy/blob/e298da80322da0a1d1edcf5c83be00bd103ad43a/src/startHTTPServer.test.ts> | MCP relay. |
| 3 | FAIL | `e298da803` | `JSONFilterTransform` | <https://github.com/punkpeye/mcp-proxy/blob/e298da80322da0a1d1edcf5c83be00bd103ad43a/src/JSONFilterTransform.ts#L12-L37> | Transform accumulates JSON without a finite frame/producer-queue byte bound. | <https://github.com/punkpeye/mcp-proxy/blob/e298da80322da0a1d1edcf5c83be00bd103ad43a/src/JSONFilterTransform.test.ts> | Pure relay transform. |
| 5 | PASS | `e298da803` | `InMemoryEventStore` | <https://github.com/punkpeye/mcp-proxy/blob/e298da80322da0a1d1edcf5c83be00bd103ad43a/src/InMemoryEventStore.ts> | Event store is a 1,000-entry FIFO with direct boundary tests. | <https://github.com/punkpeye/mcp-proxy/blob/e298da80322da0a1d1edcf5c83be00bd103ad43a/src/InMemoryEventStore.test.ts> | Count-only replay appropriate to the MCP event-store duty; no translator continuation claim. |
| 6 | PARTIAL | `e298da803` | `InMemoryEventStore` | <https://github.com/punkpeye/mcp-proxy/blob/e298da80322da0a1d1edcf5c83be00bd103ad43a/src/InMemoryEventStore.ts> | Explicit miss behavior exists, but RAM is the default and there is no durable spill ordering contract. | <https://github.com/punkpeye/mcp-proxy/blob/e298da80322da0a1d1edcf5c83be00bd103ad43a/src/InMemoryEventStore.test.ts> | Partial by design. |
| 10 | FAIL | `e298da803` | transport registry | <https://github.com/punkpeye/mcp-proxy/blob/e298da80322da0a1d1edcf5c83be00bd103ad43a/src/startHTTPServer.ts#L1055-L1064> | Transport creation has no finite active admission cap. | <https://github.com/punkpeye/mcp-proxy/blob/e298da80322da0a1d1edcf5c83be00bd103ad43a/src/startHTTPServer.test.ts> | Session focus does not remove active-resource ownership. |
| 12 | PARTIAL | `e298da803` | HTTP/session shutdown | <https://github.com/punkpeye/mcp-proxy/blob/e298da80322da0a1d1edcf5c83be00bd103ad43a/src/startHTTPServer.ts> | Owned sessions are closed, but the shared stdio client is not closed by the same lifecycle. | <https://github.com/punkpeye/mcp-proxy/blob/e298da80322da0a1d1edcf5c83be00bd103ad43a/src/startHTTPServer.test.ts> | Shared-client ownership remains ambiguous. |
| 14 | PARTIAL | `e298da803` | event-store size | <https://github.com/punkpeye/mcp-proxy/blob/e298da80322da0a1d1edcf5c83be00bd103ad43a/src/InMemoryEventStore.ts> | Size is observable as a count only, not privacy-safe retained bytes. | <https://github.com/punkpeye/mcp-proxy/blob/e298da80322da0a1d1edcf5c83be00bd103ad43a/src/InMemoryEventStore.test.ts> | Not process-wide. |

mcp-proxy categories 4, 7, 8, 9, 11, and 15 are `N/A` in the frozen report.
Categories 2, 13, and 16 remain `UNKNOWN` because no exact evidence established those
contracts.

### LiteLLM and one-api context

| Competitor | Category | Verdict | Commit | File/function | Source URL | Exact bound/behavior | Test URL | Caveat |
|---|---|---|---|---|---|---|---|---|
| LiteLLM | 3 | UNKNOWN | `23de7a15d` | `_check_max_streaming_duration` | <https://github.com/BerriAI/litellm/blob/23de7a15d9d40006ee596e617475ba101d60c5e9/litellm/responses/streaming_iterator.py#L166-L176> | Optional maximum stream duration exists but is disabled when unset and does not prove a frame/queue byte bound. | n/a | Adjacent guard only; category remains UNKNOWN. |
| LiteLLM | 7 | PARTIAL | `23de7a15d` | `InMemoryCache` | <https://github.com/BerriAI/litellm/blob/23de7a15d9d40006ee596e617475ba101d60c5e9/litellm/caching/in_memory_cache.py#L28-L44> | Defaults to 200 items, 600 s TTL, and 1 MiB per item; eviction is implemented at lines 102–138. | <https://github.com/BerriAI/litellm/blob/23de7a15d9d40006ee596e617475ba101d60c5e9/tests/test_litellm/caching/test_in_memory_cache.py> | Generic cache evidence does not establish content/blob provenance for this category. |
| LiteLLM | 7 | historical only | n/a | issue 6404 | <https://github.com/BerriAI/litellm/issues/6404> | Reopened issue was closed by automation on 2025-05-26 as `not_planned`. | n/a | Weak closure evidence; not used to upgrade the implementation verdict. |
| one-api | 5 | N/A | `8df4a2670` | token cache fallback | <https://github.com/songquanpeng/one-api/blob/8df4a2670b98266bd287c698243fff327d9748cf/middleware/cache.go#L28-L73> | Token state uses Redis, otherwise DB; it is not an in-process continuation/replay store. | n/a | External state is not app-owned RAM. |
| one-api | 7 | FAIL | `8df4a2670` | memory-cache configuration/model cache | <https://github.com/songquanpeng/one-api/blob/8df4a2670b98266bd287c698243fff327d9748cf/model/cache.go#L170-L233> | Memory cache is off by default, but when enabled it has no finite count or byte budget. | n/a | Default-off posture does not make the enabled contract finite. |
| one-api | 10 | PARTIAL | `8df4a2670` | in-memory rate limiter | <https://github.com/songquanpeng/one-api/blob/8df4a2670b98266bd287c698243fff327d9748cf/common/rate-limit.go#L8-L69> | Each key is bounded, but key cardinality is unbounded. | n/a | Partial active/admission-related local control, not a process-wide active-resource cap. |

All other LiteLLM and one-api cells are `UNKNOWN`: the supplied non-TypeScript context
reports did not provide exact category-specific implementation evidence, so they are not
silently converted to `N/A`, `FAIL`, or `PASS`.

## Gap-list gate

The eight pre-gap-closure `PARTIAL` OpenCodex categories were re-opened at
`17faddd24`:

- category 1: pre-allocation declaration admission plus bounded management bodies;
- category 3: 16-entry preflight-heartbeat tail plus queue/frame boundary tests;
- category 6: directory fsync after spill publish and unlink;
- category 8: exact count and UTF-8 value-byte ring boundaries;
- category 9: continuation and Antigravity sweeper registrations plus inventory test;
- category 11: Grok apply terminal deadline and identity-safe replacement;
- category 13: 512 MiB worst-case pinned ceiling contract plus cap-sum test;
- category 15: required ACL timeout fail-closed through atomic-publication tests.

Each now has landed production code and a focused negative/boundary test. No competitor
has a materially stronger finite contract in a category where OpenCodex is below `PASS`.

Open gap count: 0

## Superiority-claim decision

Superiority statement: **omitted**. The 2026-08-01 TypeScript cohort still contains
`UNKNOWN` cells for Portkey Gateway, Claude Code Router, and mcp-proxy. Per the rule,
the matrix is published without the broad theoretical/app-owned superiority sentence.
LiteLLM and one-api remain non-TypeScript context only.

## Superiority-claim rule

No claim may appear in `005`, release notes, README, social copy, or PR description
before this table is complete. After the empty-gap gate:

- category claims may say “stronger than the surveyed proxies in category X” only when
  every competitor has opened evidence and OpenCodex is strictly stronger there;
- the broad claim “strongest theoretical no-leak posture among surveyed production
  TypeScript LLM proxies” requires no `UNKNOWN` cells in that cohort and no category
  where a competitor is stronger;
- never claim “leak-free,” zero RSS growth, or stronger than projects outside the frozen
  cohort;
- name survey date, cohort, and theoretical/app-owned scope in the sentence;
- if evidence is mixed, publish the matrix and omit the superiority sentence.

## wp7 completion checklist

- [x] Freeze competitor repository SHAs/tags and source-open date.
- [x] Replace every source `TBD` with commit-pinned URLs or mark `UNKNOWN` with reason.
- [x] Re-open landed OpenCodex source/tests; do not score from roadmap prose.
- [x] Complete all 16 category rows and per-competitor evidence rows.
- [x] Resolve cohort consistency for LiteLLM/one-api versus TypeScript-only headline.
- [x] Record and close/phase every gap.
- [x] Record `Open gap count: 0`.
- [x] Add the one permitted scoped superiority statement, or explicitly omit it.

## Commit

`docs(devlog): record zero-leak proxy benchmark evidence`

## Explicitly not changed

- No runtime, test, config, dependency, benchmark harness, release, or provider behavior
  changes in this document.
- No popularity, star count, or throughput result is treated as a retention guarantee.
- No claim is made about RSS growth or projects outside the frozen cohort.
