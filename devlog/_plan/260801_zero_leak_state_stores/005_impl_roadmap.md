# Zero-leak state stores — implementation roadmap

Opened 2026-08-01. Consumes `000_state_store_inventory.md` (36 stores, verdicts)
and the prior unit's stream-path work (260731_macos_rss_retention, landed).
Push to origin/dev is user-authorized for this unit.

## Design goal

Among production TS-based LLM proxies on GitHub, opencodex should have the
strongest theoretical no-leak posture — while carrying translation duty
(bidirectional tool conversion, MCP namespace flatten/restore, image
normalization, reasoning-signature carry) that pure relays do not have.
The competitive evidence (060) defines "strongest" per category; the phases
below close every UNBOUNDED and the material CONDITIONALLY-UNBOUNDED verdicts.

## External evidence (Luna lanes, source-opened 2026-08-01)

- Portkey Gateway: no post-stream replay state, but NO upstream abort on client
  disconnect and unbounded local transform buffers (streamHandler.ts,
  streamHandlerUtils.ts). No process-wide byte budget.
- Claude Code Router: per-request AbortController + upstream cancel (good);
  context-archive store enforces TTL+count+aggregate-body-bytes (the only
  competitor with a 3-dimension eviction contract).
- mcp-proxy (punkpeye): replay event store FIFO 1,000 events, no TTL/bytes;
  session map cleanup only on transport close.
- LiteLLM: added per-entry max cache item size (v1.63.14) after OOMs;
  streaming retention issue #6404 open. one-api: externalizes state
  (Redis/DB), memory cache default off.
- Eviction-contract precedent: lru-cache maxSize+maxEntrySize+TTL+LRU;
  cacache for content-addressed disk spill (eviction separate).

Conclusion: no surveyed TS proxy has a process-wide app-owned byte budget.
Landing one (wp5) plus per-store byte caps positions opencodex to be stronger
than every surveyed competitor — a claim that stays PROVISIONAL until 060
supplies the full source ledger (audit round 1).

## Phase map (dependency-ordered; one decade doc per work-phase)

| Doc | WP | Content | Depends |
|---|---|---|---|
| `010_continuation_hard_cap.md` | wp2 | continuation last-entry cap hole → true hard cap; oversized entries demote to disk stub ONLY after atomic per-entry spill (fsync + no-replace publication); missing/corrupt spill = explicit continuation failure, never silent naked-delta (R1-2); contract redefinition | — |
| `020_blob_and_replay_caps.md` | wp3 | Cursor blob byte cap split by PROVENANCE (local-regenerated evictable, remote-origin pinned within TTL — R1-3), Antigravity inner-call bounds, vision-LRU clamp-before-insert, image zero-weight sentinel accounting (R1-1) | — |
| `030_eviction_mechanisms.md` | wp4 | store-by-store cleanup matrix with three mechanisms: TTL sweep / config-generation reconciliation / admission caps (R1-4). Covers: subagent quota-failure records, key/combo cooldowns, provider+codex quota history, routing health, warning memos, model-cache provider history, pool/combo history, XAI verdicts, guardian backoff, GCP source tokens, ownership/PID memos, OAuth/reauth reconciliation. Windows ACL memo: eviction-after-rename keyed by actual temp path, NO destination-level reuse (R1-5); explicit security review required | — |
| `035_registry_admission_caps.md` | wp4b | remaining operational registries/flights: debug-subscriber count cap, active turns/sockets/workers hard admission CAP (reject beyond cap with a coherent busy error — S3-3) + leak metric, credential-refresh flights bounded distinct-grant admission (cap on concurrent grant fingerprints) + staleness replacement (S3-3), usage-read flight staleness guard PLUS bounded parse (stream/limit the full-log read so the in-flight value itself is byte-capped — S2-1), Cursor model-discovery response byte cap + gather-flight concurrency cap, OAuth pending-code value byte cap + auth flow/probe admission caps, MiMo JWT value byte cap, Cursor MCP manager payload caps, crash-ring + fixed-slot diagnostic + AFFINITY value-byte truncation (S2-2) | — |
| `040_app_bytes_observability.md` | wp5 | appOwnedBytes payload on /api/system/memory (continuation, blobs, rings, caches) + process-wide budget with oldest-first demotion contract | 010,020,035 (their accounting hooks; 030 provides sweeping only) |
| `050_translator_stream_bounds.md` | wp6 | per-stream translator caps for ALL inventory §Translator-layer accumulators: tool-arg aggregate bytes (adapters keep interleaving), Responses→Chat/Claude output collectors, Kiro deferred/text state, reasoning carry, item-ID maps, tool-search sources, request-direction copy high-water, cursor producer queue backpressure + frame-size admission, image-retention/oauth/grok tail admission bounds | — (parallel-safe) |
| `055_background_shell_lifecycle.md` | wp6b | Cursor background-shell store (UNBOUNDED when enabled, R1-1): session ownership, max-live admission, idle/absolute lifetime, controlled termination | — (parallel-safe) |
| `060_proxy_benchmark.md` | wp7 | competitive comparison table with source URLs; per-category verdicts; gap list must be empty or converted to work-phases; superiority claims live ONLY here | 010–055 landed |
| `070_close_and_push.md` | wp8 | final gates, docs sync, push, HEAD parity | all |

