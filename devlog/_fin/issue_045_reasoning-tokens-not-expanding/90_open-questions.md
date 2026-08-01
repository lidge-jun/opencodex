# 90 — Open questions

- [ ] Is `reasoning_content` (openai-chat adapter) the ONLY producer of
      `reasoning_raw_delta`? If yes → retire the raw content channel safely
      (approach A). If no → keep it and gate the reroute (approach C).
- [ ] Global reroute vs provider-gated? Default: global (A). Gate only if a
      provider needs raw `content` preserved.
- [ ] Should the final item include BOTH summary and content for maximum
      client compatibility, accepting dedupe risk? (approach B) — default no.
- [ ] Confirm `hideThinkingSummary` should also suppress routed reasoning_content
      (treat identically to thinking). Default: yes (same human-visible thinking).
- [ ] Any downstream opencodex consumer (logs/usage) that reads the reasoning
      `content` field and would break if it moves to `summary`?
