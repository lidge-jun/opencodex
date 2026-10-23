# ADR-7250 — decision recorded under "Hosted-search continuation binding"

- Contract owner: [providers-and-adapters.md](../providers-and-adapters.md#hosted-search-continuation-binding)

## Decision record

- Purpose and intent: Keep a conversation usable when replayed hosted-search history reaches a Responses request whose final tool surface declares no hosted search.
- Prior constraints and evidence: ADR-6930 rejected inferring Lite intent from absent hosted declarations, and ADR-6931 kept ordinary projection default-off. [Issue #7250](https://github.com/lidge-jun/opencodex/issues/7250) then isolated a single-variable failure on native Sol: one replayed `web_search_call` without a `web_search` declaration produced SSE `server_error`; adding only the declaration, or replacing the cell with an assistant message, completed. Community PR #7268 extended the Lite opt-in to native v2 compaction for the same failure.
- Alternatives considered: Return a local recoverable refusal; drop the cells; add a search declaration to satisfy history; or project them through the existing bounded reference-note renderer.
- Chosen approach: After bridge restoration and tool stripping, project unreferenced `web_search_call` cells with the existing renderer whenever the final body declares no `web_search*` hosted tool, for every Responses destination. Declared requests keep structural history unless the ADR-6931 opt-in applies. This does not select Lite; the absent declaration is a request-shape fact, not an inference about Lite intent, issuer or model.
- Reason for this choice: A refusal leaves the user stuck after a model switch, dropping loses the evidence, and adding a declaration would grant a capability the caller did not request. The renderer already bounds and labels the notes as untrusted data.
- Consequences and limitations: Undeclared history becomes lossy notes on every destination, including ones that may have accepted it. Same-input `item_reference` cells stay structural and may still fail upstream. Native `/responses/compact` is unchanged. Fixture validation does not establish live acceptance on every destination.
