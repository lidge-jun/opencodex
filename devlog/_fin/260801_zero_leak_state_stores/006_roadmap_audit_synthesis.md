# 006 — roadmap audit synthesis

## Round 1 (reviewer Maxwell, FAIL 7) — adjudication

| # | Blocker | Decision | Action |
|---|---|---|---|
| R1-1 | Coverage gap: phases don't own every leak verdict (cursor shells, debug subscribers, pool/oauth/guardian history, ownership memos, active registries, MCP payloads, refresh flights, MiMo JWT, usage-read; translator accumulators beyond tool-args/cursor framing) | ACCEPT | 005 gains a full ownership matrix: every one of the 36 stores mapped to a phase OR given an explicit NON-MATERIAL (with why) / DEFERRED-#820 (with why) verdict. New phase 035 (registry & flight admission caps) absorbs the orphaned operational stores; 050 scope widened to ALL translator accumulators. |
| R1-2 | Windows ACL "keying fix" unsafe: success memo by destination could skip hardening future temps | ACCEPT | Remedy redefined: success on an ephemeral temp is NOT memoized persistently (removed after rename); destination-key memoization stays timeout-only, matching windows-secret-acl.ts:47 doctrine. Moved out of the sweeper phase into its own 030 sub-item with this exact contract. |
| R1-3 | Continuation disk path not reusable as spill-through (2 MiB skip / 24 MiB stop / debounced best-effort whole-snapshot / sync APIs) | ACCEPT | 010 redesigned: spill is a NEW per-entry content-addressed file write with durable-success-before-stub-swap transaction, defined read-miss contract (replay returns not-found → client falls back to full-context resend, same as TTL expiry today), and the legacy snapshot path untouched for small entries. UNSAFE boundary retained. |
| R1-4 | Crash ring BOUNDED verdict hides uncapped value strings; fixed-slot/affinity value bytes unaudited | ACCEPT | Inventory corrected (crash ring → CONDITIONALLY-UNBOUNDED, value-byte audit noted for fixed-slot diagnostics and affinity); 030/035 include value-byte truncation for retained diagnostic strings. |
| R1-5 | Universal 60 s sweeper unsafe for warning memos (no expiry, intentional suppress), codex quota rows (6 h is hydration-admission only; live getters return rows indefinitely), ACL memos | ACCEPT | 030 split into three mechanisms: (a) exact-expiry sweep only for stores whose getters already treat expired as absent; (b) config/account-generation reconciliation for keyed stores (drop keys no longer in current config/accounts — behavior-preserving because dead keys are unreachable); (c) ACL-specific contract per R1-2. Warning memos: reconciliation-only, never TTL. Codex quota rows: reconciliation-only, never TTL. |
| R1-6 | Dependency graph inconsistent: 040 claims a 030 accounting dependency that 030 doesn't provide; 050 not parallel-safe if the global budget includes translator buffers | ACCEPT | 040 depends on 010/020/035 accounting hooks (030 provides none); budget scope split: BUDGET covers evictable RETAINED stores only (continuation, blobs, rings, caches); translator per-stream buffers are OBSERVED (high-water in appOwnedBytes) but never budget-evicted (in-flight state can't be evicted coherently). With that split 050 is genuinely parallel. |
| R1-7 | "Strictly stronger in every category" premature before 060's table exists | ACCEPT | 005 conclusion reworded to a HYPOTHESIS the 060 gate must prove (empty-gap-list required); superiority claim removed until then. |

All seven accepted — no rebuttals. Re-audit with the same reviewer after amendments.

## Round 2 (reviewer Singer, FAIL 5) — adjudication (IDs S2-*)

