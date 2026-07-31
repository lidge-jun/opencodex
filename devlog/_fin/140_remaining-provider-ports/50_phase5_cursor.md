# 140.50 — Phase 5: cursor (new adapter, HTTP/2+protobuf+exec, HARD+)

> One PABCD pass (MVP). The **hardest** port, fully isolated. **Detailed plan: `devlog/350_cursor-provider-add/`.**
> This doc is the roadmap stub; 350 is the source of truth for cursor.

---

## Goal

Stream cursor agent models (text + thinking) through opencodex over cursor's HTTP/2 Connect+protobuf
transport. MVP = login + single/multi-turn **text**; exec bridge **stubbed**.

## Why it is last + isolated

Cursor shares **zero** code with Phases 10–40. It breaks all three opencodex transport assumptions
(HTTP/1.1 fetch / JSON / unidirectional SSE) at once → HTTP/2 + protobuf + bidirectional agent RPC.
The `ProviderAdapter` interface (`base.ts:8-20`) cannot express it without a transport escape hatch.

## The full plan lives in 350

`devlog/350_cursor-provider-add/`:
- `00_overview.md` — the 3 structural clashes + scope.
- `01_cursor-anatomy.md` — protocol (HTTP/2 Connect framing, `@bufbuild/protobuf`, PKCE oauth poll, `GetUsableModels` discovery, exec + KV handshake, checksum-skipped).
- `02_opencodex-fit.md` — the **optional `runTurn()` adapter hook** escape hatch (additive; isolates HTTP/2+protobuf to `src/adapters/cursor/`).
- `03_phased-plan.md` — sub-phases: **0 transport spike → 1 oauth → 2 text+KV → 3 state → 4 models = MVP**; 5 exec bridge optional/separate-approval.
- `04_risks-and-decisions.md` — decisions (reuse jawcode protobuf, stub exec, skip checksum) + risks.

## Phase-50 summary (for this roadmap)

| Aspect | Plan (detail in 350) |
|--------|----------------------|
| Adapter | NEW `src/adapters/cursor/` (transport submodule) via optional `runTurn` hook |
| Transport | `node:http2` `http2.connect` + Connect framing + `@bufbuild/protobuf` |
| Auth | PKCE poll OAuth (`OAUTH_PROVIDERS.cursor`) — reuses the Phase-20 registry pattern |
| MVP scope | text + thinking; exec STUB + in-memory KV handshake (or turn stalls) |
| Models | ~145 seed + dynamic `GetUsableModels` |
| exec bridge | **optional Phase 5** — separate approval (makes opencodex a partial Cursor CLI host) |

## Sub-steps / Risks / Verify

See `350` — `03_phased-plan.md` (sub-steps + dependency graph) and `04_risks-and-decisions.md`.
Minimal proof: OAuth login → single-turn text on a `composer-*` model → multi-turn regression (`02:220`).

## Depends-on / enables

- **Depends-on:** the `OAUTH_PROVIDERS` registration pattern (established Phase 20); otherwise isolated.
- **Enables:** nothing downstream. Ships independently of 10–40.
