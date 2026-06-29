# 140.05 — Pinned external reference repos (vertex + antigravity)

> Pinned for the **un-hardened** provider ports still ahead of us: Phase 10 `google-vertex`
> and Phase 20 `google-antigravity`. Cursor (Phase 50) and Kiro (Phase 40) are essentially
> hardened already, so this doc deliberately does NOT re-pin cursor/kiro references — it
> captures the external SOT we will lean on the way we leaned on jawcode for those two.
>
> Source-of-truth hierarchy for these ports:
> 1. **opencodex itself** — our adapter contract + existing `google` adapter is the primary SOT.
> 2. **jawcode** (`packages/ai/src/providers/*.ts`) — the original internal port reference.
> 3. **External repos below** — independent, actively-maintained implementations to cross-check
>    wire/auth/quirks against. Treat as evidence to verify, not code to copy.

---

## Primary external SOT — `router-for-me/CLIProxyAPI`

- URL: https://github.com/router-for-me/CLIProxyAPI
- Lang: Go · License: MIT · ~38.7k stars · actively maintained (commits within days).
- Scope: wraps **Antigravity**, ChatGPT Codex, Claude Code, Grok as OpenAI/Gemini/Claude/Codex
  compatible APIs. Ships **both** Vertex and Antigravity as first-class, fully-tested providers —
  this is the closest external analogue to what we are building.

Why it is the right reference: its internal layering maps almost 1:1 onto opencodex's adapter model.

| CLIProxyAPI layer | opencodex equivalent |
|-------------------|----------------------|
| `internal/auth/*` (OAuth + credential parse/refresh) | `src/oauth/*`, `src/lib/gcp-adc.ts` |
| `internal/translator/*` (request/response body conversion) | body conversion in `src/adapters/google.ts` |
| `internal/runtime/executor/*` (stream, retry, refresh, signature) | `buildRequest`/`parseStream` + stabilization logic |
| `internal/signature/*` (gemini sanitize/validate) | gemini param/tool normalization |

### Vertex — file pointers (Phase 10 cross-check)

- Auth/credentials: `internal/auth/vertex/vertex_credentials.go`, `internal/auth/vertex/keyutil.go`
- Executor (stream + payload): `internal/runtime/executor/gemini_vertex_executor.go`
- Payload helpers: `internal/runtime/executor/helps/vertex_payload_helpers.go`
- Config compat: `internal/config/vertex_compat.go`
- Import/management: `internal/cmd/vertex_import.go`, `internal/api/handlers/management/vertex_import.go`

### Antigravity — file pointers (Phase 20 cross-check)

- Auth (OAuth + project onboard): `internal/auth/antigravity/auth.go`, `constants.go`, `filename.go`
- Login command: `internal/cmd/antigravity_login.go`
- Executor: `internal/runtime/executor/antigravity_executor.go`
  - refresh: `antigravity_refresh_test.go`; signature: `antigravity_executor_signature_test.go`
  - **reasoning/thoughtSignature replay**: `antigravity_reasoning_replay.go` (+ cache
    `internal/cache/antigravity_reasoning_replay_cache.go`) — this is the well-known Antigravity
    footgun (Claude+Gemini-3 thought-signature replay); cross-check our Phase 20 parser against it.
  - grounding URLs: `internal/runtime/executor/helps/antigravity_grounding_urls.go`
- Translators (CCA envelope, per client wire):
  - Gemini: `internal/translator/antigravity/gemini/antigravity_gemini_request.go` + `_response.go`
  - Claude: `internal/translator/antigravity/claude/*` (incl. `signature_validation.go`, `web_search.go`)
  - OpenAI chat + responses: `internal/translator/antigravity/openai/**`
- Model list fetcher: `cmd/fetch_antigravity_models/main.go`, version `internal/misc/antigravity_version.go`

## Secondary references (smaller, narrower, still useful)

- `comgunner/antigravity-studio` — pure-Python Antigravity (Cloud Code Assist) client: text chat +
  image-gen + agentic. Good for reading the raw CCA request/response shape without Go noise.
- `twobotass/antigravity-quota` — Antigravity quota check **with auto token refresh**. Useful for
  the refresh/quota stabilization slice (mirrors what Kiro got).
- `synthalorian/hermes-gemini-setup-guide` and `synthalorian/claw-code-gemini-setup-guide` — both
  document the Cloud Code Assist free-tier OAuth flow and the **thoughtSignature replay fix**;
  handy prose confirmation of the replay quirk above.

## How to use these (parity intent)

The goal is to bring Phase 10/20 to the same hardening bar Cursor and Kiro now sit at:
retry/backoff, per-attempt timeout, actionable error classification + secret redaction,
fail-closed truncation, estimated-usage tagging, and auth-refresh robustness. When implementing,
diff our behavior against CLIProxyAPI's executor/auth for each of those areas and record the
evidence in the corresponding phase doc (`10_…`, `20_…`).

> Note: external repos are reference evidence under their own licenses (CLIProxyAPI is MIT).
> Verify wire/auth details against them; do not paste their source into opencodex.
