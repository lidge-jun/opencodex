# TRAE CN ACP

`src/adapters/trae-cn/` runs the official TRAE CN CLI's ACP server for the `trae-cn` registry row.
TRAE owns login and refresh; OpenCodex stores no TRAE token. A fresh session supplies the account
model roster and one selected-model turn. The JSON-RPC reader bounds frames, update queues, stderr,
and request time; cancellation and cleanup terminate the child. Text and thought chunks retain their
distinct adapter events. Tool input/replay and non-text media are rejected, permission requests are
denied and terminate the session, and an internal tool turn without answer text fails with `trae_empty_response`. The CLI uses
an empty temporary workspace with disallow rules and no session MCP/skills. `src/codex/catalog/trae-cn-models.ts` publishes discovered
models as text-only and uses the shared stale/static fallback path.
