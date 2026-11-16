# 080 — Antigravity ACP provider (`agy acp`), issue #8480

Owner decision (lidge-jun on #8480, 2026-11-16): add the official `agy acp` transport as a **separate**
provider: one account, no automatic rotation, no remote sharing, Gemini models only. The existing
`google-antigravity` provider is unchanged. Owner-session follow-up: document the provider as interactive and
user-directed only, and enforce the certain signals (subagent turns carrying `x-codex-parent-thread-id`, use as a
combo member, subagent-fallback routing); no heuristics beyond those. Permission requests are refused by default and
`--dangerously-skip-permissions` is never passed. The local `agy` here is 1.3.3 and is not upgraded: tests use a
fake ACP child, and a live `agy acp` (>= 1.5.0) session is NOT RUN. Delivered as its own PR from `dev`
(Closes #8480), independent of #8742 and #8771.

Class C4: a new provider that spawns a local agent process, plus a request-scoped policy gate.

## Sources

- Antigravity CLI ACP: https://antigravity.google/docs/cli/acp (`agy acp`, `agy acp --login`, the binary owns its
  credential) and https://antigravity.google/docs/ide/extensions/acp/ (`--sandbox`, `--agent`,
  `--dangerously-skip-permissions` advised against outside disposable environments).
- Google staff answers on personal ACP use: the binary may be launched by a personal app for the user's own account,
  provided use is interactive and user-directed rather than an unattended worker pool or automated agent loop;
  programmatic workloads belong on a Gemini API key or Vertex AI:
  https://discuss.ai.google.dev/t/tos-clarification-is-t3-code-official-antigravity-acp-agent-permitted-under-the-antigravity-terms-of-service/192027/2,
  https://discuss.ai.google.dev/t/policy-question-omp-hosting-unmodified-antigravity-acp-for-one-user/199753,
  and the thread cited in #8480 (198889).
- ACP v1 (github.com/agentclientprotocol/agent-client-protocol, docs/protocol/v1): `initialize` (protocolVersion 1,
  `authMethods`), `session/new` (`cwd`, `mcpServers`, optional `systemPrompt` when
  `sessionCapabilities.systemPrompt` is advertised), `configOptions` with categories `model` and `thought_level`,
  `session/set_config_option` (value must be one of the advertised options, else -32602), `session/prompt` reply with
  `stopReason` (`end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`), `session/update`
  (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `usage_update`),
  `session/request_permission`, `session/cancel`, error -32000 "Authentication required".
- Prior art in this repository: the Devin CLI ACP adapter (#4288, retired in #4415 because the Devin token could be
  imported; that premise is false here). Its framing (`src/adapters/devin-cli/acp.ts` at `f97612c956^`) and turn
  driver (`adapter.ts`, `binary.ts`) are the base: pure framing, scoped child environment, refuse-by-default
  permissions, the CLI's own tools as heartbeats, a crash is never success, SIGTERM then SIGKILL reaping of the
  process group.

## Shape

- Provider registry entry `antigravity-acp` (label "Antigravity CLI (ACP, local)"), adapter `agy-acp`,
  `authKind: "local"`, identity-only destination (never connected to), Gemini models only, not featured in pools.
- Adapter `src/adapters/agy-acp/`: `acp.ts` (pure framing, carried from the Devin module and extended with config
  options, the system prompt capability and -32000), `binary.ts` (`OPENCODEX_AGY_BIN` or `agy` on PATH, plus a cached
  `agy --version` check for >= 1.5.0), `policy.ts` (the interactive-only and local-only gate), `adapter.ts`
  (`runTurn`: one child per turn).
- A turn: `initialize` → `session/new` in a dedicated empty workspace under the OpenCodex home (never the operator's
  tree) with `mcpServers: []` and the system prompt when advertised → `session/set_config_option` for the model and,
  when requested, the thought level → `session/prompt` with the flattened conversation → stream updates → reply.
- Model selection: the requested id must be a Gemini model (`gemini-*`) and must match an advertised `model` option
  (by value, or by name normalized to lower case with spaces as hyphens). Non-Gemini options are never selected. No
  match is a 400 naming the Gemini values offered. No requested model keeps the CLI's current value only when it is a
  Gemini model.
- Thinking: Codex effort `low|medium|high|xhigh|max` → the `thought_level` option whose value or name is
  `low|medium|high|extra|max`. Not offered → 400 naming the offered values; no effort requested → unchanged.
