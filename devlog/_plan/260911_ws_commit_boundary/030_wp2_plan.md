# wp2 — honest post-send status and the non-replayable marker

Previous D (wp1): roadmap locked at c3c1ea6731; direction unchanged — the fix is the commit
boundary, not the transport choice. 025 deltas are authoritative over 020.

## Files and exact changes

### src/lib/upstream-retry.ts
- Add a WeakSet<Response> with markResponseNonReplayable(res) and isNonReplayableResponse(res).
- Add NON_REPLAYABLE_UPSTREAM_CODES = {"upstream_no_response", "upstream_closed_before_response"} and isNonReplayableUpstreamCode(code).
- fetchWithTransientRetry loop guard: return res when isNonReplayableResponse(res).

### src/combos/failover.ts
- comboFailureDecision: after the 499/origin_rejected checks, return "stop" when isNonReplayableUpstreamCode(options?.code).

### src/server/responses/core.ts
- shouldRetryCodexPoolAccountQuota: first line returns false on isNonReplayableResponse(response).
- opaqueBlobRejectionBodyForRecovery: same early return undefined.

### src/server/responses/codex-ws-wire.ts
- codexWsPreResponseFailure(status: 502 | 504, message, prelude: Headers): Response — JSON body { error: { type: "upstream_error", code, message } }, code by status (504 upstream_no_response, 502 upstream_closed_before_response), headers = prelude snapshot + content-type application/json + cache-control no-store, marked non-replayable.

### src/server/responses/codex-ws-exchange.ts
- failStream(error, status = 502): when sent && !responseCommitted && metadata: terminal = true; cleanup(); resolve(codexWsPreResponseFailure(status, message, metadata.snapshot())); close the unused controller; session.dispose(). Otherwise the existing body-error path. (The non-metadata path commits at send.)
- cancelExchange(reason) when sent && !responseCommitted && metadata: TimeoutError -> failStream(reason, 504); otherwise terminal = true; cleanup(); session.dispose(); reject(reason).
- The prelude timer expiry calls failStream(..., 504); liveness itself is wp3.
- Reword the foreign-stream comment: a pre-response failure settles as a non-replayable 502; the 4xx projection stays reserved for a genuine refused create.

### Tests
- ws-upstream.test.ts: update 794/807 (metadata overflow -> 502 JSON, isCodexWsUpstreamResponse false), 873 foreign -> 502 + one send, 1064 oversized pre-response -> 502, 1180 abort after open -> the fetch rejects with the caller reason and the socket is closed, 1218 -> 502, 1262 -> 504 with sends === 1, 1533/1547 -> 502 with the same messages in error.message.
- ws-failure-stage.test.ts: failureMessage() returns error.message from a 5xx JSON body, else the thrown body error.
- New: upstream-transient-retry.test.ts — a marked 504 returns after one send; an unmarked 504 still retries. combos test — comboFailureDecision(504, "Provider error 504", { code: "upstream_no_response" }) is stop.

## Verification
NOT RUN locally (owner rule). Remote CI on the final head in wp4.

