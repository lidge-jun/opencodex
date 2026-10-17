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
its own process. `session-pool.ts` therefore keys long-lived processes by the handle the client echoes
back through `providerState`, and a process that dies is reported rather than restarted — a restart
would lose tool results the client already delivered, which this route cannot replay from a
transcript.

`permission.request` is answered immediately because the approval already happened upstream of the
adapter. A `sdk_tool.invoke` is answered on the client's **next** request, not this one.

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
