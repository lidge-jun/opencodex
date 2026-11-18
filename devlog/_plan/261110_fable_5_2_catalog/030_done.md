# 261110 Fable 5.2 catalog — outcome

Shipped in two commits on `goat/fable-5-2-release`:

- `bbb07cda78` adds the Anthropic seed (1M / 128K / low..max), the fast allowlist and 2x
  confirmed-fast price rule, overlays for anthropic, anthropic-apikey, cursor, devin and devin-cli,
  the metadata snapshot rows plus regenerated table, Opper and Devin seeds, and the two English docs
  that list Anthropic Fast models.
- `0b42b837f8` prices the two ids the vendor fallback cannot reach (Kilo's fable-latest alias and
  Vercel's Fable 5.2 fast row), moves the Fable 5.2 pricing cases into
  `tests/usage/usage-fable-5-2-pricing.test.ts` to keep `usage-cost.test.ts` under the 2000-line
  ratchet, and adds Fable 5.2 to the client-export fast roster test.

Review: terra plan audit FAIL, FAIL, NEAR-PASS; terra code review FAIL (ratchet, two unpriced ids),
then PASS.

Evidence: `bun run typecheck`, `privacy:scan` and `structure:check` pass; 12 focused files 356 pass;
`bun run test:changed` 52325 pass with one unrelated failure
(`tests/clients/link-pinned-sync-argv.test.ts` signal timing under load, passes in isolation).

What did not improve: Cursor flat effort ids (`claude-fable-5-2-high`) stay unpriced until the live
roster shows Cursor's real ids; the Claude Code native `fable` tier still defaults to 5.1. The
assumption that would refute the Cursor choice: a roster that lists only flat effort ids, in which
case a capability row and effort-map entry are the next step.

Residuals: native `fable` tier default, Claude Mythos 5.2, Kiro (unpublished), model switches away
from 5.2 dropping its thinking blocks (the API succeeds and drops them).
