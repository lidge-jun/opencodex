# 080 — Antigravity ACP provider (`agy acp`), issue #8480

Owner decision (lidge-jun on #8480, 2026-11-16): add the official `agy acp` transport as a **separate** provider: one
account, no automatic rotation, no remote sharing, Gemini models only. The existing `google-antigravity` provider is
unchanged. Owner-session follow-up: document the provider as interactive and user-directed only, and enforce only the
certain signals (a request carrying `x-codex-parent-thread-id`, use as a combo member, subagent-fallback routing); no
heuristics. Permission requests are refused; `--dangerously-skip-permissions` is never passed. The local `agy` is 1.3.3
and is not upgraded: tests use a fake ACP child and a live `agy acp` (>= 1.5.0) session is NOT RUN. Delivered as its own
PR from `dev` (Closes #8480), independent of #8742 and #8771; the Gemini inbound routes those PRs add are not part of
this branch, so their coverage is re-checked once both land.

Class C4: a provider that launches a local agent process, plus a request-scoped policy gate.
Revision 2 resolves audit round 1 (`.tmp/research/audit-080.md`: B1-B6); revision 3 resolves round 2 and revision 4 round 3 (R3-1 phase-aware model proof)
(`.tmp/research/audit-080-r2.md`: R2-1 pure selector resolution, R2-2 sandbox honesty, R2-3 model proof).

## Sources

- Antigravity CLI ACP: https://antigravity.google/docs/cli/acp and https://antigravity.google/docs/ide/extensions/acp/
  (the editor launches `agy acp`; sign-in is cached by `agy` or `agy acp --login`; flags `--sandbox` "Run with terminal
  sandbox restrictions enabled", `--add-dir`, `--dangerously-skip-permissions` "only in a sandboxed or disposable
  environment"; missing credentials fail with "Authentication required").
- Permissions and sandbox: https://antigravity.google/docs/permissions?tab=cli and
  https://antigravity.google/docs/sandbox?tab=cli (the CLI starts in `request-review`: commands always ask, file access is
  the workspace only, anything else asks; `--sandbox` forces the OS-level terminal sandbox where it is available, Seatbelt on macOS and
  namespaces on Linux, confining commands to the workspace, temp directories and build caches and blocking ~/.ssh and
  .env; user allow/deny rules in ~/.gemini/antigravity-cli/settings.json still apply).
- Google staff answers on personal ACP use (interactive and user-directed, not an unattended worker pool or automated
  agent loop; programmatic workloads belong on a Gemini API key or Vertex AI):
  https://discuss.ai.google.dev/t/tos-clarification-is-t3-code-official-antigravity-acp-agent-permitted-under-the-antigravity-terms-of-service/192027/2,
  https://discuss.ai.google.dev/t/policy-question-omp-hosting-unmodified-antigravity-acp-for-one-user/199753, and the
  thread cited in #8480.
- ACP v1 (agentclientprotocol/agent-client-protocol docs/protocol/v1; copies in .tmp/acp): initialization
  (`clientCapabilities`, `agentCapabilities.sessionCapabilities.systemPrompt`), session setup, session config options
  (flat or grouped select options, optional categories, `session/set_config_option` returns the complete state, a model
  change can change other options, `config_option_update` replaces the state), prompt turn (stop reasons
  `end_turn|max_tokens|max_turn_requests|refusal|cancelled`), tool calls (permission refusal shape), errors (-32000).
- Prior art: the retired Devin CLI ACP adapter (`f97612c956^:src/adapters/devin-cli/*`), reused for framing only; its
  numeric-id dispatcher, stderr echo, stop-reason passthrough and close-coupled reaping are not carried (audit notes).

## Shape

- Registry entry `antigravity-acp` (label "Antigravity CLI (ACP, local)"), adapter `agy-acp`, `authKind: "local"`,
  `dashboardPreset: true`, stable https identity URL (validated like every provider, never fetched), `liveModels: false`,
  a small static Gemini roster and default, text-only modalities, no client tools. Not featured.
- `src/adapters/agy-acp/`: `acp.ts` (pure framing and state), `options.ts` (config-option matching), `binary.ts`
  (`OPENCODEX_AGY_BIN` or `agy` on PATH; `agy --version` probe cached by resolved real path, bounded output, timeout,
  scoped env, private cwd, no shell, never run for a denied request), `policy.ts` (the gate), `process.ts` (spawn and
  process-group reaping), `adapter.ts` (`runTurn`, disabled HTTP path, side-effect-free construction).
- Spawn: `agy acp --sandbox` (never `--add-dir`, `--dangerously-skip-permissions`, `--agent` or `--login`), cwd = a fresh
  private directory per turn created with mkdtemp under the OS temp root (mode 0700), checked to be absolute and outside
  the OpenCodex home after resolving symlinks (a redirected TMPDIR/TEMP that lands inside the home is refused), with
  `TMPDIR`/`TEMP`/`TMP` pointed at a private subdirectory, environment from `baseScopedEnv()` plus `NO_COLOR`; spawn cwd and
  `session/new.cwd` are the same path; removed after the reap with a bounded cleanup. A build that rejects `--sandbox`
  exits before `initialize` and the turn fails closed (503, fixed text).

## Filesystem boundary (B4)

The promised boundary is the vendor's permission engine applied with every ask refused: the CLI starts in
request-review, where every command asks and file access outside the workspace (the empty private directory) asks, and
this client answers every ask with `cancelled`. `--sandbox` is passed as additional hardening of the agent's terminal
commands only; it is not promised. Google documents that from CLI 1.4.4, where the sandbox is unavailable (for example
Windows 10, earlier Windows 11 builds, Linux hosts or containers without the needed namespaces) `--sandbox` has no
effect, and no positive availability check is documented, so OpenCodex makes no OS-confinement claim and the docs say
the flag may be inert on such hosts. The ACP server itself is never described as sandboxed. What does not confine: the
cwd alone, and `baseScopedEnv`, which is environment hygiene that keeps HOME. Residual, documented for the user: allow
rules, allowed paths or `toolPermission` the user has set in their own agy settings still apply without prompting, and
OpenCodex does not read that file (it may hold an API key). OpenCodex never adds `--add-dir` or grants a permission to
make a turn succeed. Client `fs/*` and `terminal/*` capabilities are never
advertised; a request for them gets a fixed -32601.

## Turn sequence (B3)

1. `initialize` with `protocolVersion: 1` and `clientCapabilities: {}`; require protocolVersion 1 in the reply.
2. `session/new` with `cwd` (the private directory), `mcpServers: []`, and `systemPrompt`
   `{mode:"append",content:[{type:"text",text}]}` only when `sessionCapabilities.systemPrompt` is advertised; otherwise the
   system text leads the flattened prompt instead (never both).
3. Find the model selector: the option with category `model`, else the option whose id is `model`; none → 502
   `agy_acp_unsupported_selection`. Match the requested Gemini model against its flat or grouped values by exact value,
   else by name lower-cased with spaces as hyphens; ambiguous or none → 400 listing the Gemini values offered. Send that
   option's `value` with its real `configId`, await the reply and adopt its complete state.
4. If an effort was requested, find the thought-level option in that fresh state (category `thought_level`, else id
   `thought_level`), match `low|medium|high|xhigh|max` to `low|medium|high|extra|max` the same way, send, adopt the state.
   Not offered → 400 listing the values; no effort → unchanged.
5. Verify the acknowledged model value is the one requested (Gemini). Without a requested model, the CLI's current
   value is used only when its option name or value is a Gemini model; otherwise 400.
6. `session/prompt`. Every `config_option_update` replaces the tracked state.

Model proof is phase-aware (revision 4, audit round 3 R3-1):

- After `session/new`: the complete state must contain exactly one model selector with a resolvable `currentValue`, and
  the requested model must match exactly one advertised Gemini option. The initial `currentValue` need not be the
  requested model (the client has not changed it yet); without a requested model it must itself be a Gemini option.
- While the model setter is pending: a `config_option_update` replaces the state; it fails closed only when the selector
  is removed or its value becomes unknown or ambiguous, not because the previous Gemini selection is still active.
- After the model setter's acknowledgement, after the thought-level setter, immediately before `session/prompt`, and on
  every update during generation: exactly one selector whose `currentValue` resolves to the requested model (or, with no
  request, to a Gemini option).
- Failure before the prompt ends the turn with 502 `agy_acp_model_unproven` and no `session/prompt` is sent; during
  generation it sends `session/cancel`, refuses pending permissions, reaps and ends with 502 `agy_acp_model_switched`.
  A previous state's selector is never kept after a replacement. Offered-value lists in 400 errors contain only validated
  model or effort identifiers, never other child-authored labels.

Dispatch by frame shape: a frame with `method` and `id` is a server request (permission → exact
`{outcome:{outcome:"cancelled"}}` with the original id; anything else → -32601), `method` without `id` a notification,
`result`/`error` with `id` a reply correlated to an outstanding client request. Line, total-byte, malformed-JSON and EOF
limits as the retired module.

## Terminal outcomes (B6)

| ACP outcome | Adapter result |
| --- | --- |
| `end_turn` | done |
| `max_tokens` | done, stopReason `max_tokens` |
| `refusal` | done, stopReason `content_filter` |
| `max_turn_requests` | error 502 `agy_acp_turn_limit` |
| `cancelled` after a caller abort | aborted (no further event) |
| `cancelled` without a caller abort | error 502 `agy_acp_cancelled` (for example a refused permission) |
| missing/invalid prompt reply, exit before reply | error 502 `agy_acp_protocol` with phase and exit code |
| -32000 at any request | error 401 `authentication_error` `agy_login_required`: "Antigravity CLI is not signed in. Run `agy acp --login` (or `agy`) and sign in." |

At most one terminal event; the caller-abort path is settled by the caller's cancellation. On abort: `session/cancel` when a session exists, refuse pending permissions, then reap.

## Errors carry fixed text (B5)

Client errors and request-log text use fixed messages with a phase name, numeric JSON-RPC code or exit code and the
install/login hint. Raw stderr, raw frames, child-authored error messages, permission titles or commands, prompt text and
paths are never returned or logged. stderr is drained and discarded (bounded) so the child cannot block.

## Process lifetime

Spawn detached (own process group on POSIX); on finish, abort or timeout send SIGTERM to the group, then SIGKILL to the
group after a grace period that does not depend on the direct child's close; Windows uses `taskkill /T /F`. The workspace
is removed after the reap. Turn timeout 10 minutes, version probe 10 seconds.

## Policy gate (B1)

One predicate, `agyAcpPolicyRefusal(signals)`, used twice: a preflight in the Responses pipeline that returns an HTTP 403
before sidecars run or a streaming response is committed, and the first statement of `runTurn` (before any probe or
spawn) as defense in depth. Signals:

1. Interactive only (403 `permission_error`, code `agy_acp_interactive_only`; the message names the policy and points to
   a Gemini API key or Vertex AI): `headers.has("x-codex-parent-thread-id")`; `comboAttempt`; `subagentFallback`.
   `subagentFallback` is a typed boolean recorded where a fallback is actually selected in
   `src/server/responses/request-prepare.ts` (both selection sites), returned with the prepared state, and passed by
   `run-turn-execution.ts` into `IncomingMeta`; image and web-search sidecar metadata
   (`sidecar-execution.ts`, `images/loop.ts`) carry `comboAttempt` and `subagentFallback` unconditionally.
2. Local only (403, code `agy_acp_local_only`): `src/server/request-peer-scope.ts`, an AsyncLocalStorage snapshot
   `{local:boolean}` fixed per request or socket. HTTP: entered next to `runTurnStateCallerScope` in `serve-options.ts`
   with `ingressForServer` and `requestServer.requestIP(req)` sampled from the native request; local only for a loopback
   peer on `public`, `unauthenticated-loopback` or `claude-intercept`; `hub-link`, `hub-management` and `local-control`
   (Unix socket, no inference route today) are not local. WebSocket: `WsData` gains an immutable `peerLocal` set at both
   upgrade constructors (`serve-options.ts` ordinary upgrade, `link-websocket.ts` always false), entered in
   `websocket-handler.ts` around each frame. No snapshot → refused. Adapter unit tests enter an explicit local scope.
3. Configuration (B2), in the whole-config superRefine: an ACP provider is the canonical `antigravity-acp` id or any row
   whose effective adapter is `agy-acp`. It may not carry a populated `apiKey`, an `apiKeyPool`, account or OAuth binding
   fields, or a credential auth mode; its `models` and model aliases must be Gemini ids. References are resolved by a pure
   leaf module, `src/config/schema/agy-acp-references.ts`, that reuses the schema's lexical selector grammar and imports
   no router, routed-config, key store or runtime selection state (so validation never reads a credential and no import
   cycle forms). Combo members are read from their structured `{provider, model}` entries, every member regardless of
   disabled or cooldown state. `subagentModelFallback` / `subagentModelFallbackByModel` strings are resolved structurally:
   a `provider/model` prefix names that provider; a bare id or alias (synthetic effort suffixes stripped) yields every
   configured provider that lists it or aliases it, following alias references with a depth bound. A reference is
   refused when any candidate is an ACP provider; an unresolvable reference is not treated as allowed for this check
   (the runtime guard still refuses at dispatch). The same Gemini model on another provider stays allowed.

## Files

- NEW `src/adapters/agy-acp/{acp,options,binary,policy,process,adapter}.ts`, `src/server/request-peer-scope.ts`.
- `src/adapters/registry.ts`, `src/adapters/base.ts` (`IncomingMeta.subagentFallback`),
  `src/server/responses/{request-prepare,run-turn-execution,core-pipeline,sidecar-execution}.ts`, `src/images/loop.ts`,
  `src/server/ws-bridge.ts`, `src/server/index/{serve-options,websocket-handler,link-websocket}.ts`,
  `src/providers/registry/entries-core.ts` (or entries-extended), `src/routing/compatibility/behavior.ts`,
  `src/config/schema/config-schema.ts` (validator in a new `src/config/schema/agy-acp-validation.ts`).
- Tests (failing first, registered in layout shards and `tests/fixtures/test-layout-expected*.json`):
  `tests/adapters/agy-acp/agy-acp-protocol.test.ts`, `agy-acp-options.test.ts`, `agy-acp-adapter.test.ts` (fake child:
  sequence, grouped options, category-less ids, model-dependent thought options, mid-turn non-Gemini switch, every
  terminal row, -32000 at each phase, permission refusal shape with string and numeric ids, unsupported client requests,
  sentinel text in stderr/error.message/permission titles never surfacing, scoped env, private cwd and `--sandbox`
  argument, descendant reaping, version gate, no spawn when denied), `agy-acp-policy.test.ts`,
  `tests/server/request-peer-scope.test.ts` (HTTP local/remote/link, WebSocket after the upgrade scope ended, interleaved
  local and remote), `tests/config/agy-acp-config.test.ts` (pool, stale canonical adapter, custom row, OAuth mode, combo
  alias, disabled combo member, fallback map alias refused; the same Gemini model on `google` allowed; validation reads no
  credential, shown with an unavailable keychain reference), fake-child cases for an accepted `--sandbox` whose
  enforcement is unknown (no claim is made) and for a removed model selector and an unknown `currentValue`, a success with initial `gemini-a` and requested `gemini-b`
  (setter first, acknowledgement, then exactly one `session/prompt`), and a failed or wrong-model acknowledgement, plus the registry authority and
  tool-conformance lists and a Responses pipeline test for the preflight 403.
- Docs: `docs-site` reference/adapters (+ es), guides/providers (interactive-only use with the Google citations, local
  only, sandbox and permission behavior, residual user settings), `structure/adapters/registry.md`,
  `structure/transports/inventory.md`, manifest ownership for the new files.

## Verification

Failing-first per behavior; focused files; `bun run test:changed`, typecheck, `structure:check`, `privacy:scan`,
docs-site build; the full suite once before review readiness when the host allows. NOT RUN: a live `agy acp` session
(CLI 1.3.3 here, not upgraded by owner decision), actual sandbox confinement, Windows tree cleanup on Windows.
