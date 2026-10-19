# Chat raw reasoning summary compatibility

Target: opt-in verbatim Chat reasoning on the Responses summary channel, leaving defaults unchanged.
Base: c344c6ca10e5b9223ade9a2843ea9f14d000b26c; PR targets dev.

Related history: issue #45, PR #2007 (default summary mapping later reverted), PR #6170 (hideRawReasoning).

2026-10-19: existing regressions reproduced 4 failures / 5 passes before implementation.
Implementing rawReasoningAsSummary, strict boolean, final openai-chat route + Responses inbound only.
Explicit summary none and hideRawReasoning win. Keep txt envelope and tool replay cache.
Provider saves preserve the display setting; PATCH accepts boolean/null.

Next: focused bridge/management/replay tests, typecheck, changed tests, structure/privacy gates, docs build.
Then feature issue and fork draft PR using repository templates. No merge or deployment.
No subagents. Live desktop rendering remains separate from wire regression evidence.
