# PR #121 Stream Identity Encoding Hardening — v2.7.14

## Objective
Merge community PR #121 (fix-upstream-retry-identity) and harden all remaining
upstream fetch paths against Bun SSE compression buffering.

## Background
Commit 54462c0 added `preferIdentityEncoding` to `fetchWithHeaderTimeout` to prevent
Bun from buffering compressed SSE streams. However, adapters using
`fetchWithAttemptDeadline` (google-http, kiro-retry) were not updated, causing
Gemini, Antigravity, and Kiro models to continue buffering during streaming.

## Changes

### PR #121 (Jinshijiming, merged)
- `src/adapters/base.ts`: Added `stream?: boolean` to `AdapterFetchContext`
- `src/adapters/google-http.ts`: Pass `ctx.stream` to `fetchWithAttemptDeadline`
- `src/adapters/kiro-retry.ts`: Pass `ctx.stream` to `fetchWithAttemptDeadline`
- `src/lib/upstream-retry.ts`: Added `preferIdentityEncoding` param with
  `Accept-Encoding: identity` injection (mirrors `fetchWithHeaderTimeout`)
- `src/server/responses.ts`: Pass `stream: parsed.stream` in both primary and
  429-retry `fetchResponse` call sites

### Hardening commit (a70d0f3)
- `src/web-search/loop.ts`: Added `stream: true` to web-search iteration
  `fetchResponse` context — sol (gpt-5.6-sol) review discovered this gap where
  web-search iterations for Gemini/Antigravity/Kiro would still buffer SSE.
  Also added `Accept-Encoding: identity` to the raw `fetch()` fallback path.
- `src/adapters/base.ts`: Added JSDoc to `stream` field, removed trailing blank line

## Review Notes (sol)
- Core PR correctness: confirmed mirrors `fetchWithHeaderTimeout` pattern exactly
- API design: `stream` on `AdapterFetchContext` preferred over leaking
  `preferIdentityEncoding` transport detail
- `new Headers(init.headers)` copy pattern: correct (avoids caller mutation)
- `undefined` -> `false` default: correctly preserves non-streaming behavior
- Blocker found: web-search loop missing stream flag — fixed in hardening commit

## Research Findings (cxc-search)
- Bun zstd corruption: oven-sh/bun#20053 — mitigated by identity header
- Bun gzip ShortRead: oven-sh/bun#8017 — mitigated by identity header
- Bun CONNECT proxy SSE leak: oven-sh/bun#30381 — no server-side fix, Bun runtime bug
- Cross-ecosystem pattern: Axum/tower-http, Gin, Tornado all skip compression for SSE
- Inbound request decompression: already robust (request-decompress.ts)

## Release
- Version: v2.7.14
- Tag: v2.7.14 (pushed)
- Branches synced: main = dev = preview = c638f8ed
- Issue #120: closed (auto-closed by PR merge)
