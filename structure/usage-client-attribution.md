# Usage client attribution

`src/usage/client.ts` defines the closed client-attribution roster and recognizes bounded
request-header signatures without retaining the header values. HTTP request contexts in
`src/server/index/` and the Responses WebSocket handshake carry that observational label through
`src/server/request-log.ts` projection and `src/usage/log.ts` normalization. Older rows without
the field remain absent, while invalid present values become `unknown`. Combo child adoption
cannot replace the inbound label. The label is caller-supplied evidence, not an authorization
decision. `tests/usage/usage-client-attribution.test.ts` covers the normalization boundary.
