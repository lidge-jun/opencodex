# Implement model catalog and subagent migration

- Pin the upstream 6.2 rows in `src/codex/data/roster-pinned-models.json`. Register them as self-described in `src/codex/catalog/native-models.ts` and set per-model native windows in `metadata.ts`. Use the current Sol for configured-native capabilities while retaining that feature's configured context policy. Include 6.2 in native main-drain handling and documented non-live backfill. Preserve native source-priority precedence and keep the existing 0.166.0 per-row client minimum. Verify the served and generated picker rank with the existing featured roster path.
- In `src/config/subagent-models.ts`, add a version-4 migration from the prior bare Astra and Sol defaults, preserving order, explicitly qualified IDs and empty lists. Keep the individual version 2 and 3 behavior semantics. Update the smoke fixture, focused migration and catalog checks, and owning structure and user-facing docs.
- Update the canonical API-key seeds and expected pricing using primary-source limits. Add OpenRouter via its verified catalog IDs and context. Keep other providers discovery-led until their exact served IDs and behavior are verified. Native and public API capabilities are separate contracts. Keep older native rows selectable.
- Extend the roster, configured-native, native-row and provider/pricing test files. Use focused Bun tests, typecheck, structure and privacy gates. Run the roster regression first against the base behavior. Obtain a fresh Morph DeepSeek final review of the committed SHA.

## Audit dispositions

- The independent audit observed scaffold placeholders before the draft landed. The completed 010, 020 and 030 documents now specify changes, acceptance tests and ordering.
- Context limits have their own overrides because the pin alone does not establish the native long-window clamp. Extend the exhaustive pin test and hardcoded docker and startup fixture expectations. Keep older pinned ranks and row provenance intact unless a test demonstrates a collision in served priority.
- Aside independently fetched both OpenAI API model pages and OpenRouter's public catalog after the reviewer started. Seed those verified rows, including confirmed limits and pricing. Leave unverified vendor rows and the ChatGPT-native Ultrafast allowlist unchanged.
