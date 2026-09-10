# `ocx-go` core preview — first implementation slice and acceptance matrix

Status: spec (implementation not started)
Governing decision: `docs/adr/0010-ocx-go-native-runtime-line.md`

## Scope of the first delivery

A daily-use closed loop for Codex, Claude, and OpenCode on Linux, with no JS/Bun/
Node/checkout/delegation at any point in the user runtime.

In scope:

- `ocx-go` binary + release identity + artifact naming, independent of legacy `ocx`.
- Independent state root `~/.ocx-go` (`OCX_GO_HOME`), legacy JSON schema, default
  port `10101`.
- Owner-tagged runtime records with per-runtime admission token.
- Public data plane: `POST /v1/responses`, `GET /v1/models` (admission-protected).
- Adapters `openai-responses`, `azure`, `azure-openai`, `openai-chat`, key-auth.
- Strict routing subset; fail closed otherwise.
- Runtime response state for `previous_response_id` (bounded, generation-bound).
- Runtime key scheduler (ordered apiKeys, header-stage 429 only).
- Native Codex loopback Design-B sync/inject with journal + immutable backup +
  restore, and the `handoff codex` preview/apply protocol.
- `ocx-go codex|claude|opencode` launchers with readiness + temporary admission
  injection.
- Zero-JS dashboard capability page + real supported routes (provider, models/
  routing, codex, claude, opencode, runtime status).
- Migration ledger wired into `capabilities --json`, `help`, dashboard, errors.
- Native unsupported: exit 69 / HTTP 501 for everything else, no delegation.
- Metadata-only request records.
- Independent no-JS CI lane + release artifact with checksum + signed provenance.

Out of scope (ledger entries): OAuth/account pool, keychain, non-key auth,
non-first adapters, combos/profiles/aliases/pattern/namespace routing, provider
discovery, `/v1/chat/completions` inbound, provider-table/desktop-authless/
websocket/non-loopback injection, self-update, Windows, complete dashboard.

## Implementation order

1. **Identity + ledger skeleton.** `ocx-go` entrypoint/artifact naming, remove
   delegation reachability, ledger registry + test, capabilities/help wiring,
   exit-69 native unsupported. (No behavior migration yet — this is the spine.)
2. **Standalone runtime + admission.** `start`/`stop` on 10101, runtime record
   with owner + admission token, `/healthz`/`/readyz`, stale-record recovery
   (prove-then-clean), config snapshot loader.
3. **Strict provider config + validation.** `provider add` / `provider
   set-default` / `import-legacy` with the four-adapter/key-auth subset, literal
   or env-ref credentials, private perms, write-before-validate.
4. **Public data plane — responses core.** Adapter-agnostic Responses handling in
   front of the four adapters: non-streaming, SSE, tool calls, errors, cancel,
   bounded drain, `previous_response_id` state, key scheduler.
5. **`openai-chat` conversion.** The Responses→chat request build + SSE/non-stream
   parse with the strict field set (see matrix below).
6. **Codex native sync/inject.** Loopback Design B transaction (config, profile,
   catalog, `models_cache.json`, journal, immutable backup), restore, and the
   `handoff codex` protocol.
7. **Launchers + capability routes.** `codex`/`claude`/`opencode` with readiness
   wait and temporary admission; `/api/models` and `/api/claude-code` capability
   routes (private, launcher-internal).
8. **Zero-JS dashboard (preview subset).** HTML forms for the supported pages +
   capability/ledger page, gui bootstrap session, CSRF, high-impact challenge.
9. **Release.** Independent no-JS CI lane, artifact + checksum + provenance,
   Linux runtime E2E, macOS build verification, release notes with the platform
   disclosure.

## `openai-chat` first-set field contract

Converted (Responses → chat):

- `instructions` → leading system message (order preserved as the existing
  adapter specifies); user/assistant text input.
- `model` (physical id, exact-match routing).
- `stream` and SSE `stream_options.include_usage`.
- `max_output_tokens` → `max_tokens`.
- Standard function tools + `tool_choice`; assistant tool calls and tool results
  round-trip.
- Assistant text / tool-call response and SSE deltas back to Responses events.

Refused with HTTP 501 (`standalone_go_unsupported`) in the first delivery:

