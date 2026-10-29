# StepCode CLI Transport

`src/adapters/step-cli/` runs StepCode's own harness as a Step Plan transport. It shares the profile
discovery, the scoped child environment and the client tool-catalog limits with the other CLI
families, and differs from them in four contract decisions.

## Its own wire

`src/adapters/step-cli/stdio-frames.ts` implements StepCode's `step-agent-sdk` envelope: a 4-byte
big-endian length prefix, UTF-8 JSON, an 8 MiB frame ceiling and a `{protocol, version, kind, id,
method | replyTo, sequence, payload | error}` envelope. This is **not** `step --mode rpc`, which is
newline-delimited JSONL; a peer that mixes the two is answered with silence. Unknown protocol
versions pass the envelope guard so `initialize.protocolRange` can negotiate rather than being
rejected before the peer has had a chance to offer a range.

## One process per conversation

`query.input` reduces every message to text and images, so an assistant turn, a declared tool call
and its result cannot be replayed through the wire: StepCode's conversation context lives only inside
its own process. `conversation.ts` namespaces thread/affinity handles by the server's admitted
`_reasoningReplayScope.clientPrincipalId` and physical provider identity. Headers and `providerState`
cannot supply that authority. Requests without an admitted principal receive a private process that
closes when the request ends; they cannot continue a held call across requests. A process that dies
is reported rather than restarted — a restart
would lose tool results the client already delivered, which this route cannot replay from a
transcript.

Events and reverse callbacks must name the active turn's exact `queryId`. Permissions require an
owning turn and a tool in that query's declared catalog; other permissions are denied. A
`sdk_tool.invoke` is answered on the client's **next** request, with the original query and catalog.
Changing the catalog while returning a held result closes the session. Abandoning a held call
detaches its owner, interrupts it and confirms its input end before registering a replacement turn.

`session-pool.ts` latches shutdown before awaiting sessions and in-flight opens. Late opens close
their process before shutdown settles, and new opens and pool creation during proxy drain are
refused. The pool retains entries and tracks cleanup receipts from adapter, idle-timer and sweep
closes until termination is confirmed; shutdown drains those receipts and propagates failures.
Closing handles refuse replacement. Session close is idempotent and clears held-request timers.
Termination gets at most two attempts; a second failure permanently quarantines that handle in the
pool and preserves both errors as the cleanup failure's cause. Repeated closes return that failure
without restarting the retry budget. Windows teardown uses the
shared `src/adapters/coding-agent/process-tree.ts` helper (`taskkill /T /F`, bounded to five seconds)
before releasing the wrapper; POSIX sessions use a separate process group. Cleanup verifies exit
and reports failure if it cannot confirm termination. On Windows the OS PID check also handles
Bun retaining null child exit fields after an external tree kill.
Explicit registry clears await every pool and retain failed pools, so clearing state cannot bypass
quarantine. The synchronous optional shutdown hook starts the same clear and reports failure.

## Tools arrive as inline SDK tools, not an MCP catalog

The client's catalog is projected into `query.start.options.sdkTools` (`tool-bridge.ts`), each
registered by StepCode as `${serverName}__${toolName}` under the `ocx` namespace. A call comes back as
a `sdk_tool.invoke` reverse request, which the adapter captures and **holds unanswered**: it emits the
client's `tool_call` events and ends the turn with `stopReason: "tool_use"`. Nothing is invented in
between — the client executes the tool, reports it on its next request, and that report is what
releases the held reverse request into the query the model is already running. No MCP server is
staged and no tool executes inside StepCode, so approval never leaves the client.

**Bounded tool-result window.** StepCode's `SDK_TOOL_TIMEOUT_MS` is 120s and answering late produces a
`permission_denied` message inside the model's context rather than a transport error. The hold timer is
deliberately shorter and reports `step_cli_tool_result_too_late` instead of resuming a call the model
believes was denied.

## No credential, and a fail-closed capability check

The CLI resolves its own `step login`, so the child environment adds only `USER` (StepCode resolves its
sign-in by account name) and a redirected `STEP_CODING_AGENT_SESSION_DIR`. The operator's config
directory stays where StepCode put it: copying `auth.json` into `~/.opencodex` would put a second copy
of a live subscription token on disk and give this adapter a secret to redact. Host MCP servers in that
config may still initialize, which is what `--no-tools` makes unreachable. `permissionMode` and
`hasPermissionCallback` are always sent explicitly — the CLI otherwise starts in "Full Access
(auto-resume)" — and `handshake()` rejects a runtime that does not advertise `sdk-tools`, because such a
runtime answers text only while looking healthy and a routed coding session would silently degrade
into a chat.

