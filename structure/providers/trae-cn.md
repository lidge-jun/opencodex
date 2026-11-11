# TRAE CN ACP

`src/adapters/trae-cn/` runs the official TRAE CN CLI's ACP server for the `trae-cn` registry row.
TRAE owns login and refresh; OpenCodex stores no TRAE token. A fresh session supplies the CLI-reported
model roster and one selected-model turn. The vendor does not document the discovery fields or
guarantee their account scope. The JSON-RPC reader bounds frames, update queues, stderr,
and request time; cancellation and cleanup terminate the child. Text and thought chunks retain their
distinct adapter events. Tool input/replay and non-text media are rejected, permission requests are
denied and terminate the session. Tool notifications fail with `trae_tool_call_unsupported`; only a
normal `end_turn` completion without text fails with `trae_empty_response`. An outputless `max_tokens`
completion retains its truncation verdict and maps to an incomplete Responses result. ACP
`max_turn_requests` emits an incomplete turn with that limit reason and retains partial text and usage.
Empty completions and unsupported stop reasons retain reported usage in their terminal error. Refusals
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
cache before attaching its revision. Relative PATH, user-local fallback entries and the original CLI home resolve before the child changes its cwd.
Windows home fallback discovery uses the same native-before-launcher order as PATH, including `traecli.cmd`.
Custom catalog rows and combo members receive the wire modality/verbosity ceiling before optional sidecar publication.

Cancellation is bound before the first initialization RPC. Pending RPCs fail as shutdown starts;
stdin errors enter the same failure path. Shutdown terminates the POSIX process group or Windows
Job Object and bounds both process and stream waits. The POSIX supervisor in
`src/adapters/trae-cn/process.ts` keeps its group leader alive after the CLI exits. The parent requests
shutdown through a private pipe; live group members signal group 0, so numeric group-ID reuse cannot
target an unrelated group. Descendants that detach into another group are outside this cleanup scope.
On Windows 10+, `src/adapters/trae-cn/windows-job.ts` launches a PowerShell 5.1 supervisor with
atomic Job List and handle-list process attributes. It owns descendants even after a dispatcher
exits, denies breakaway, and kills members when its private Job handle closes. CLI stderr travels
as bounded base64 frames; only supervisor frames can attest that the Job has no active members.
Scoped Windows environment keys are matched case-insensitively, and the native launch receives an
absolute executable/dispatcher path. Unsupported supervision fails before launching an unowned CLI.
No numeric PID is reopened.
Unconfirmed shutdown is an error and retains owned temporary files; the adapter publishes its terminal
event only after the parent has bounded both supervisor and stream waits. The parent keeps draining
stderr after it suppresses diagnostic retention and attempts forced termination if the supervisor misses its deadline.
Missing Job accounting proof remains an error, including when a status write cannot be delivered.
Received usage is preserved even when cleanup fails. A failed workspace allocation removes an
already-created owned HOME. Prompt dispatch alone consumes and reports the reserved send. The adapter
also emits a replay-unsafe heartbeat at that write, so combo preflight cannot resend the turn
after an empty result or another post-dispatch failure. Startup failures and unavailable models
return unused reservations and keep their existing routing policy.
Local spend-ledger file refusals propagate to the shared local-storage 503 mapping, with producer cleanup, before ACP error classification.
Replay over 1,000,000 UTF-16 code units is
rejected before startup. Unexpected EOF diagnostics retain bounded, redacted stderr after process
cleanup, including stderr that arrives after stdout closes. Once stderr exceeds 8192 characters,
all diagnostic text is suppressed so truncation cannot separate a secret from its redaction label.
Malformed stdout produces fixed protocol diagnostics, never the shared JSONL parser's snippets.
Byte-limit failures retain `trae_stdout_limit`; startup failures retain a stage and allowlisted errno.
POSIX launch exits 126/127 before initialization report safe startup codes via the private control pipe.
Prompt completion closes the bounded update stream once, without a new promise reaction per chunk.
Client cancellation emits no provider error; received usage survives cleanup cancellation in a
`client_cancelled` incomplete outcome and is bound before a closed client stream can drop it. An upstream cancellation without client abort emits
an incomplete event with usage. Explicit output-token limits are refused before startup.
A successful `session/set_model` acknowledgement supersedes prior setup model notifications.
The reader then validates subsequent model changes against the selected id, before or during prompt dispatch.
The finite CLI tool denylist and
disabled ACP client capabilities do not sandbox CLI-side hooks or unlisted vendor tools.

`src/server/management/trae-cn-provider-probe.ts` opens and closes a direct ACP session for the
connection test and replaces the unchanged generation's cached roster after success. It requests
catalog convergence and refreshes previously connected clients through the owned integration writer.
The successfully probed roster is pinned in the shared model cache until both operations finish.
Shared-budget admission can demote reclaimable continuation state before retaining that roster;
the pin is bounded by the model-cache owner's 8 MiB/16-entry cap and released on every outcome.
An authority clear still revokes the roster while its detached bytes remain accounted until release.
If admission is refused, the probe reports `rosterRetentionPending` and an admission failure without
starting another CLI session or claiming roster publication.
The response separates connectivity from catalog/client publication and notes the running Codex
session restart requirement. Invalidation before the cache write reports `rosterReplaced: false`
and asks for another test. Invalidation after that write does not undo the historical `true` result.
Disk-only edits do not invalidate the running process's cache generation.
It never probes the vendor
website or accepts a cached roster as login evidence. The cache remains provider-scoped, so account
switches require this explicit refresh. Each prompt still checks its model against a new session roster.

User setup: [TRAE CN guide](../../docs-site/src/content/docs/guides/trae-cn.md).

The adapter regression file includes a sanitized session/model response captured from CLI 0.120.19.
Its installed-CLI discovery check runs only with `OCX_TRAE_CN_LIVE_TEST=1`, an absolute
`OCX_TRAE_CN_LIVE_BINARY` and an explicit absolute `TRAE_HOME` containing an existing sign-in.
Test HOME isolation stays enabled. The check opens and closes a session without sending a model
prompt; ordinary tests remain offline.
