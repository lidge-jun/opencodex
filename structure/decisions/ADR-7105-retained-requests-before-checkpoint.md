# ADR-7105: decision recorded under "Retained requests before a plaintext checkpoint"

- Purpose: follow-up to #6764 and ADR-7003. Codex's replacement history after a compaction is the
  recent user requests followed by one `SUMMARY_PREFIX` checkpoint message (codex-rs
  `build_compacted_history`; `buildCompactV1Output` for routed summaries). The retained requests
  stay imperative user text, and routed models repeat a request the checkpoint reports as done.
- Prior constraint: the ADR-7003 continuation note applies only to decoded `ocx1:` items, so the
  plaintext checkpoint that Design B remote compaction v1 and client-side compaction produce
  receives no note. `SUMMARY_PREFIX` is an exact marker and stays unchanged.
- Evidence that motivated the choice (manual replays against Claude Opus, Sonnet and Haiku through a
  Responses gateway, recorded in the pull request, not in tests): with the requests retained the
  model continued the active task in 0 of 12 runs; with them removed, 24 of 24 offline and 12 of 12
  through a running proxy; a later user instruction was followed in 9 of 9. A prompt line alone did
  not move Haiku in the #7003 review.
- Alternatives: extend the note to plaintext checkpoints (prompt-only, insufficient above); rewrite
  the retained requests as quoted history (8 of 12, and it alters text the user wrote); stop
  retaining requests in `buildCompactV1Output` (does not reach threads compacted earlier, by Codex
  itself, or through client-side compaction).
- Choice: an opt-in, request-local removal on the raw body before parsing, default off, applied to
  every route, keeping contextual wrappers, non-text content and compaction requests.
- Consequences: absent or off is byte-identical. On, the model sees only the checkpoint's account of
  earlier requests, so detail the summary dropped is gone for that turn. Codex's stored thread is
  not modified; the proxy's continuation cache holds the shortened input until Codex next sends the
  full history.
