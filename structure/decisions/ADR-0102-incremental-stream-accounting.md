# ADR-0102 — decision recorded under "Usage accounting"

- Contract owner: [Dashboard and usage](../dashboard-and-usage.md#usage-accounting)

## Decision Log

- Purpose and intent: Keep proxy CPU and temporary allocation proportional to newly received bytes,
  even when providers or child agents fragment a large logical frame into tiny chunks.
- Existing implementation and constraints: Serialized tool-call reconciliation must preserve exact
  text and Markdown context; coding-agent JSONL must preserve streaming UTF-8, BOM, newline, and
  byte-ceiling behavior; usage snapshots must still detect same-inode rewrites before reuse.
- Alternatives considered: Lower existing size limits; periodically flatten and rescan retained
  text; use wall-clock performance assertions; or retain incremental parser/digest state.
- Selected approach: Scan only each new segment plus fixed delimiter overlap, maintain decoded JSONL
  line-byte accounting while joining once per completed frame, and reuse a verified usage digest
  only when both digest bounds are identical to the returned region.
- Why this approach: Smaller limits reduce functionality without removing quadratic work. Incremental
  state preserves the existing wire contracts and gives deterministic work-count regression tests.
- Benefits, tradeoffs, and impact: CPU and cumulative allocation become linear for fragmented
  streams and unchanged usage polling avoids a duplicate synchronous hash. The parsers carry small
  additional state, and any change in usage-region bounds still requires a fresh digest.
