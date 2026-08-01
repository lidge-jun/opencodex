# 110.00 — Overview: Codex Stream Errors over the opencodex Proxy

## Symptom (user report)

With `ocx` running, driving the **Codex CLI** through the proxy produces frequent
*stream errors*. The reporter suspected an SSE or WebSocket transport problem, asked whether
SSE multiplexing / WS would improve performance, observed that bolting WS onto the
`chat/completions` adapter "seems pointless," and asked whether the real cause is that
**Codex passthrough is not actually happening**.

This phase reads the codebase against the upstream Codex SSE parser, identifies the root
cause, evaluates the transport question, and lays out a prioritized patch direction. This
phase ships **analysis + patch direction only** — the code changes in `30_patch-direction.md`
are a separate, approval-gated implementation phase.

## TL;DR

1. It is **not a transport-protocol problem**. It is an **SSE lifecycle / reliability**
   problem. WebSockets and SSE multiplexing do not address any of the root causes. The
   phase 100 "no WebSocket" decision stands (see `20_transport-evaluation.md`).
2. opencodex has **two response paths**, and the errors have **different causes on each**:
   - **Passthrough** (native `gpt-*`): the ChatGPT backend body is relayed verbatim, so a
     terminal `response.completed` cannot be dropped by opencodex. Errors here are
     **header fidelity** + **no abort/cancel** (disconnect/leak).
   - **Bridge** (routed models, e.g. `opencode-go/deepseek-v4-pro`): opencodex parses an
     upstream chat/completions stream and **re-encodes** it into Responses SSE. Errors here
     are **missing terminal event**, **idle timeout**, and **fidelity gaps**.
3. "Is passthrough happening?" — **Yes for native `gpt-*`** (default config). For **routed
   models it is structurally impossible** (the upstream is chat/completions, not a
   Responses-native endpoint), so opencodex *must* bridge. The fix is bridge fidelity, not
   "forcing passthrough."

## The two paths

| | Passthrough | Bridge (translation) |
|---|---|---|
| Adapters | `openai-responses`, `azure` (`passthrough: true`) | `openai-chat`, `anthropic`, `google` |
| Trigger | `config.ts:60-76` default `openai` provider, `authMode: "forward"` | routed `provider/model` namespace → `router.ts:28-37` |
| Code | `server.ts:141-157` relays `upstreamResponse.body` + `sanitizePassthroughHeaders` | `server.ts:194,205` `adapter.parseStream()` → `bridgeToResponsesSSE()` |
| Fidelity | High — backend events relayed unchanged | Lossy — fixed event set re-emitted (`bridge.ts:38-311`) |
| `response.completed` origin | ChatGPT backend (verbatim) | Synthesized by the bridge on the `done` event |

## What "stream error" means to Codex

The Codex CLI consumes the proxy's SSE with a strict Rust parser. Every failure surfaces as
`ApiError::Stream(...)`. The authoritative trigger set
(`/tmp/opencodex-codex-src/codex-rs/codex-api/src/sse/responses.rs`, see `10_…`):

- `:459` **stream closed before `response.completed`** — stream ended with no terminal event
- `:466` **idle timeout waiting for SSE** — no event within `idle_timeout`
- `:454` **SSE frame decode error** — a malformed frame from the proxy
- `:349/:378` **`response.failed` with no classifiable `error`** (mitigated by phase 100.5)
- `:391` **`response.incomplete`**, `:406` **`response.completed` parse failure**

## Root-cause summary

| ID | Cause | Path | Codex trigger | Status |
|----|-------|------|---------------|--------|
| RC1 | Bridge ends stream with no terminal `response.completed` when an adapter returns without a `done` event | **Bridge** | `:459` | Open |
| RC2 | No `AbortSignal` on upstream fetch + no `cancel()` on the bridge stream → leak + re-throw on client disconnect | Both | leak / `:454` noise | Open |
| RC3 | No idle heartbeat during upstream stalls (slow routed providers) | **Bridge** | `:466` | Open |
| RC4 | Bridge fidelity: error envelope + dropped/malformed frames | **Bridge** | `:349`, `:454` | Partly fixed by 100.5 (`a0d4ec9`) |
| RC5 | Passthrough header fidelity (stale `content-encoding`/`content-length`) | **Passthrough** | `:454` | Mitigated by 100.5; verify |

> **Misattribution guard:** RC1/RC3 bite the **bridge/routed** path only. Native `gpt-*`
> passthrough errors are RC2 + RC5. Do not attribute native-codex stream errors to RC1.

## Answers to the four questions

1. **SSE or WS problem?** SSE *lifecycle*, not transport. See `10_…`.
2. **Would SSE multiplexing / WS improve performance?** No — see `20_…`. Real wins:
   keep native passthrough, fix abort, add heartbeat.
3. **Is WS on the chat/completions adapter pointless?** Yes. The upstream is HTTP/SSE; a WS
   first hop still blocks on the same upstream chunks and would falsely advertise
   `supports_websockets`.
4. **Is Codex passthrough broken?** Not for native `gpt-*` (it is used). For routed models
   passthrough cannot exist by design; the bridge is the only option and is where the
   defects live.

## Scope & baseline

- **In scope:** root-cause analysis, transport evaluation, prioritized patch direction.
- **Out of scope (this phase):** the actual code changes (deferred to an approval-gated
  implementation phase; see `30_patch-direction.md`).
- **Baseline at authoring time:** `bun test` → 26 pass / 0 fail; `bun x tsc --noEmit` clean;
  phase 100.5 error/header fidelity committed as `a0d4ec9`.

## Documents

- `10_root-cause-analysis.md` — Codex `ApiError::Stream` trigger table ↔ opencodex RC1–RC5
- `20_transport-evaluation.md` — SSE multiplexing / WebSocket verdict
- `30_patch-direction.md` — P0/P1/P2 file-level patch direction + verification plan
