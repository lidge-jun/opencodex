# ADR-5848 — decision recorded under "Paginated history writer boundary"

- Contract owner: [codex-home.md](../codex-home.md#paginated-history-writer-boundary)

## Decision record

- Purpose and intent: Make the remote-list visibility risk of provider-table routing explicit without changing valid history merely to satisfy a client filter.
- Existing implementation and constraints: Provider-table modes select `opencodex` for new threads, while paginated-writer safety can leave existing rows tagged `openai`. Native `thread/list` is handled directly by Codex app-server, outside the OpenCodex inference proxy. Some app-server/mobile versions scope an omitted provider filter to the default provider even though an explicit empty list returns all providers.
- Alternatives considered: Periodically relabel retained rows, proxy or patch native list RPCs, silently accept incomplete lists, or warn and document the explicit all-provider query.
- Chosen approach: Emit a sync/start warning only after the effective route actually installs a provider table, show one warning beside the active dashboard setting that enables that form, and document `modelProviders: []` for compatible list clients. Preserve provider tags and rollout bytes.
- Why this approach: Relabeling paginated history would cross the native-writer boundary and can diverge SQLite state from rollout metadata. OpenCodex has no interception point on the native RPC. A warning is the only in-repository mitigation that does not claim control over an upstream client.
- Benefits, costs and impact: Operators using the affected routing form can distinguish hidden history from deleted history without seeing a false warning on inactive settings or a failed route. The native client still needs an upstream correction, so issue #5848 remains open and the warning may be conservative on versions that already list every provider.
