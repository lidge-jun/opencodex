# 090 — PR #293: fix(responses): ChatGPT non-stream buffer + mimo hardening

- **Author:** PyEL666
- **Branch:** fix/chatgpt-nonstrream-buffer-and-mimo-hardening → main (WRONG)
- **CI:** enforce-target FAIL (branch check)
- **Sol Review:** Curie — VERDICT: FAIL (4 high, 5 medium blockers)
- **Decision:** CLOSE + REBUILD_ON_DEV (take good ideas, fix issues)

## Sol Review Summary

### High blockers
1. **Incomplete output reconstruction** — SSE buffer handles text deltas but ignores
   function_call_arguments, reasoning summaries, refusals, annotations, content indexes.
   Rebuilt JSON can have function_call with missing arguments.
2. **False 200 on truncated streams** — response.incomplete ignored, EOF without terminal
   returns 200 "completed" instead of failing closed.
3. **Force store:false breaks contract** — overwrites explicit store:true, contradicting
   existing passthrough tests that require ID preservation when store is true.
4. **Abuse-block evasion** — auto-deleting client ID on 441/403 reverses the established
   "403 is returned as-is" contract. Abuse blocks should be surfaced, not evaded.

### Medium issues
5. Retry implementation weaker than shared upstream-retry helper
6. SSE parser doesn't implement proper SSE framing (per-line vs per-event-block)
7. Missing-content-type fallback too broad, buffered response loses headers
8. Effort mapping should use provider registry, not per-request helper
9. 145-line buffer in 1957-line handler — extract to src/responses/

## Worth Rebuilding on dev (credited to PyEL666)
- Force stream:true specifically for ChatGPT forward transport
- Buffer upstream SSE for stream:false clients (proper implementation)
- Reconstruct hollow response.completed.output with complete event model
- MiMo reasoning ladder: declare low|medium|high in registry
- Bounded MiMo transient retries via shared helper
- Do NOT keep: automatic abuse-block identity deletion
