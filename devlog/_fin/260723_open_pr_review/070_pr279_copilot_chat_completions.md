# 070 — PR #279: feat: GitHub Copilot App support via OpenAI-compatible chat completions

- Author: HaydernCenterpoint · base `dev` · +1907/−1, 9 files, 6 commits.
- CI: full cross-platform green (all 8 checks pass). No GUI paths.

## What it does

- New `POST /v1/chat/completions` data-plane endpoint: translate-and-replay onto the internal
  `/v1/responses` path (same pattern as Claude Messages), so routing/OAuth/pool/sidecars are
  inherited unchanged.
- `src/chat/inbound.ts` (295 lines): messages → Responses input items; tools/tool_choice,
  response_format (json_object/json_schema), reasoning effort ladder incl. xhigh/max/ultra,
  max_completion_tokens fallback, tool-call name recovery from earlier transcript items.
- `src/chat/outbound.ts` (570 lines): Responses SSE → Chat Completions delta frames +
  non-stream completion object.
- Also flips `GET /v1/models` from `requireApiAuth(data-plane)` to `requireResponsesApiAuth`.
- New endpoint uses `requireResponsesApiAuth` (x-opencodex-api-key admission header),
  loopback exempt, origin check enforced, draining 503 handled — consistent with /v1/responses.

## Review findings

- Auth model verified against `src/server/auth-cors.ts:168-184`: the /v1/models switch means
  a bearer `Authorization` alone no longer admits on remote binds; clients must use
  `x-opencodex-api-key`. That is intentional (Authorization is reserved for the Codex Direct
  bearer domain) and documented in the new `docs/github-copilot-app.md` troubleshooting.
  Slight behavior change for any existing remote /v1/models caller using Authorization — worth
  one release-note line.
- Docs placed in `docs/github-copilot-app.md` (repo docs dir) with README link; docs-site is
  not updated. Follow-up candidate, not a blocker.
- Error mapping: ChatCompletionsRequestError → 400; unknown fields (penalties, n, logprobs)
  intentionally unsupported and documented.
- Tests: dedicated endpoint test file + server-auth root-payload sync. Good coverage of the
  new surface.

## Verdict: **MERGE-READY** (flag the /v1/models auth-header change in release notes)