| # | Blocker | Decision | Action |
|---|---|---|---|
| S2-1 | Ownership orphans: cursor discovery bytes/gather flights, OAuth pending-code values + auth flow/probe admission, usage-read value bytes (staleness guard ≠ byte bound) | ACCEPT | 035 scope extended to own all three explicitly (incl. bounded parse for usage-read so the in-flight value is byte-capped). |
| S2-2 | Crash-ring detail row still BOUNDED; affinity value-byte coverage promised but unrecorded | ACCEPT | Inventory detail row corrected to CONDITIONALLY-UNBOUNDED; 035 adds affinity value-byte truncation explicitly. |
| S2-3 | 040 dependency row still said 010,020,030 | ACCEPT | Phase-map row corrected to 010,020,035. |
| S2-4 | 035 had no regression-class requirements | ACCEPT | Regression classes added for every 035 item. |
| S2-5 | Inventory still recommended destination/generation ACL re-keying (twice); 030 mechanism assignment not locked store-by-store | ACCEPT | Both inventory sites rewritten to delete-after-rename with the doctrine citation; 005 gains the store-by-store mechanism lock table. |

All five accepted. Re-audit round 3.

## Round 3 (reviewer Singer, FAIL 4) — adjudication (IDs S3-*)

| # | Blocker | Decision | Action |
|---|---|---|---|
| S3-1 | 040 (wp5) sequenced before its dependency 035 (wp5b) | ACCEPT | 035 renumbered wp4b and moved above 040 in the phase map; execution order now satisfies the accounting-hook dependency. |
| S3-2 | XAI verdicts (30 s TTL, exact-key lazy expiry) wrongly under reconciliation | ACCEPT | Moved to mechanism (a) TTL sweep in the lock table. |
| S3-3 | Active registries "admission counter" and refresh flights "staleness guard" do not impose finite bounds | ACCEPT | 035 remedies upgraded: active turns/sockets/workers get a hard admission CAP (reject beyond cap with a coherent busy error) + leak metric; refresh flights get bounded distinct-grant admission (cap on concurrent distinct grant fingerprints) + staleness replacement. |
| S3-4 | Duplicate "Round 2" headings / colliding R2-* IDs in this file | ACCEPT | Rounds relabeled: implementation-review rounds from the PREVIOUS unit keep R*-; this unit's roadmap-audit rounds use S2-*/S3-*; roadmap references updated. |

## Round 2 (parallel reviewers Raman FAIL 5 / Godel FAIL 2) — adjudication

Raman's five findings substantially overlap Maxwell's round 1 (UNBOUNDED
coverage, spill safety, blob provenance, sweeper matrix, ACL keying) and are
already folded above. The two NET-NEW blockers from Godel:

| # | Blocker | Decision | Fix |
|---|---|---|---|
| R2-1 | 010: "spill failure keeps the row hot" contradicts the hard cap — a failing disk leaves oversized rows resident indefinitely | ACCEPT | Failure ladder locked: (1) spill success → stub swap; (2) spill FAILURE → the row is EVICTED from RAM and the response id records a small `spill-failed` tombstone; later continuation against that id returns the same explicit structured not-found/error contract as a corrupt spill (client falls back to full-context resend). Continuity is sacrificed only on real disk failure, surfaced via warning + counter — never silently. The RAM cap is unconditionally hard: every over-cap row spills or is tombstone-evicted within the bounded in-flight window. |
| R2-2 | 020: pinned remote blobs can collectively exceed the aggregate cap; pre-insert admission undefined; deferring to 040 invalid (040 depends on 020 accounting) | ACCEPT | Admission ladder locked in 020: the aggregate cap is enforced AT INSERT for every provenance. If inserting a remote blob would exceed the cap after evicting all evictable (local/TTL-expired) entries, the insert is REJECTED and the hash takes the explicit-miss path (identical protocol surface to an evicted-hash miss). Pinning orders eviction preference only — it never overrides the aggregate cap. Pinned-saturation regression added to 020's class list. |

Both preserve the structured-error-over-silent-corruption principle. 005
amended accordingly (failure ladder + admission ladder).

## wp2 A-gate (reviewer Banach, FAIL 5) — adjudication

| # | Blockers | Decision | Action |
|---|---|---|---|
| B1-B5 | Spill read lacked a trusted expected id; same-id/equal-size replacement collided and relied on non-portable rename-over-existing; automatic client fallback was unproven; resident measurement was incomplete/weightless on serialization failure; the 3 MiB restart fixture did not cross the 64 MiB spill threshold | ACCEPT | 010 now passes `responseId` into spill reads; uses payload-digest plus generation-distinct basenames and post-swap old-file unlink; defines caller-driven terminal structured 400 recovery; measures the complete retained payload in UTF-8 and tombstones serialization failures; lowers the test cap beneath spill fixtures; records all five current contract-test redefinitions, consumer seams, expanded regression classes, and process-crash-only durability. 005 receives the matching one-sentence recovery correction. |

