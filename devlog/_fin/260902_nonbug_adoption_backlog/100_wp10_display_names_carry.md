# wp10 — #2201 durable display names for discovered models (carry PR #2715)

Issue #2201 (score 60). Two contributor drafts: #2715 core (+1800/-11, 26 files, no GUI) and #2716
GUI editor (+3118, stacked on core). Reviewer (Ingwannu) explicitly asked for the core contract first
and the dashboard editor as a separately reviewed follow-up; #2715 is that core slice. Its earlier
head passed all 23 checks; later refreshes were blocked only on fork-workflow approval.

## Decision
Carry #2715 by merge onto current `dev` (branch `codex/carry-2715-display-names`, merge
`47c24bce6`, author commits preserved). Two conflicts against wp4's retainModels landing were
resolved (POST carry-over block; providers.md row). #2716 stays open as the GUI follow-up and is
retargeted/rebased by its author after core lands.

## Acceptance
- Review (grok subagent) confirms labels never become identity: routed slug, native id, wire model,
  pricing key, disabled/selected/retain matches, alias/combo targets, dedupe untouched.
- Validation applied at load, PUT, and POST; prototype-key guards; 2,000 cap.
- No new imports into router/lifecycle/responses core.
- Focused: model-display-names-management-api, provider-config-validation, config-load-degrade,
  config-user-edits, opencode-cli, codex-convergence-contract, management-client-config-route,
  plus codex-catalog and management-provider-validation; tsc; privacy.
- Land via a new PR from the carry branch (the fork PR cannot be admin-merged with a fresh head
  without fork CI), close #2715 as landed-via-carry with credit, close #2201, comment on #2716.

