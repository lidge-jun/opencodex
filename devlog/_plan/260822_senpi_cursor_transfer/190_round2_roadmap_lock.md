# 190 — Round-2 roadmap lock

Locked from: 5 Luna research lanes (senpi delta, senpi issues, yelixir
inventory, other bridges, upstream), local clones under .tmp/chase/ (senpi
@041bb5e64, cursor-ai-proxy-bridge @main), sol read-only code audit of
origin/dev 525568652, and OpenCodex open Cursor issues (#1527, #2210, #2300,
#2305).

## Implementation order (this loop)

1. **110 — inbound stream-health watchdog (T04)**. Directly addresses open
   issue #2210 (silent stream → upstream_stall_timeout at 300s). Verified
   GAP: only a first-frame timer exists (live-transport.ts:93,1133). senpi
   constants live-verified in clone (cursor-agent.ts:250-252, 589-673).
2. **120 — OAuth poll fail-fast (T07) + cursorH2Pool shutdown hook**.
   Verified GAPs: cursor.ts:117-147 retries terminal 4xx thrice;
   h2-pool.ts:41 shutdown() has no caller; hook seam is sync-only
   (optional-shutdown-hooks.ts:23) so the registration wraps the async
   shutdown in a void fire-and-forget.

## Deferred / rejected this round (with reasons)

- **#2334 CursorCredentialRouter wiring — NEEDS_HUMAN.** Natural seam is the
  OAuth snapshot-selection boundary (oauth/index.ts:463 →
  responses/core.ts:2615), but wiring weighted rotation there overrides the
  user's explicit activeAccountId choice. That is a product decision
  (multi-account rotation semantics), not a stabilization patch. Until
  decided, the module stays test-covered but unwired; its doc comment
  already says "complements" rather than "replaces".
- **H2 pool Run-path integration — deferred.** Run streams are long-lived
  bidi; pooling them changes lifecycle/EOF semantics that #2307/#2321 just
  stabilized. Discovery-only stays. 120b fixes the overclaiming comment.
- **T02 conversation rotation — deferred.** senpi #998 persists rotated ids
  under its own agent dir; OpenCodex equivalent needs checkpoint-store
  migration via existing rekey and evidence that Codex compact does not
  already recover (090 residual unknown still unresolved; #1527 may be this
  class — needs a live reproduction first).
- **T06 maxMode — deferred (live probe).** GAP confirmed (hardcoded false,
  protobuf-request.ts:970; discovery drops ModelDetails.maxMode,
  live-models.ts:116), but 090 requires a live probe to show user-visible
  gain and billing semantics before flipping a wire flag.
- **T08 per-exec heartbeat — deferred.** Long native exec remains
  default-off; senpi's 3s ExecClientHeartbeat only matters with it enabled.
- **T09 cacheRead clamp — deferred.** Needs live billed turnEnded int64
  evidence (090 residual unknown).
- **T10 protobuf regen — deferred.** Requires a dedicated proto unit per
  090; touching gen/ ad hoc is not stabilization.
- **senpi #1020 suffix-alias — NOOP for OpenCodex.** Our effort-map already
  flattens suffix variants (090 T14 kept static tiers; request-builder
  suffix flatten at :187-204 on the audited head).
- **senpi #1016 stop-with-pending-tools, #1002 exec run ownership — out of
  adapter scope here.** Both live in senpi's agent loop; OpenCodex's
  analogues are the bridge/Responses layer. Issue #2305 (tool-call-like
  text to Pi on client-tool continuation) is the closest local symptom and
  deserves its own unit with a reproduction, not a blind port.
- **yelixir retry.ts / auto-runtime failover — partially rejected.** The
  transport-code retry table overlaps cursor-errors.ts mapping already
  landed (T01). The API→CLI backend failover is a product architecture
  OpenCodex does not have (no CLI backend); single useful residue is the
  non-retryable Cursor errorType detail sniffing, folded as a candidate
  into a future cursor-errors extension if live reports justify it.
- **cursor/sdk-bridge (official SDK) — tracked, not actioned.** A future
  migration study unit; policy-sensitive surface questions are NEEDS_HUMAN
  per the 100 boundary.
- **api2direct host migration reports — watch only.** Forum-level evidence,
  no reproducible breakage against our pinned client version yet.

## Gate

This lock is the D of the docs-only cycle. Implementation cycles 110 → 120
follow, one decade doc per PABCD cycle, each gated by focused tests +
typecheck + full suite before its dev push.
