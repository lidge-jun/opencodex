# Source decisions

Public PR diffs and latest comments are the source proposal evidence. #4130's September 11 corrections pin Lite on for nonempty additional_tools bodies and off otherwise; adopting the earlier unconditional false version loses tools. #4334 is an explicit retirement HOLD and is not carried.

#4301 removes automatic content-to-summary conversion. #4287 tests raw DeepSeek content as a visible summary; that expectation conflicts with provenance and will be replaced, not adopted. Google thought-summary API documentation distinguishes summaries from opaque thought signatures: https://ai.google.dev/gemini-api/docs/generate-content/thinking (opened 2026-09-12). CCA generationConfig/includeThoughts behavior is contributor probe evidence, not a newly performed live-service probe.

Searches used: reasoning_raw_delta, thinking_delta, hideThinkingSummary, googlePartTextEvent, preserveReasoningContent, and the four PR numbers. Existing bridge event types can distinguish raw content and summary without a new enum. No-code/config-only options cannot repair the existing mislabeled content; raw rewrite deletion plus existing boundaries is the smallest change.
