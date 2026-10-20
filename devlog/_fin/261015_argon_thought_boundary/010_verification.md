# One phase: verify the Argon output boundary

Depends on current Google adapter and existing client handlers; no runtime design changes.

1. NEW `tests/responses/protocol-argon-thought-boundary.test.ts`: isolated homes and synthetic
   credentials, mock Google transport only, invoke real Responses/Chat/Messages handlers.
   Generate `thought: true` marker parts, ordinary text (absent and false markers), signature-only
   parts, an unmarked signed text part, and an optional tool call with synthetic signature.
   Exercise buffered and SSE, coalesced and split SSE frames, and direct/bridge Chat/Messages.
   Assert exact ordinary answer text in both deltas and accumulated final payloads,
   thought marker only in reasoning/thinking fields, no
   signature-only text, preserved tool name/args and call-bound signature where the client wire
   exposes it, successful terminal. For independent client-only opt-outs (Responses/Chat summary none and Messages display omitted),
   force upstream thought parts anyway and require suppression while answer and tool survive.
   Inspect protocol trace so the direct/bridge cases prove the intended lane executed.
2. MODIFY `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`:
   register the new test in responses, using existing shard conventions.
3. MODIFY `structure/providers/google.md`: describe signature-independent text classification
   and reference the new test; preserve the historical decision record.
4. MODIFY `docs-site/src/content/docs/guides/providers.md`: clarify Gemini thought summaries,
   client field separation, and that unmarked ordinary text is not censored by wording.
5. Run new tests and adjacent Google/direct-lane/encoder tests. Validate the new oracle by a
   temporary local classifier mutation (marked thoughts become text), require failure, restore
   bytes, then require green. No mutation may be committed.
6. Run typecheck, test-layout/tooling, file-size, privacy, structure and docs build. Full suite
   default applies; if concurrent workload makes it disproportionate for tests/docs only, record
   exact focused scope and leave remaining platform/integration coverage to required CI.
7. Fresh independent review, fix valid findings, create ordinary PR to dev using template.
   Inspect exact-head required CI and maintainer-integration policy before the authorized merge.

Acceptance is protocol correctness for the synthetic fixtures and prevention of regression.
The original live symptom and other harnesses' rendering remain unverified; the PR and final
report must say so. A newly demonstrated runtime defect requires a plan amendment and audit.
