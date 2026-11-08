# TRAE CN ACP

`src/adapters/trae-cn/` runs the official TRAE CN CLI's ACP server for the `trae-cn` registry row.
TRAE owns login and refresh; OpenCodex stores no TRAE token. A fresh session supplies the account
model roster and one selected-model turn. The JSON-RPC reader bounds frames, update queues, stderr,
and request time; cancellation and cleanup terminate the child. Text and thought chunks retain their
distinct adapter events. Tool input/replay and non-text media are rejected, permission requests are
denied and terminate the session, and an internal tool turn without answer text fails with `trae_empty_response`. The CLI uses
an empty temporary workspace with disallow rules and no session MCP/skills. `src/codex/catalog/trae-cn-models.ts` publishes discovered
models as text-only with verbosity disabled, including configured ids outside the seed list. All
cached fallbacks reapply current caps and retention; a cold failure also observes discovery cooldown.
`liveModels: false` bypasses ACP discovery. The CLI inherits `TRAE_HOME` when selected by the operator.

Cancellation is bound before the first initialization RPC. Pending RPCs fail as shutdown starts;
stdin errors enter the same failure path. Shutdown terminates the POSIX process group or Windows
process tree and bounds both process and stream waits. A failed workspace allocation removes an
already-created owned HOME. Prompt dispatch alone consumes and reports the reserved send; startup
failure or unavailable models return unused reservations. Oversized replay is rejected before startup.

`src/server/management/trae-cn-provider-probe.ts` opens and closes a direct ACP session for the
connection test and invalidates the provider catalog after success. It never probes the vendor
website or accepts a cached roster as login evidence. The cache remains provider-scoped, so account
switches require this explicit refresh. Each prompt still checks its model against a new session roster.
