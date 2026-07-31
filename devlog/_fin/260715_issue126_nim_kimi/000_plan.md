# 260715 — Issue #126: NVIDIA NIM 404/400/hangs + kimi cross-provider hardening

## Context

Issue #126 (vebaev, mobile Codex app + remote opencodex proxy, codex-cli 0.144.4):

1. `nvidia/moonshotai/kimi-k2.6` → `unexpected status 404 Not Found: Provider error 404, url: http://127.0.0.1:10100/v1/responses`
2. Other NIM models → `{"error":{"message":"Provider error 400","type":"upstream_error","code":null}}`
3. Or no response at all ("just thinking").

## Investigation results (recorded 260715, main session + 4 Luna lanes + local probes)

### Verified locally
- `GET https://integrate.api.nvidia.com/v1/models` (unauthenticated) returns **121 models** and **does list `moonshotai/kimi-k2.6`** — matches reporter's "+120 models appended". Catalog fetch + `nvidia/` prefix routing (src/router.ts:167) are correct.
- Unauthenticated POST probes: auth (401) is checked before model existence, so the reporter's 404 needs a keyed account to reproduce.
- Both screenshot errors are **bare** `Provider error N` (no `: <detail>` suffix) — that shape is only produced by the web-search sidecar loop (src/web-search/loop.ts:319,332 + jsonError loop.ts:148). The normal bridge path (src/server/responses.ts:1036) always appends `: <body slice>`. ⇒ the reporter's requests went through the web-search sidecar, and the `openai-chat` adapter has **no `formatErrorBody`**, so NIM's real error text is swallowed.

### External evidence (Luna swarm, sources opened)
- NIM `/v1/models` is catalog metadata, not an invocability list; account-scoped 404 "function not found" for listed models is a known pattern:
  - https://forums.developer.nvidia.com/t/404-function-not-found-for-account-when-calling-aisingapore-sea-lion-7b-instruct-via-integrate-api-nvidia-com/361577 (2026-02-24)
  - https://forums.developer.nvidia.com/t/api-url-not-working/359304 (2026-02-02, kimi-k2.5)
- kimi-k2.5 on NIM returns **HTTP 400 "This model only supports single tool-calls at once!"** when `parallel_tool_calls: true` is sent: https://github.com/openclaw/openclaw/issues/37048 (2026-03-06). opencodex sends `parallel_tool_calls: true` by default whenever tools are present (src/adapters/openai-chat.ts:295 region, decision 260709).
- `reasoning_effort` is not portable on NIM (models use `chat_template_kwargs`; only some, e.g. gpt-oss, accept it): https://docs.nvidia.com/nim/large-language-models/1.13.0/release-notes.html + https://pi.dev/packages/pi-nvidia-nim
- NIM free tier: dynamic throttling below the nominal 40 RPM, hour-long lockouts, kimi-class models extremely slow/queued — explains the "just thinking" hangs (bridge keep-alive heartbeats keep the stream open): https://forums.developer.nvidia.com/t/getting-429-too-many-request-for-nim-cloud-api/335755 (2026-06)
- NVIDIA docs confirm `moonshotai/kimi-k2-instruct|k2-thinking|k2.5|k2.6` are the documented served IDs on integrate chat/completions, all with tool calling: https://docs.api.nvidia.com/nim/reference/llm-apis

## Work phases

### WP1 — code hardening (this PABCD cycle)
1. `src/providers/registry.ts` nvidia entry:
   - `parallelToolCalls: false` (NIM kimi 400 fix; field still sent as `false`, accepted by vLLM/NIM).
   - Suppress `reasoning_effort` for NIM kimi family (exact mechanism per Averroes/sol recon: per-model lists vs provider-wide switch; must NOT break gpt-oss reasoning_effort on NIM).
   - Keep entry live-models; add note comment with evidence links.
2. `src/adapters/openai-chat.ts`: add `formatErrorBody(status, headers, payloadText)` — parse display-safe JSON bodies (`error.message`, `detail`, `message`, `title`) and return a compact string so web-search loop surfaces NIM/other openai-chat upstream detail. Mirror kiro.ts:559 / google.ts:210 patterns.
3. Cross-provider kimi audit: `huggingface` (bare, serves moonshotai kimi via router), `firepass` (frozen), `openrouter` (normalizes params itself — verify no change needed), `opencode-go`/`kimi`/`moonshot`/`umans` (already hardened — verify k2.5/k2.6 coverage vs KIMI lists).
4. New test file(s) only (several existing test files are dirty from parallel work): nvidia buildRequest body assertions + formatErrorBody unit tests.

### WP2 — record + reply + push
1. Finalize this devlog folder (audit verdict, evidence, closeout).
2. Post English comment on issue #126: 3-branch root cause + "patch landed on dev, release pending, not everything fixable on our side (NIM account/capacity)".
3. Commit ONLY scoped files; push origin/dev. No release/tag.

## Constraints
- Dirty tree belongs to parallel agents (gui/*, anthropic image retry, kiro, base.ts, responses.ts, many tests) — do not touch.
- No release; ocx restart note applies to the user's own instance only.