## wp3 A-gate (Carson)

| # | Blocker | Decision | Action |
|---|---|---|---|
| B1 | Local provenance identified origin but not request-lifetime eviction safety; one request could advertise blobs evicted during its own construction | ACCEPT | 020 adds sealed per-request scope tokens carried into each live stream. Only selected external candidates enter the store; every advertised local blob is pinned through construction and hydration. Stream-scoped successful gets release only that request's key pin, and terminal cleanup releases leftovers exactly once. Provenance applies only after request pins clear. Infeasible construction throws a structured capacity error before any request or unstored hash reaches the wire. |
| B2 | The admission ladder mutated TTL/local victims before a later pinned-saturation rejection that claimed the store was unchanged | ACCEPT | 020 now requires two-phase admission: logically precompute eligible TTL removals, replacement, and oldest-local victims against byte and count limits; prove feasibility; then commit once. Any rejection preserves the complete map, bytes, recency, pins, counters, unrelated victims, and same-key predecessor byte-for-byte. |
| B3 | 020 incorrectly claimed `SetBlobResult` had no typed rejection field and underspecified the get-miss wire shape | ACCEPT | The plan records generated `SetBlobResult.error`/`Error.message`, returns that typed error for rejected remote sets, and locks get miss to the current request-id-preserving `KvClientMessage`/`getBlobResult` with optional `blobData` omitted. Hit, miss, and rejected-set-followed-by-miss wire tests are explicit. |
| B4 | 020 did not deliver executable 040 snapshot/eviction registrations for Antigravity, vision, or image normalization | ACCEPT | Exact owner exports are now named for all four stores. Every snapshot returns count, bytes, evictable bytes, pinned bytes, and oldest timestamp; every budget eviction returns exact released bytes and removes one complete owner-defined oldest row. |
| B5 | The vision single-entry-over-1-MiB test was unreachable after the 2,000-character clamp | ACCEPT | 020 adds a production-safe test-only description-cache limit override, restores production limits on reset, and replaces the fixture with small-limit single-entry non-retention plus exact multi-entry aggregate-boundary/oldest-eviction coverage. Existing Cursor, Antigravity, vision, and image-cache behavior tests and reset consumers are recorded for preservation or explicit redefinition. |

## wp3 A-gate round 2 (Avicenna, FAIL 4) — adjudication

| # | Blocker | Decision | Action |
|---|---|---|---|
| AV-1 | 040 snapshot/eviction exports defined only for Cursor; Antigravity/vision/image had metrics-only or unnamed hooks; oldestAt ambiguous | ACCEPT | 020 now names owner exports for ALL FOUR stores (cursorBlobRetainedStoreSnapshot/evictOldestCursorBlobForBudget, antigravityReplayRetainedStoreSnapshot/evictOldest…, vision + image equivalents) each returning count/bytes/evictableBytes/pinnedBytes/oldestAt with exact released-bytes eviction; Cursor oldestAt = storedAt of the exact next budget-eviction victim (oldest member of the evictable class incl. expired unpinned remote rows — refined round 4). |
| AV-2 | Same-key cross-provenance replacement could downgrade a live remote pin to evictable local | ACCEPT | Admission step 1 now merges provenance to the STRONGER class (remote wins; TTL clock kept on remote→local refresh, upgrade on local→remote); remote→local and local→remote regression tests named. |
| AV-3 | Oversized-vision-entry test unreachable (2000-char clamp < 1 MiB cap) | ACCEPT | setVisionDescriptionCacheLimitsForTests() override (production limits restored on undefined) + small-limit fixtures replace the unreachable case. |
| AV-4 | Vision clamp snippet left the first-use outcome unclamped, contradicting the byte-identical contract | ACCEPT | Snippet extended: successful outcome is replaced with the clamped text BEFORE resolveOutcome; regression asserts cache value and first-use outcome identical, error outcomes untouched. |

## wp4 A-gate (freshness auditor, FAIL 3) — adjudication

