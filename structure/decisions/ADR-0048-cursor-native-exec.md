# ADR-0048 — Cursor Native Exec

- Contract owner: [providers/cursor.md](../providers/cursor.md#cursor-native-exec)

## Decision record

- 목적과 의도: keep fresh Cursor-routed Codex Desktop subagents able to invoke the actual unified `exec` tool exposed by their client catalog.
- 기존 구현 및 제약 조건: catalog truncation already pinned `exec`, but the later generic-tool filter recognized only bare `exec_command`/`shell_command` and could erase the sole executable client tool while also naming aliases that were absent.
- 검토한 주요 대안: synthesize a legacy alias, execute `exec` through Cursor native-local-exec, disable generic filtering, or treat every Responses-owned execution-path tool as eligible.
- 선택한 방식: preserve the existing client tool and schema by filtering with `isCursorExecutionPathTool`; keep alias-specific prompt guidance gated on an alias actually being present.
- 다른 대안 대신 이 방식을 선택한 이유: Codex Desktop remains the execution and approval authority, no unavailable tool name is invented, and the existing Responses MCP suspension path can relay the call without widening native execution privileges.
- 장점, 단점 및 영향: unified `exec` survives the filter and returns to Desktop for execution; legacy aliases behave as before; `wait` and unrelated tools remain excluded from generic tool-count prompts.