### Budget scope split (second-audit R1-6)

The 040 process-wide budget governs EVICTABLE RETAINED stores only
(continuation, blobs, rings, caches). Translator per-stream buffers and
serialized-tail backlogs are OBSERVED (high-water fields in appOwnedBytes)
but never budget-evicted — in-flight conversion state cannot be evicted
coherently; it is bounded by 050's per-stream caps instead. With this split
050 is genuinely parallel to 040, and 040's dependency is on the accounting
hooks of 010/020/035 (030 provides sweeping only, no accounting interface).

### Store-by-store mechanism lock for 030 (S2-5)

| Store | Mechanism | Why |
|---|---|---|
| subagent quota-failure records | (a) TTL sweep | getters already treat expired rows as absent |
| key/combo cooldowns | (a) TTL sweep | same |
| Anthropic routing health | (a) TTL sweep | same |
| XAI verdicts | (a) TTL sweep | 30 s TTL with exact-key lazy expiry today (S3-2); reconciliation would leave expired churn until config changes |
| warning-key memos (all) | (b) reconciliation ONLY | no expiry semantics; TTL would resurrect suppressed warnings |
| codex quota rows | (b) reconciliation ONLY | 6 h is disk-hydration admission, not a live TTL; live getters serve rows indefinitely (quota.ts:261/298) |
| provider quota history, model-cache provider history, pool/combo history, guardian backoff, GCP source tokens, ownership/PID memos, OAuth/reauth keys | (b) reconciliation | dead keys unreachable from current config/accounts |
| Windows ACL success memos | (c) delete-after-rename | R1-2 contract; destination re-keying forbidden |

Scope guards: provider adapter LOGIC unchanged (bounds are added at the
adapter-local accumulation sites without altering event semantics — the
"translation duty" stores are bounded, never deleted); #820 architecture
(turn lease/session lanes/scheduler) stays out; stream-path work from the
prior unit is not reopened.

## Locked design decisions

1. **Continuation (010):** keep the store authoritative for replay; single
   oversized entries spill to a DEDICATED per-entry file (not the debounced
   monolithic snapshot, which is async/best-effort/2 MiB-skipping — R1-2).
   Demotion ordering is locked: RAM row becomes a stub ONLY after an atomic
   successful spill (write-fsync + atomic NO-REPLACE publication — link or
   exclusive copy; plain rename replaces existing destinations and is
   unsuitable, 010 round-6). Spill FAILURE (disk permissions,
   exhaustion, I/O) evicts the row from RAM and records a small
   `spill-failed` tombstone for the response id: later continuation
   against it returns a terminal structured 400 telling the caller to resend
   the full context without `previous_response_id` — caller-driven recovery,
   not an automatic client fallback. Replay through a missing/
   corrupt stub likewise returns an EXPLICIT structured continuation error,
   never silent forwarding of the naked delta. The last-entry exemption is
   deleted; `storedResponseBytes > byteCap()` always spills or
   tombstone-evicts within a bounded in-flight window — the RAM cap is
   unconditionally hard.
   UNSAFE boundary: if spill-through cannot preserve replay, stop and report
   rather than truncating conversations.
