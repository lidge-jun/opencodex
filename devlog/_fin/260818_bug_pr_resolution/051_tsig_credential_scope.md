# 051 — Thought-signature credential scope + emit-after-commit (#1926 remaining half)

Sub-doc of 050 (wp10). ebab9d253 landed the destination half (keyFor v3,
thought-signature-replay.ts:88-98). This is the diff-level design for the two
remaining gaps. Residence deviation from matrix 040 ("windows unit") is
deliberate: no Windows content. Consumed by a later implementation cycle.

## Gap 1 — credential identity in the replay key

Threat: account A's Gemini thought signatures replay under account B on the
same destination (provider name + endpoint identical, credential different).
Upstream validates signatures per credential/project, so cross-account replay
is at best rejected upstream, at worst accepted with cross-tenant bleed.

### Discriminator design space (decide at implementation P)

| option | restart-stable | non-secret | rotation-safe | verdict |
| digest of account email/sub (OAuth id token claim) | yes | yes (sha256 truncated) | survives token refresh, breaks on relink to a different account — desired | PREFERRED |
| keychain-backed per-account UUID | yes | yes | orphaned on keychain loss; extra platform surface | fallback |
| digest of refresh-token | no (rotates) | risky | no | rejected |
| config-persisted random salt per account entry | yes | yes | deleted with the account entry — acceptable | acceptable alt |

- PREFERRED: providerCredentialDurableIdentity = "credential:" +
  sha256(accountStableId).slice(0,16), where accountStableId is the OAuth
  subject/email claim for oauth providers, or "apikey:" + sha256(key).slice(0,16)
  for key auth (key text never stored; digest only, matching the existing
  destination-digest precedent at :92-95).
- Wiring: OcxReasoningReplayScopeRef.current gains credentialDurableIdentity
  (populated beside providerDestinationDurableIdentity — same call sites,
  src/server/responses/core.ts scope construction; est. +15 lines).

### keyFor v4 + migration

- STORE_VERSION 3 → 4 (thought-signature-replay.ts:31). keyFor appends
  credentialDurableIdentity ?? "credential:unknown" after the destination
  field.
- Migration: v3 rows are NOT upgradable (no credential info recorded). Load
  drops v3 rows (same policy as the v2→v3 bump); signatures re-accumulate
  within one turn. Document in the store header comment.
- Invalidation on account relink: relink produces a different accountStableId
  → keys diverge naturally; no explicit purge needed. Account deletion: rows
  age out via the existing TTL sweep.

## Gap 2 — emit-after-commit ordering (all six sites)

Sites (r8 audit): bridge.ts:637/:658 (streaming closeCurrentToolCall),
:676/:697 (failCurrentToolCall incomplete-status), :1632/:1651 (buffered
buildResponseJSON via flushToolCall).

Constraint: closeCurrentToolCall is a sync closure with 8+ call sites in the
SSE switch; buildResponseJSON is sync. Full async-ification of the hot path is
disproportionate.

### Chosen design: bounded commit barrier at flush, not per-site awaits

- rememberExtraContentForReplay already returns { extra, durable }.
- Collect durable promises into the bridge-scope array pendingReplayCommits
  (est. +10 lines across the six sites: push instead of void).
- Barrier points (the only places output becomes externally visible as a
  COMPLETED turn): (a) streaming — before emitting response.completed in the
  SSE tail; (b) buffered — before returning from buildResponseJSON's caller
  (the response assembly in core.ts, which IS async). Await
  Promise.allSettled(pendingReplayCommits) with a 250ms cap
  (clearableDeadline); on timeout or rejection, log once via debug channel and
  continue — availability wins, the risk is one turn's signature miss, which
  is the pre-#1926 status quo, never worse.
- This preserves sync tool-call emission (mid-stream items are not the replay
  consumers; the NEXT request is) while guaranteeing the durable write has
  settled before the client can possibly send the follow-up that replays it.
- Commit-failure semantics (r8: persist swallows errors): persist() keeps
  best-effort file IO, but the durable promise must resolve false (not throw,
  not silently true) on write failure; the barrier logs the count of failed
  commits. No behavior change beyond observability.

## Accept criteria / test plan

- tests/thought-signature-credential-scope.test.ts: cross-account isolation
  (two scopes, same destination, different credential ids → no replay);
  restart persistence (v4 rows survive reload); v3 rows dropped on load;
  apikey vs oauth discriminator shapes.
- tests/bridge-replay-commit-barrier.test.ts: streamed turn — completed frame
  is not emitted until a slow durable resolves (fake timer); timeout cap
  honored; buffered path same; failed persist surfaces in the barrier count
  without failing the turn.
- Full suites: tests/bridge-*.test.ts + responses replay suites; tsc.
- #1926 closes when both gaps land.

