# 110.50 — Closure Overview: Remaining Fidelity Items + GPT-Pro 100.n Leftovers

Phase 110 P0 (RC1–RC3) is implemented and unit-tested (`40_p0-implementation.md`). This
closure series turns the **remaining** open items into phase-100-fidelity, implementation-ready
plans: each downstream doc has Objective / Evidence (file:line) / Files (NEW full content,
MODIFY before-after diff) / Verification / Commit, so implementation can begin directly.

> **Scope of this series is documentation only.** No production code is changed by the goal
> that produced these docs; the docs are the deliverable. Implementation is a separate,
> approval-gated step (each doc carries its own commit line).

## Why a closure series

Two streams of open work converge on the **bridge/adapter fidelity** layer that 110 owns:

1. **110's own deferred items** — P1b (RC5 passthrough regression test owed) and P2
   (rate-limit/overload classification, dropped-frame visibility), plus the **live E2E
   acceptance gate** that unit tests cannot satisfy (`30_patch-direction.md` §P1b, §P2, §Verification).
2. **GPT Pro's "Missing Analysis" on phase 100** — fidelity gaps GPT Pro found while
   implementing 100.1–100.5 that are **the same SSE/adapter layer** as 110, not catalog/policy.
   (Source: `FINAL_REPORT.md` → "Missing Analysis Found".)

Folding them into one 110 closure keeps the bridge-fidelity invariant in a single owner and
avoids a redundant "phase 100.6". **WebSocket parity is explicitly NOT here** — it is a
different transport axis tracked as phase 120 (see `20_transport-evaluation.md`; the "no WS for
routed reliability" verdict still stands).

## Citation basis (IMPORTANT — read before implementing)

The 110 RCA (`10_root-cause-analysis.md`) cited an **ephemeral** Codex snapshot at
`/tmp/opencodex-codex-src/...`. These closure docs re-base every Codex-parser citation to the
**stable local checkout** the user actually runs:

```text
/Users/jun/Developer/codex/codex-cli/codex-rs/codex-api/src/sse/responses.rs
```

The two differ. A concrete consequence, verified during the plan audit: the stable parser
**does recognize `rate_limit_exceeded`** — `try_parse_retry_after` (`responses.rs:487-509`)
gates on `code == "rate_limit_exceeded"` and extracts the delay from the message text (test
fixture `responses.rs:844` carries `"Please try again in 11.054s."`). The 110 RCA's claim that
`rate_limit_exceeded` "is not in the recognized set" was based on the stale `/tmp` snapshot and
is **superseded** by `53_rate-limit-and-overload-classification.md`.

## Open-item status (post-P0)

| ID | Item | Path | Status before closure | Closure doc |
|----|------|------|-----------------------|-------------|
| RC1 | terminal `response.completed` guarantee | bridge | Fixed (`1528114`) | — |
| RC2 | upstream abort on disconnect (both paths) | both | Fixed (`e2ae0b8`,`955f3dd`) | — |
| RC3 | idle keep-alive heartbeat | bridge | Fixed (`61dcec2`) | — |
| **F1** | inline `error` envelope inside a **200** success stream is swallowed | bridge/adapters | **Open** | `51_…` |
| **F2** | usage+choices same-chunk content drop; usage lost on EOF-without-`[DONE]` | adapters | **Open** | `52_…` |
| **F3** | 503/overload not mapped to a Codex-recognized code; retry-after message fidelity | bridge/errors | **Open** (was 110 P2) | `53_…` |
| **F4** | RC5 passthrough header regression test owed; dropped-frame visibility | passthrough/adapters | **Open** (was 110 P1b/P2) | `54_…` |
| **F5** | live-Codex acceptance gate | both | **Owed** | `55_…` |

## GPT-Pro 100.n leftover → closure mapping

| GPT Pro "Missing Analysis" item | Closure doc |
|---------------------------------|-------------|
| "successful HTTP/SSE streams can contain embedded provider error envelopes" | `51_…` (F1) |
| "terminal usage may be isolated, combined with a content choice, or followed by EOF without `[DONE]` … adapters must retain usage without skipping the rest of the chunk" | `52_…` (F2) |
| "rate-limit delay parser requires both `rate_limit_exceeded` and a parseable 'Please try again in Ns/ms' message, not only Retry-After" | `53_…` (F3) |
| "generic provider 429 'quota exceeded' often means a temporary request/token bucket rather than fatal paid-credit exhaustion" | `53_…` (F3, retryable-vs-fatal note) |
| "routed normalization also needed to strip native `comp_hash`" | closed in 100.4 (`8c3aa60`/`85a4daa`); verify-only, no new doc |
| "explicit mappings must allow intentionally unmapped built-in providers to fall back conservatively" | closed in 100.4; verify-only, no new doc |

## Document index

- `51_success-stream-error-envelope.md` — F1: detect inline `{"error"}` in a 200 stream → classified `response.failed`
- `52_combined-usage-choice.md` — F2: stop dropping content/usage in `openai-chat.ts` and `google.ts`
- `53_rate-limit-and-overload-classification.md` — F3: overload→`server_is_overloaded`; retry-after message contract
- `54_passthrough-and-dropped-frame.md` — F4: RC5 regression test + opt-in dropped-frame logging
- `55_e2e-acceptance.md` — F5: the live-Codex acceptance gate that closes 110

## Sequencing

F1 + F2 are the highest-leverage correctness fixes (they convert silent truncation into
faithful completion/failure) — implement first, behind their unit tests. F3 is faithful-backoff
polish. F4 is regression hardening + observability. F5 is the human acceptance gate and runs
last, in the user's environment. None requires a transport change.

## Non-goals

- No WebSockets / no transport change (phase 120).
- No "force passthrough" for routed models (structurally impossible — `10_…` §7).
- No catalog/policy changes (phase 100 territory).
