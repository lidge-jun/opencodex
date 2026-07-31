# 05 — Hardening phase map (external GPT-Pro review folded in)

Scope decision (user): multi-account failover is OUT of scope. Focus on
functional parity + production hardening of the single-credential Kiro adapter.

Phase 10 (native images) is DONE — commit 494be0d.

## Re-prioritized phase map

| Phase | Priority | Surface | Closes |
|-------|----------|---------|--------|
| 70 | P0 | Stream exception/error is terminal (no `done` after an upstream error frame) | parseKiroStream emitting both error + done |
| 80 | P0 | Kiro HTTP retry/backoff: 401/403 refresh-once, 429/5xx exp backoff w/ jitter, first-token retry BEFORE any emitted delta, abort upstream on client disconnect | no transient-failure resilience |
| 90 | P0 | OAuth singleflight refresh + SQLite reload-before-refresh + busy-timeout | refresh races overwrite creds; silent DB swallow |
| 100 | P0 | Resume / tool-result correctness test matrix (current-turn-only risk) | unverified resume + tool continuation |
| 110 | P0 | Eventstream decoder hardening: frame-size cap, header-length bounds, per-read bounds, fuzz tests | binary-protocol crash/corruption risk |
| 120 | P1 | Tool schema sanitization (strip additionalProperties / empty required), long-description -> system prompt, orphaned/no-tools fallback | Kiro 400s from unsupported schema/tool-result-without-def |
| 130 | P1 | Model resolver: versioned-slug normalization + `max` effort advertise | mis-routed versioned slugs; max effort hidden |
| 140 | P1 | Kiro-specific error mapping (auth/region/quota/model -> actionable Codex errors) | generic upstream failure opacity |
| 150 | P2 | Truncation detection/recovery | silent mid-stream truncation |
| 160 | P2 | Usage estimated-tagging + calibration note | estimated usage indistinct from authoritative |
| 170 | P2 | Debug observability (redacted payload + raw frame behind flag) | future crash-guard cost |

## Order rationale

P0 first (survivability/correctness), each one full PABCD cycle with tsc +
targeted tests + atomic commit. Phase 70 is the smallest, highest-leverage P0
(a correctness bug: a failed upstream call can currently look partially
successful), so it leads.

## Already-at-parity (no work)

- Web search sidecar wired to kiro (parseResponse + loop).
- Token usage heuristic (plan 142) — only needs P2 tagging polish.
- Reasoning effort via fake-thinking tags (request side); response-side
  parse-back tracked as the original Phase 40 and folded with truncation/P1.