## Module layout

`src/adapters/step-cli/` is one dependency-ordered layer per concern, so a reader looking for one
question does not have to read the whole route:

| Module | Owns |
|---|---|
| `adapter.ts` | orchestration only — what one turn is, in what order, when it is terminal |
| `conversation.ts` | conversation identity (which thread owns which process) and turn ordering |
| `events.ts` | what the CLI says and what this peer owes it back |
| `projection.ts` | pure request/response conversions, testable without a session |
| `registry.ts` | state that must outlive a request, plus shutdown wiring |
| `errors.ts` | failure text and the status a client can retry on |
| `session.ts` / `session-pool.ts` / `stdio-frames.ts` | the framed transport itself |
| `env.ts` / `profiles.ts` / `constants.ts` | the scoped child environment, binary discovery and shared identifiers |

The graph is one-way: `adapter` → {`conversation`, `events`, `projection`, `registry`, `errors`},
`events` → {`projection`, `registry`}, and nothing imports `adapter`. Two edges are cut to keep it that
way — `poolFor` receives the session handlers as an argument instead of importing `events`, and the
idle timeout lives in `registry` next to the pool that reads it. `events` reaches turn state only
through `registry`'s accessors (`currentTurn`, `endTurn`, `recordAssistantUsage`, …), never by
touching its maps, so the storage shape can change without every caller changing with it.

## Tool-catalog ceiling (shared with the CLI family)

The client's tool catalog travels as inline-schema `sdkTools`, but it is still built by the shared
`buildCodingAgentToolCatalog`, so this route inherits the same **128-tool / 2 MiB** ceiling that
`codebuddy`, `qoder` and `claude-cli` enforce. A real Codex client can exceed it: Codex 0.162.0 was
measured sending **1749 declared tools / 2.5 MB**, because it flattens every MCP server's tools into the
function catalog. The route fails closed — a tool the client believes exists but that never reaches the
model is worse than a refusal — and the refusal names the declared count, the ceiling and the operator
action, since "exceeds tool count limit" alone cannot distinguish an oversized catalog from a malformed
one. A stock Codex install without MCP servers carries roughly ten built-in tools and works.

Raising the ceiling for this transport alone is technically affordable (the catalog rides in one frame
under an 8 MiB ceiling rather than a staged file), but it is deliberately NOT done here: it would change
a bound the sibling routes share, and 2.5 MB of tool schemas is not something to push into a model
prompt anyway. That is a family decision for maintainers, and this PR only makes the constraint visible.

## Published contract

The registry row publishes text-only models: `noVisionModels` covers every id, including
`step-5-preview` and `step-3.7-flash`, which accept images upstream, because nothing verifies that a
headless StepCode turn hands image bytes to the model. Only the three reasoning rungs Step serves are
advertised — `xhigh` and `max` are mapped server-side onto `high` and must not be offered as if the
client had chosen them. The four `stepaudio-*` entries the same catalog endpoint returns are absent
from the roster: they hold no chat tools and answer `model_invalid` on a text turn. The CLI's session
system prompt cannot be replaced through this protocol, so the client's instructions are prepended to
the turn and the registry note says so.

Tests: `tests/adapters/step-cli-frames.test.ts`, `tests/adapters/step-cli-session.test.ts`,
`tests/adapters/step-cli-tool-bridge.test.ts` and `tests/providers/step-cli-provider.test.ts`. The
session tests drive a scripted peer, so permission hand-off, tool capture, the held reverse request
and the single release of a tool result are all asserted without a real CLI or a real model call.
Caller/query/catalog isolation is covered by `tests/adapters/step-cli-ownership.test.ts` and
`tests/adapters/step-cli-query-race.test.ts`; shutdown races and a real dispatcher/descendant fixture
are covered by `tests/adapters/step-cli-process-lifecycle.test.ts`. Cleanup failure, bounded recovery,
handle quarantine and already-started shutdown drains are covered by
`tests/adapters/step-cli-cleanup-ownership.test.ts`.
