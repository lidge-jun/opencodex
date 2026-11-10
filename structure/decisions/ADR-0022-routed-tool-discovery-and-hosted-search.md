# ADR-0022 — decision recorded under "Routed tool discovery and hosted search"

- Contract owner: [catalog.md](../catalog.md#routed-tool-discovery-and-hosted-search)

## Decision record

- 목적과 의도: keep routed plugin/MCP tools reachable without paying the full-catalog turn-1 payload tax or starving Cursor's unified execution bridge.
- 기존 구현 및 제약 조건: #1596 restored deferred discovery only for non-Cursor rows because Cursor bypasses the hosted-search sidecar; codex-rs treats deferred exposure and hosted search as separate capabilities, and Cursor independently enforces a 120,000-byte serialized tool-catalog limit.
- 검토한 주요 대안: keep Cursor opted out, raise/disable Cursor's transport ceiling, synthesize another execution bridge, or enable Cursor-native local exec only when the bridge disappears.
- 선택한 방식: enable Codex deferred exposure for Cursor code-mode rows too, while continuing to omit Cursor's hosted `web_search_tool_type`.
- 다른 대안 대신 이 방식을 선택한 이유: it removes the known exec-description inflation before Cursor budgeting without weakening the measured transport limit, inventing caller tools, or turning bridge absence into local-execution authority.
- 장점, 단점 및 영향: Cursor keeps a compact Responses-owned `exec` path under rich tool catalogs and hosted-search behavior remains unchanged; the existing Cursor budget and native-local-exec fail-closed policy remain authoritative.

## Decision record — eagerly expanded Codex MCP catalogs (#8133)

- 목적과 의도: tell an operator when a Codex client expands every MCP tool into the request, which usually means its model metadata is missing or stale and every turn pays the full-catalog payload.
- 기존 구현 및 제약 조건: an eager catalog is a valid request, and no supported-version evidence shows that every client sending 64+ eager MCP tools has stale metadata (an older client or disabled tool search may send one legitimately). Codex resends the window's catalog at the head of every request, including after a resumed turn's replayed calls, so position alone cannot separate the current request's declarations from the proxy's own restored history: only `previous_response_id` replay provenance can, and that prefix exists only after expansion.
- 검토한 주요 대안: refuse with HTTP 400 `codex_catalog_reload_required`; refuse with a config opt-out; warn without refusing.
- 선택한 방식: warn at `EAGER_CODEX_MCP_TOOL_WARNING_THRESHOLD` (64), logging only the count and threshold, and forward the request unchanged. Count top-level `tools`, every client-sent `additional_tools` item, and rendered Code Mode sections, after `expandPreviousResponseInput` and with its replay prefix excluded. Dedup is once per session; without a session identity it is once per logical request, and the session set is a bounded LRU so the evicted entry is the longest-idle session.
- 다른 대안 대신 이 방식을 선택한 이유: a refusal turns a recoverable cost problem into a hard outage for any client the heuristic misjudges, and its remedy cannot help a client whose catalog is eager by design. The diagnostic keeps every existing request working.
- 장점, 단점 및 영향: no request changes behavior; operators get one actionable line per session, or per anonymous request, counting what that request actually pays for. A stale client keeps paying the larger payload until it is restarted, and an install running more than the 1024-session bound can see one repeat warning from the longest-idle evicted session.