| # | Blocker | Decision | Action |
|---|---|---|---|
| WP4-A1 | `GenerationContext.comboIds` cannot reconcile deleted target weights inside a still-live combo; main-Codex and OAuth account-key inclusion/encoding are also undefined | ACCEPT | Added canonical `comboTargets` (`comboId::provider/model`), raw Codex ids with `__main__`, OAuth `provider\0accountId`, partial-target pruning, and regression coverage. |
| WP4-A2 | Post-commit reconciliation has no stale-writer fence, so accepted old-generation flights/requests can resurrect provider-quota, GCP, guardian, routing, combo, or reauth rows | ACCEPT | Added captured writer generation versus per-owner last-reconciled generation at every cited write site; stale deleted-key writes drop, live-key writes remain accepted, and late-completion regressions are required. |
| WP4-A3 | PID memo eviction requires process identity/liveness proof, but 030 names neither an owner export/call site nor its regressions | ACCEPT | Reclassified PID memos to `sweepDeadOcxStartProcessCache(64)`: timer-only round-robin probing, delete only on `process.kill(pid, 0)` `ESRCH`, with live/EPERM/unknown preservation and bounded-cost regressions. |

All three accepted and incorporated into 030. Re-audit verdict: **PASS**.

## wp4 C-review round 1 (Hegel, FAIL 6) — adjudication

| # | Blocker | Decision | Action |
|---|---|---|---|
| B1 | Reconciliation attempts reused a single generation value, so two overlapping sweeps could cross-accept each other's stale writes | ACCEPT | Sweeper issues a unique `attemptSequence` per reconciliation pass; per-owner last-reconciled generation compares against the exact issuing attempt. |
| B2 | Provider-quota rows were reconciled without the stale-writer fence, so an in-flight quota update could resurrect a deleted provider row post-sweep | ACCEPT | Quota store writes now capture writer generation and drop deleted-key commits like every other fenced owner. |
| B3 | Reauth fence was read before the topology snapshot, leaving a window where a reauth completing mid-sweep landed unfenced | ACCEPT | Each reauth write captures its own writer generation at write time and compares it against the owner's last-reconciled generation inside the reconcile mutation: stale writes for deleted accounts drop, writes for live account ids remain accepted regardless of generation. |
| B4 | Dead-process probe accepted PID 0/negative values, where `process.kill(0, 0)` signals the whole process group | ACCEPT | The sweep rechecks PID validity inside the serialized mutation and discards non-safe-integer/non-positive PIDs without probing; only validated positive PIDs are probed, and deletion still requires an `ESRCH` result. |
| B5 | Windows ACL memo release keyed off `existsSync` returning false, deleting the memo when the file was merely unreadable | ACCEPT | Memo release restricted to successful unlink or ENOENT (round 1 repair; tightened further after round 2). |
| B6 | Regression tests asserted sweep-ran flags rather than observable store state, giving false confidence | ACCEPT | Tests rewritten to assert row presence/absence and byte counts after sweep, not internal flags. |

Repair delta (13 files) verified: focused 387 pass, typecheck 0, privacy pass. Amended into `819450ac8`.

## wp4 C-review round 2 (Hegel, FAIL 2) — adjudication

| # | Blocker | Decision | Action |
|---|---|---|---|
| R2-B5 | `!io.exists(temp)` branches in `src/config.ts` (365–408) still treated a false existence check as proof of removal: unlink EPERM + `exists()` false returned "created", left the temp file on disk, and dropped the ACL memo count to zero | ACCEPT | Memo release now requires a completed rename/unlink or an unlink throwing ENOENT; existence predicates removed from every memo-release decision. Regression: simulated EPERM-with-exists-false asserts memo retention and non-success status. |
| R2-B6 | `comboTopologyGeneration` in `src/combos/resolve.ts` rejected an old completion whenever ANY combo member changed, dropping completions whose exact `${comboId}::${targetKey}` was still live — violating the live-key acceptance rule; `tests/combos.test.ts:642` codified the prohibited drop | ACCEPT | Fencing narrowed to owner generation plus exact live target key: completions for surviving targets accepted, removed targets rejected. Test updated to assert both directions. |