2. **Blobs (020):** per-blob admission cap + aggregate byte cap with LRU;
   eviction split by provenance (R1-3): locally-regenerated blobs (root/turn,
   rebuilt each request per protobuf-request.ts) are LRU-evictable; REMOTE
   `setBlobArgs` blobs are pinned within TTL — evicted only at TTL expiry
   unless protocol-level re-send is proven by regression. The aggregate cap
   is enforced AT INSERT for every provenance: if admitting a remote
   blob would exceed the cap after evicting all evictable entries, the
   insert is REJECTED and the hash takes the explicit-miss path (identical
   protocol surface to an evicted-hash miss) — pinning orders eviction
   preference, it never overrides the cap. Explicit miss on
   evicted hash. Antigravity inner maps get count+byte bounds with
   clear-on-invalid preserved. Image zero-weight sentinels get key-byte
   accounting and a count cap (R1-1).
3. **Sweeper (030):** ONE shared `sweepExpired()` utility with per-store
   registration, run on a coarse timer (60 s, unref) and on store-write —
   but with THREE mechanism classes per the 030 matrix (R1-4): clock-TTL
   predicates, config-generation reconciliation for generation-owned keys,
   and admission caps for active resources. No behavior change for live keys.
   Windows ACL success memo: evict the temp-path row after rename completes;
   never let one temp's success vouch for another (R1-5, security review).
4. **Budget (040):** observability FIRST (appOwnedBytes payload), then a
   documented demotion contract: when the global budget is exceeded, evict
   oldest unpinned entries store-by-store in a fixed priority order
   (logs/rings → caches → blobs → continuation spill). Never reject new work
   admission as the first lever.
5. **Translator bounds (050):** aggregate-byte caps sized for 20+ parallel
   tool calls as NORMAL (per prior handoff): per-call args cap 2 MiB, per-turn
   aggregate 32 MiB, overflow FAILS the turn coherently (never truncated JSON).
   Cursor frame admission rejects announced sizes above cap before buffering.

## Open questions carried into phase docs

- 010: spill file naming/GC — per-entry content-addressed vs id-keyed files;
  orphan cleanup on startup. Decide in the phase doc after reading the disk
  path (the debounced snapshot is NOT reused for spill — locked, R1-2).
- 040: budget default size and config surface (fixed vs configurable).
- 050: which tails (image/oauth/grok) get admission caps vs busy-rejection.

## Regression-class requirements per phase (audit round 1)

- 010: spill durability-before-demotion; missing/
  corrupt spill → explicit error; spill-failure tombstone eviction + counter;
  restart replay; provider metadata + tool-
  result replay through stubs; replacement/TTL cleanup of spill files; orphan
  cleanup; concurrent flush/demotion; disk-permission failure.
- 020: local vs remote blob provenance; exact boundary admission; aggregate
  accounting; replacement/re-store LRU; explicit misses; Antigravity live-call
  preservation; image sentinel metadata accounting; pinned-saturation
  (remote blobs collectively at cap → new inserts rejected with explicit miss).
- 030: fake-clock global expiry; live-key preservation; generation
  reconciliation; timer singleton/unref/stop; write-trigger sweep; Windows
  repeated-temp ACL proof (second temp for same destination is re-hardened).
- 035: subscriber admission cap (rejects beyond cap, existing listeners
  unaffected); active-registry admission counter + leak metric monotonicity;
  active-registry HARD admission cap (beyond-cap request receives a coherent
  busy error, existing work unaffected — S3-3); flight staleness (a stuck
  flight is replaced, not joined, after the guard) plus bounded
  distinct-grant admission (concurrent grant fingerprints capped — S3-3);
  usage-read bounded parse (oversized log yields a capped result,
  not an unbounded in-flight value); discovery response byte cap +
  concurrent-gather cap; OAuth pending-code value cap + flow/probe admission;
  MiMo JWT byte cap; MCP payload caps; value-byte truncation for crash-ring,
  fixed-slot diagnostics, and affinity entries (truncated string still
  useful, marker appended).
- 040: observe-only metrics; exact replacement/eviction accounting; pinned/
  no-evictable fallback; single-entry-over-budget; privacy-safe payloads.
- 050: 20+ interleaved calls normal; per-call and aggregate boundaries;
  coherent overflow (no truncated JSON, turn fails); upstream cancellation;
  Cursor announced-frame rejection before allocation; queue ordering/
  backpressure; stalled-tail busy/admission.
- 055: max-live admission; idle + absolute lifetime termination; session
  ownership (no cross-session kill); controlled termination drains output;
  disabled-by-default posture unchanged.
