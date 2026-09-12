# ADR-0022 — decision recorded under "Routed tool discovery and hosted search"

- Contract owner: [catalog.md](../catalog.md#routed-tool-discovery-and-hosted-search)

## Decision record

- 목적과 의도: keep routed plugin/MCP tools reachable without paying the full-catalog turn-1 payload tax or starving Cursor's unified execution bridge.
- 기존 구현 및 제약 조건: #1596 restored deferred discovery only for non-Cursor rows because Cursor bypasses the hosted-search sidecar; codex-rs treats deferred exposure and hosted search as separate capabilities, and Cursor independently enforces a 120,000-byte serialized tool-catalog limit.
- 검토한 주요 대안: keep Cursor opted out, raise/disable Cursor's transport ceiling, synthesize another execution bridge, or enable Cursor-native local exec only when the bridge disappears.
- 선택한 방식: enable Codex deferred exposure for Cursor code-mode rows too, while continuing to omit Cursor's hosted `web_search_tool_type`.
- 다른 대안 대신 이 방식을 선택한 이유: it removes the known exec-description inflation before Cursor budgeting without weakening the measured transport limit, inventing caller tools, or turning bridge absence into local-execution authority.
- 장점, 단점 및 영향: Cursor keeps a compact Responses-owned `exec` path under rich tool catalogs and hosted-search behavior remains unchanged; the existing Cursor budget and native-local-exec fail-closed policy remain authoritative.
