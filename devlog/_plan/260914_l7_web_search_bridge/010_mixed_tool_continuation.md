# 010 — mixed-tool continuation

## What already landed

PR 4515 armed the non-Ollama bridge backends and said plainly that it does not
close the issue. The remainder is one branch in `BridgeStreamState.decide()`:
a leg carrying both an intercepted `web_search` call and a client-executed call
returns `kind: "fail"` with `web_search_bridge_mixed_tools`. The stream then
closes the hosted cell as failed and drops the held client call, so Codex App
reconnects five times and the turn dies.

## The shape of the fix

A mixed leg ends the turn on that leg instead of failing it:

1. Execute the intercepted search exactly as the non-mixed path does — same
   budget accounting, same query parsing, same completed `web_search_call` cell.
2. Flush the held client call so Codex runs it, with its `call_id`, item id, and
   streamed order intact.
3. Emit the leg's own terminal.

No continuation leg is sent upstream. That is the whole point: the client's tool
call is unanswered, so the conversation has to go back to the client, not to the
gateway.

## What this does not fix

The upstream gateway never sees the search result. Codex replays the hosted
`web_search_call` cell on the next turn, which carries the query and sources but
no result text, and the gateway's own `function_call` / `function_call_output`
pair is not reconstructed. Making it whole needs an inbound rewrite applied to
the outbound body **before** the first leg is dispatched, and the only place that
can happen is `src/server/responses/core.ts`, which is outside this lane's write
scope. The turn now survives and the model can re-search on the following turn;
the replay remains open.

Pre-existing and unchanged: a hosted `web_search_call` item synthesized by the
bridge already reaches the gateway on later turns in the non-mixed path too.