- Client tools: ACP `session/prompt` carries text only, so Codex function tools are not offered to the model; the
  CLI's own `tool_call` updates are heartbeats, never client tool calls (documented limitation).

## Policy gate (`policy.ts`), checked before spawning

1. Interactive only. Refused with 403 `permission_error`, code `agy_acp_interactive_only`, when the request carries
   `x-codex-parent-thread-id` (a subagent turn), when it is a combo member (`IncomingMeta.comboAttempt`), or when
   subagent fallback chose this route (new `IncomingMeta.subagentFallback`, set by Responses adapter dispatch when
   `logCtx.subagentModelFallbackFrom` is present). The message names the policy and points to a Gemini API key or
   Vertex AI for programmatic workloads. No other signal is used.
2. Local only (no remote sharing). A new request-scoped `AsyncLocalStorage` (`src/server/request-peer-scope.ts`)
   records whether the request arrived on a local ingress (`public`, `unauthenticated-loopback`, `local-control`,
   `claude-intercept`) from a kernel-observed loopback peer (`requestServer.requestIP`). It is entered next to
   `runTurnStateCallerScope` in `serve-options.ts` (HTTP) and in `websocket-handler.ts` from the socket data recorded
   at upgrade (`hub-link` sockets are remote). Remote, hub-link, hub-management or unknown scope → 403 code
   `agy_acp_local_only`. Fail closed: a call with no recorded scope is refused.
3. Configuration (`config-schema.ts` superRefine): an `agy-acp` provider may not carry `apiKey`, `apiKeys`,
   accounts or an OAuth binding (one account, owned by the CLI); its `models` must be Gemini ids; no combo may name
   one of its models as a target, and neither may `subagentModelFallback` / `subagentModelFallbackByModel`.

## Errors

- CLI missing → 503 with the install hint. Version below 1.5.0 → 503 naming the found version.
- -32000 or an `authenticate`-required answer → 401 `authentication_error`, code `agy_login_required`:
  "Antigravity CLI is not signed in. Run `agy acp --login` (or `agy`) and sign in." The provider has no
  accounts, so no account health or rotation is touched.
- Child exits before the prompt reply → 502 with exit code and bounded, redacted stderr. Stop reason `refusal` →
  `content_filter`; `max_tokens` → `max_tokens`; `cancelled` after a client abort → aborted.
- Permission requests → `cancelled` (no opt-in in this unit).

## Files

- NEW `src/adapters/agy-acp/{acp,binary,policy,adapter}.ts`, `src/server/request-peer-scope.ts`.
- `src/adapters/registry.ts` (`AdapterWire` + entry, mutation `codex-owned`), `src/adapters/base.ts`
  (`IncomingMeta.subagentFallback`), `src/server/responses/adapter-dispatch.ts` (set it),
  `src/providers/registry/entries-core.ts` (entry), `src/routing/compatibility/behavior.ts` (protocol),
  `src/config/schema/config-schema.ts` (validation), `src/server/index/serve-options.ts` and
  `src/server/index/websocket-handler.ts` (scope).
- Tests (NEW, registered in a layout shard and `tests/fixtures/test-layout-expected*.json`):
  `tests/adapters/agy-acp/agy-acp-protocol.test.ts` (framing, option matching, update mapping, -32000),
  `tests/adapters/agy-acp/agy-acp-adapter.test.ts` (fake child: one terminal event, crash is an error, permission
  refusal, model and thought-level selection, Gemini-only, login error, version gate, workspace cwd, scoped env),
  `tests/adapters/agy-acp/agy-acp-policy.test.ts` (parent-thread, combo, subagent fallback, remote and unknown scope
  refused; a local interactive turn passes), `tests/server/request-peer-scope.test.ts`, config validation cases, plus
  the registry authority and tool-conformance lists.
- Docs: `docs-site/src/content/docs/reference/adapters.md` (+ es), `docs-site/src/content/docs/guides/providers.md`
  (interactive-only use with the Google citations), `structure/adapters/registry.md` and the transport inventory.

## Verification

Failing-first per behavior; focused files; `bun run test:changed`, typecheck, `structure:check`, `privacy:scan`,
docs-site build. NOT RUN: a live `agy acp` session (CLI 1.3.3 here, not upgraded by owner decision).
