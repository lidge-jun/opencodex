# wp14 — #2816 + PR #2817 opt-in upstream Responses WebSocket transport (carry)

Investigation (grok subagent Turing): opt-in `providers.<name>.upstreamWebsocket` boolean; hook in
`providerFetch` via `shouldUseCodexWsUpstream`; HTTPS `/responses` only; SSE fallback on any
pre-open failure (426 included); fail-closed `response.done` mapping; no core-lab or startServer
changes; no body/token logging. macOS red on the PR head was the known `server-auth` websocket
passthrough flake; Linux shards green. 139 behind dev, one conflict in provider-routes.ts POST
overwrite block (retainModels/displayNames vs upstreamWebsocket omit-preserve).

## Decision
Carry by merge in a side worktree (/tmp/ocx-wp14-c94721, branch `codex/carry-2817-upstream-ws`); conflict resolved by
subagent keeping both omit-preserves; tsc/privacy/focused green at `d4914f52d`. Land via new PR,
close #2817 as landed-via-carry, close #2816.