## wp4b A-gate (Fermat, FAIL 14) — adjudication

All fourteen findings accepted; 035 was rewritten around them before B started
(`6d45c2eea`). The essence: single ingress turn lease instead of per-stream
registration; reservation APIs acquired before upgrade/spawn for WebSockets and
workers; the vacuous OAuth flow cap replaced with the real unbounded owners
(`codexAuthLoginState`, `poolQuotaRefreshInFlight`, `tokenRefreshes` stale policy);
typed busy/stale errors enumerated as retryable at every consumer; MCP caps moved to
the layer where they are actually enforceable with transactional catalog staging;
usage truncation given independent byte/entry flags surfaced through API and GUI;
the Claude inbound ring bounded and given wp5 hooks; risky caps made configurable.

## wp4b C-review round 1 (Goodall, FAIL 8) — adjudication

| # | Blocker | Decision | Action |
|---|---|---|---|
| G1 | shutdown-drain suite red against the new lease contract | ACCEPT | Tests updated to acquire real admission leases (amend `22e41ce63`). |
| G2 | Stale debug unsubscribe removed a replacement listener while its lease stayed active | ACCEPT | Unsubscribe verifies registration identity; stale disposers are no-ops. |
| G3 | Aggregate MCP catalog overflow leaked the limit-crossing transport | ACCEPT | The triggering connection is staged before aggregate validation; every opened transport closes on staging failure. |
| G4 | Aborted Anthropic refresh owner's durable intent escalated a retryable stale condition to needsReauth | ACCEPT | Aborted owners persist stale evidence; replacements return retryable `OAuthTokenRefreshStaleError`; foreign/corrupt evidence still escalates. |
| G5 | Non-SSE streamed bodies released the turn lease at ingress | ACCEPT | Lease ownership transfers to body-lifetime tracking; release happens at stream settle. |
| G6 | Forced shutdown missed admitted-but-unbound leases | ACCEPT | Shutdown snapshots and force-releases every admitted lease exactly once; late binding stays idempotent. |
| G7 | Byte cap on an exact JSONL row boundary dropped a complete row | ACCEPT | Reader checks the byte before the window start before discarding the first line. |
| G8 | Four regressions were source-string checks | ACCEPT | Replaced with behavioral tests: guardian/quota/login retryability, zero-decode MCP rejection, mounted GUI qualification, real upgrade-boundary WebSocket admission, late-binding shutdown case. |

Round 2 closed G1-G7 and narrowed G8 to three coverage gaps (guardian/auth-api
consumers, decode-boundary proof, later-binding case); round 3 verified all three
closed test-only. Final verdict: **PASS**.

## wp5 A-gate (Dalton, 4 rounds) — adjudication

| Round | Blockers | Decision | Action |
|---|---|---|---|
| 1 (FAIL 6) | Translator observability had no executable hook provenance; enforcement triggers missed pin-release/TTL transitions and allowed reentrancy; continuation snapshot contract underspecified (stub/tombstone accounting, net released bytes); validateConfigCandidate lacked a raw range check; cross-store eviction ordering nondeterministic; snapshot failures silently zeroed | ACCEPT | 040 rewritten: observedInFlight is empty-but-wired with 050 registering via a named contract; full trigger set (writes, startup, config, pin release, TTL expiry, sweeper afterTick fallback) with single-flight enforcement; exact continuation exports with all-row accounting and net-release semantics; raw-candidate range check + CLI rejection; total order with registration-index tie-break and invariant counter; per-owner snapshotFailures scalar. |
| 2 (FAIL 2) | Doc not re-anchored to the delivered implementation; sweeper fallback mechanism ambiguous and untested | ACCEPT | Doc re-anchored to delivered code with only 050 work left open; sweeper exposes a generic afterTick registry (no app-owned-memory dependency), app-owned-memory registers its fallback at startup, TTL-expiry-without-writes regression added. |
| 3 (FAIL 1) | usage_summary oldestAt used generatedAt (captured before the async read), so an older-started slow read completing last could be evicted first | ACCEPT | Cache entries carry `revisionReadAt` captured immediately after the read returns; oldest tracking keys on read completion order; completion-order regression added. |
| 4 | — | — | **PASS**. |
