# WP3 audit

Verdict: **PASS with one blocker resolved before building.**

## Blocker: a source-text assertion breaks on the destructuring change

`gui/tests/sidebar-codex-auth.test.ts` asserts against the literal source of
`App.tsx`:

```ts
expect(src).toContain("{NAV.map(({ id, tkey, Icon }) => (");
```

Widening the entry type changes that destructuring, so the test fails on a
change it was never written to catch. Its real subject is stated in its own
header: Codex Auth must never be filtered out of the sidebar again. The
`NAV.map` line is incidental — it was pinning "the sidebar renders the whole
table" via the shape of one line.

Update the assertion to test the invariant rather than the formatting: keep the
`viewMode` filter check and the Codex Auth entry check, and replace the exact
destructuring string with `expect(src).toContain("NAV.map(")`. Anything
stricter re-creates the same brittleness one refactor later.

This is an amendment to the test's mechanism, not a relaxation of its subject:
the two assertions that carry its meaning are untouched.

## Confirmed: the sibling-claim rule is necessary, not defensive

Checked against `readPageFromHash`: `#integrations/claude` resolves to page
`integrations`, exactly like `#integrations`. So both rows genuinely satisfy
`page === id`, and without the sibling clause the sidebar lights two rows at
once. The plan's second clause is load-bearing.

`INTEGRATION_TAB_HASHES` already contains both `integrations/claude` and
`integrations/claude/desktop`, so `hashBelongsToPage` accepts the destination
and the normalization effect will not strip it. No routing change needed —
confirmed rather than assumed.

## Icon

`icons.tsx` has no Claude or Anthropic mark, and this work-phase is not the
place to introduce brand iconography. `IconTerminal` is unused by the sidebar
and reads correctly for a coding-agent client. Use it; do not draw a new glyph.

## Amended acceptance

Carried from `030`, plus:

- [ ] `sidebar-codex-auth.test.ts` still passes, with its two subject
      assertions intact.
