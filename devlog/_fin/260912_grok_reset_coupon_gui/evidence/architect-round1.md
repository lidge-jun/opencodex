# Architect review round 1 (read-only subagent)

Full verdict retained in the session transcript. Findings carried into
`010_architect_dispositions.md` as D1-D6 with main dispositions. Headline items:

- D2: one scalar generation ref cancels sibling reads on a single-row refresh.
- D3b: a settled failure replays as HTTP 200 `replayed:true`; the client announced it as success.
- D3a: a still-`open` journal record re-executes, so one confirmation can spend two coupons (backend residual).
- D4a: fetch filter and render guard use different reauth predicates.
- D5a: seven locale catalogs missing all new keys; parity test fails.
