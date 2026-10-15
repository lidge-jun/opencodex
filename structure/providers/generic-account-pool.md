# Generic OAuth Account Pool

## Conversation affinity

`src/oauth/generic-session-affinity.ts` owns opt-in generic-pool conversation bindings. Provider-local
`oauthAccountFailover.sessionAffinity: "conversation"` requires proactive enablement; it does not
change reactive failover activation. Bindings are scoped to configuration home, provider and caller
principal, store only a hashed session key, account ID and selection receipt, and expire after 24 idle
hours within a process-wide 2,000-entry bound. Pause, reauth, model/family ineligibility and persisted
selection-revision changes release them. Cross-process revisions are checked on every lookup.
`src/oauth/session-affinity-key.ts` supplies the existing client-thread/header/cache-key precedence
for both generic and Anthropic callers; shared Desktop cache cohorts do not establish identity.

`src/server/responses/request-transport.ts` admits every automatic generic affinity-mode choice
without persisting an active-account change, including new/unkeyed sessions and failovers. The
operator's saved selection/revision fences queued sends independently of each conversation's serving
snapshot and credential generation. An unchanged selection with a renewed credential re-resolves
that same account; a changed selection follows the operator. Off-active 401 refresh remains bound
to the sent account. Admitted replacements rebind; affinity hits do not advance round-robin.
Fill-first has a bounded process-local cursor and prefers below-threshold alternatives without
moving the persisted selection. Kiro capacity retains wait/refusal semantics. Codex and Anthropic
are excluded. `tests/oauth/generic-session-affinity.test.ts` and
`tests/server/server-generic-oauth-affinity.test.ts` exercise these boundaries with synthetic accounts.

`src/types/provider.ts` declares the optional `sessionAffinity` mode; omission keeps existing behavior.
