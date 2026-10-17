# ADR-6931 — decision recorded under "Hosted-search continuation binding"

- Contract owner: [providers-and-adapters.md](../providers-and-adapters.md#hosted-search-continuation-binding)

## Decision record

- Purpose and intent: Require an explicit provider opt-in before ordinary Codex Responses Lite requests lose structural hosted-search history.
- Prior constraints and evidence: ADR-6930 records the contributor's earlier Lite-intent boundary and its unverified live acceptance. The [project owner's review requirement](https://github.com/lidge-jun/opencodex/pull/6930#issuecomment-6188875868) requires default-off configuration before review because that lossy ordinary behavior must not become the default before live acceptance.
- Alternatives considered: Keep projection on for all explicit Lite requests; remove ordinary projection entirely; or add a provider switch without retaining the existing destination and Lite gates.
- Chosen approach: Add optional strict boolean `providers.<name>.projectResponsesLiteHostedSearchHistory`, default off. The final ordinary builder projects only when its selected provider value is exactly boolean `true`, the final URL is exact canonical ChatGPT Codex `/responses`, and the final request explicitly selects Lite under the existing literal-header/valid-string-map-metadata precedence. Omission, `false`, and malformed runtime values do not enable projection.
- Reason for this choice: Operators can explicitly evaluate the existing lossy policy while ordinary Lite requests keep structural history by default. Provider intent supplements the current protocol and destination boundaries without inferring historical issuer, model capability, or live acceptance.
- Consequences and limitations: Bridge restoration still runs first; same-input references still exempt their hosted cells after existing `store:false` handling. Opted-in notes retain the existing untrusted bounded metadata contract. Native compact, public API and other destinations remain unchanged; portable/routed compaction projection retains its existing triggers and defaults. The switch neither selects Lite nor changes headers, metadata, transport, diagnostics, retries, or the summarizer. Fixture validation does not establish ordinary live HTTP/WS acceptance or resolve all upstream errors. ADR-6930 remains historical and is not rewritten.