- `temperature`, `top_p`, `stop`, penalties, tier/service fields.
- reasoning: `reasoning`, `reasoning_effort`, thinking budgets/toggles,
  `reasoning_details`.
- `response_format` / structured output.
- images/vision, web search, custom tools, namespace tools, routed tool modes.
- `previous_response_id` when state is unavailable; provider-specialized fields.

SSE success requires `[DONE]` **or** an observed non-empty `finish_reason`;
otherwise the turn fails closed with a stable error.

## Acceptance matrix (Linux, release-shaped binary)

Every row runs in a clean container, host network, isolated `HOME`/`OCX_GO_HOME`/
`CODEX_HOME`, PASS only if it holds.

Identity / independence
1. Artifact builds with no Bun/Node on PATH; `ocx-go --version` is the static
   build identity; no JS asset is embedded.
2. Every public command runs; unsupported ones exit 69 with a ledger code and
   never spawn Bun/Node/TS (process-tree assertion).
3. No command reads `OCX_TYPESCRIPT_CLI`/`OCX_BUN`; a poisoned PATH cannot cause
   a delegation.

Runtime / state
4. `start` binds 10101, writes an owner-tagged record + admission token, is
   idempotent when already healthy.
5. Stale record: dead PID → prove-then-clean and start; mismatched/legacy owner →
   refuse, no process killed.
6. `--port` override changes the listener and record for one run only.
7. Invalid config write is rejected with zero file change; a hand-broken config
   keeps the last valid snapshot serving and reports it.

Data plane
8. Unauthenticated / wrong-bearer `/v1/responses` and `/v1/models` are rejected;
   OpenCodex-shaped headers are consumed and never forwarded upstream.
9. For each of the four adapters (key auth): non-streaming and SSE request →
   correct upstream bytes, correct client stream, usage, tool call, cancel.
10. Duplicate-registered model → `standalone_go_ambiguous_model`; unregistered →
    `standalone_go_model_not_configured`; out-of-subset request → 501.
11. `previous_response_id` continues a completed turn; after restart or eviction
    → `standalone_go_response_state_unavailable`; cancelled/failed turns never
    leave continuable state.
12. Multi-key: key #1, header-stage 429 on #1 → cooldown → key #2; non-429 does
    not rotate; SSE retries once before the first event and never mid-stream.
13. Client disconnect bounds the upstream request; stop drains and starts no new
    upstream work.
14. Client-visible errors are generic; no upstream body/URL/key leaks.

Codex
15. `sync` on a clean `CODEX_HOME` writes the Design-B root override + profile +
    catalog + cache + journal + immutable backup; `restore` returns exact bytes.
16. `sync` on a legacy/unknown-owned `CODEX_HOME` writes nothing and reports a
    stable conflict with a handoff path.
17. `handoff codex` preview is non-mutating; apply revalidates and refuses if
    evidence changed; a running legacy/`ocx-go` runtime blocks the write.
18. Complex/undecidable `config.toml` is preserved untouched with a stable error.

Clients
19. `ocx-go codex|claude|opencode` with no runtime: perform the safe static
    inject if needed, start proxy, wait ready, then launch the client with a
    temporary admission token; no token in config/env of the parent or in files.
20. Direct manual client start without a token fails with stable guidance.

Dashboard
21. Zero JS served: no `<script>` and no JS asset response from the HTML routes.
22. Bootstrap URL is one-time and short-lived; session ends on restart/revoke;
    writes require CSRF; high-impact actions require a fresh challenge.
23. Credentials are write-only: never echoed in HTML, URL, logs, or errors.

Ledger / docs
24. `capabilities --json` and `help` report support state identical to the
    ledger; a ledger test enforces the bijection and evidence rules.

Real probe (opt-in, release preflight only)
25. With explicit authorization, a single fixed minimal inference against
    `http://127.0.0.1:20100` provider `tencent`, model `tencent/glm-5.3-flash`
    (adapter `openai-chat`, `allowPrivateNetwork: true`) succeeds through the
    launcher path; output is a restricted diagnostic summary only, and no
    prompt/response/credential is logged or persisted.

## Evidence discipline

- Offline stub matrix is the default gate; the real probe is explicit opt-in and
  summarized, never part of default CI.
- Platform contract: Linux = runtime verified; macOS = `supported` with disclosed
  build/format-only verification; Windows = native unsupported.
