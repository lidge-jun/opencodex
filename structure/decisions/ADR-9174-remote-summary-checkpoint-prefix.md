# ADR-9174: decision recorded under "Decoded checkpoint continuation"

- Contract owner: [transports/responses.md](../transports/responses.md#decoded-checkpoint-continuation)
- Purpose: stop routed Anthropic summaries from rewriting the whole cached prompt on every
  compaction after the first one (#7307).
- Prior constraint: ADR-7003 excludes compaction/summarizer turns from the continuation note, and
  #7822 also kept remote `compaction_trigger` summaries out of historical framing. After a portable
  checkpoint, the ordinary request carries the note at the end of its system prompt and frames
  retained requests as history; the remote summary that extends it carried neither. Anthropic
  caches tools, system and messages in that order, so the summary missed the cache from the system
  block on.
- Alternatives: keep the exclusion and accept the rewrite on every later compaction; or add the
  note to every summary in the parser, which also changes routes that do not preserve the prefix
  and gains nothing there.
- Choice: a remote `compaction_trigger` summary gets the historical framing of the ordinary request
  it extends, on every route. The parser still excludes the note from every summary and sets
  `_summaryCheckpointNote` after a decoded checkpoint; only the prefix-preserving Anthropic route
  appends `CHECKPOINT_CONTINUATION_NOTE` at the ordinary request's position. Client-side summarizer
  turns ending in `COMPACT_PROMPT` keep the ADR-7003 exclusion, and plaintext framing still adds no
  note to a remote summary.
- Why the note on that summary is acceptable: the appended summary prompt ("Return only the handoff
  summary. Do not call tools or continue the task.") asks for a handoff summary, and the note itself
  is conditional. The compaction summary guard rejects tool calls, empty summaries and abnormal
  endings; it does not check that the text is a summary.
- Consequences: from the second compaction on, the Anthropic summary reads the ordinary request's
  cached prefix instead of rewriting it. A plaintext `SUMMARY_PREFIX` checkpoint followed by a
  remote trigger still differs by the note, which plaintext framing places in `instructions`.
- Evidence boundary: JSON/SSE prefix-equality tests and a non-preserving route control cover the
  request construction. One live A/B run (`claude-opus-5-5`, four compactions per arm) showed the
  cache read on compactions 2-4 rising from 10,353 tokens to the preceding request's full input,
  with summaries of similar structure; that is a small sample, not a quality benchmark.
