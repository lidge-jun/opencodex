# Effective Console destination fixture correction

Hosted macOS control run34693025423/job103551974484 failed the canonical-row other-host fixture. The log records that routing discarded the configured other-host URL and selected the canonical Go endpoint. The test therefore never reached its intended negative condition. This is not evidence of a noncanonical replay.

The negative case now configures an unsupported generation path on the same canonical row. Both supported adapter path fields name `/unrelated`; the assertion requires exactly one outgoing URL at that path and preserves the original refusal. Existing custom-row other-host coverage remains. A separate control records the two exact `/responses` sends produced after canonical base normalization; the exact Muse model wire default selects Responses. No production code, policy, retry count or assertion skip changes.

Local tests/build/typecheck/install are NOT RUN. Independent source review and updated exact-head hosted CI are required. Windows pnpm/Devin failures in the same run remain separate shared repair items; no baseline runtime pass is claimed.
