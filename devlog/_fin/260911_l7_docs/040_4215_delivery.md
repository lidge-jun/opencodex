# #4215 — delivery record

Commit `6db526a8a1` on `codex/260911-l7-docs`. Closes #4215.

## What shipped

`docs-site/src/content/docs/guides/providers.md` gains a `### Which account a request spends`
subsection under the existing **Auth modes** heading: the rule per `authMode`, the two shipped
exceptions, a table of the eight providers that accept both a login and a key, a login-only line,
and a pointer at the Connection block's **Authentication** row.

`tests/ci-workflows/docs-provider-billing-claims.test.ts` guards it, registered in
`scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`.

## What the audits changed

Three rounds, and each one changed the shipped text rather than merely approving it.

**Round 1 rejected the issue's own wording.** "OpenCodex does not convert one into the other" is
false while `orcarouter-oauth` ships, and "an API key bills per token" is false for the several
presets that sell a subscription as a key. Both are now stated as what is actually true: a request
uses one credential family and never falls back across them.

**Round 2 rejected the framing itself.** Revision 2 wrote "spends the Claude subscription
allowance" and cited a registry line. The registry states an id, a transport and an auth kind; it
does not state vendor billing terms, and `quota.ts:1404`-`1409` says the Anthropic endpoint reports
no tier at all. The guide now answers in terms the source can support — which credential the request
carries, which account it authenticates as, which windows opencodex reads back — and says once that
the billing terms belong to the vendor.

**Round 3 caught two contradictions inside the shipped diff.**

- The table was headed "Providers that accept both" and carried a Google Antigravity row whose own
  text said it has no key mode. The heading now reads "Providers that accept both a login and a
  key", and Antigravity moved to the login-only paragraph, where its neighbour `google` is named as
  a different product rather than a key mode for the same login. The test's `DUAL_MODE` list lost
  that entry, so CI no longer pins a row that refutes its own heading.
- The GitHub Copilot row implied that choosing a key changes which account pays, which fights
  `providers.md:909` — Copilot exchanges a device-flow login for a short-lived Copilot token, not a
  pasted API key. The row and the exceptions bullet now separate the two cases: an `xai` key
  retargets the provider to `https://api.x.ai/v1` so a different account pays, while a
  `github-copilot` key is still a Copilot credential against `api.githubcopilot.com`, so the
  subscription pays either way.

## Decisions this lane made

- **Form.** Rule first, then one row per dual-mode provider, as the packet directed. A table
  carries the rows because the reader's question is a lookup.
- **Scope.** Dual-mode providers only. A provider with one mode is already unambiguous.
- **Verification surface.** The issue asked the guide to point at "the account card". No
  per-account auth-mode badge exists (`ProviderAuthPanel.tsx:504`-`527`); the mode is a
  provider-level field, so the guide points at the Connection block's **Authentication** row and
  names the five labels it renders, including the `No key needed` fallback.
- **Copilot stays in the table** even though both of its modes spend the same subscription, because
  it genuinely accepts both credential forms and a reader who sees `authMode: "key"` in a config
  needs to know it does not move the bill.

## Verification

The local product suite was NOT RUN by operator instruction: no `bun test`, no `bun run test`, no
`bun run test:changed`, no `bun run typecheck`, no `bun run build:gui`, no `bun install`. Hosted CI
on the exact pushed head is the proof.

Because the new test could not be executed locally, a read-only subagent verified it by reading:
every `toContain`, `not.toContain` and regex literal was located in `providers.md`, checked against
the section-slice boundary, and confirmed to sit in the cell the assertion intends — including the
backtick delimiters that stop a login marker from matching a key cell. That check was re-run from
scratch after the table lost a row.
