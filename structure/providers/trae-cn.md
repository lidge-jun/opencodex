# TRAE CN ACP

`src/adapters/trae-cn/` runs the official TRAE CN CLI's ACP server for the `trae-cn` registry row.
TRAE owns login and refresh; OpenCodex stores no TRAE token. A fresh session supplies the account
model roster and one selected-model turn. The JSON-RPC reader bounds frames, update queues, stderr,
and request time; cancellation and cleanup terminate the child. Text and thought chunks retain their
distinct adapter events. Tool input/replay and non-text media are rejected, permission requests are
denied and terminate the session. Tool notifications fail with `trae_tool_call_unsupported`; only a
normal `end_turn` or `max_tokens` completion without text fails with `trae_empty_response`. Refusals
emit a non-retryable `content_filter` incomplete event with usage. The CLI uses
an empty temporary workspace with disallow rules and no session MCP/skills. `src/codex/catalog/trae-cn-models.ts` publishes discovered
models as text-only with verbosity disabled, including configured ids outside the seed list. All
cached fallbacks reapply current caps and retention; a cold failure also observes discovery cooldown.
`liveModels: false` bypasses ACP discovery. Static and discovered rows enforce the wire's text-only
and no-verbosity limits after config hints. Vision classification and preprocessing enforce the same
limit before per-model overrides; only sidecar publication can advertise image attachments.
The CLI inherits an absolute `TRAE_HOME` when selected by the operator, otherwise the original
user home plus `.trae`, before HOME isolation. Provider `proxy`/`noProxy` overrides
are refused before CLI startup, including explicit direct routing.
Observed-auth gathers use only cached evidence; only refreshing gathers and explicit connection
probes may launch the CLI. Management convergence refreshes CLI-owned evidence before catalog
admission, so a cold automatic tick can populate it. Lost-generation discovery rereads the current
cache before attaching its revision. Relative PATH entries resolve before the child changes its cwd.
Custom catalog rows receive the wire modality/verbosity ceiling before optional sidecar publication.

Cancellation is bound before the first initialization RPC. Pending RPCs fail as shutdown starts;
stdin errors enter the same failure path. Shutdown terminates the POSIX process group or Windows
process tree and bounds both process and stream waits. The POSIX supervisor in
`src/adapters/trae-cn/process.ts` keeps its group leader alive after the CLI exits. The parent requests
shutdown through a private pipe; live group members signal group 0, so numeric group-ID reuse cannot
target an unrelated group. Descendants that detach into another group are outside this cleanup scope.
Unconfirmed shutdown is an error; the adapter publishes its terminal event after cleanup. A failed workspace allocation removes an
already-created owned HOME. Prompt dispatch alone consumes and reports the reserved send; startup
failure or unavailable models return unused reservations. Replay over 1,000,000 UTF-16 code units is
rejected before startup. Unexpected EOF diagnostics retain bounded, redacted stderr after process
cleanup, including stderr that arrives after stdout closes.
Malformed stdout produces fixed protocol diagnostics, never the shared JSONL parser's snippets.
Byte-limit failures retain `trae_stdout_limit`; startup failures retain a stage and allowlisted errno.
Prompt completion closes the bounded update stream once, without a new promise reaction per chunk.
Client cancellation emits no provider error; an upstream cancellation without client abort emits
an incomplete event with usage. Explicit output-token limits are refused before startup.
Model-selection notifications must match the requested model. The finite CLI tool denylist and
disabled ACP client capabilities do not sandbox CLI-side hooks or unlisted vendor tools.

`src/server/management/trae-cn-provider-probe.ts` opens and closes a direct ACP session for the
connection test and replaces the unchanged generation's cached roster after success. It requests
catalog convergence and refreshes previously connected clients through the owned integration writer.
The response separates connectivity from catalog/client publication and notes the running Codex
session restart requirement. An overtaken probe reports `rosterReplaced: false` and asks for another
connection test; it cannot replace the new roster.
It never probes the vendor
website or accepts a cached roster as login evidence. The cache remains provider-scoped, so account
switches require this explicit refresh. Each prompt still checks its model against a new session roster.
