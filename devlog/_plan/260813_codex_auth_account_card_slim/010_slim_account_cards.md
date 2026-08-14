# 010 — Slim account cards to three default rows

## Goal
A healthy main/pool card shows exactly three default rows: header/actions, identity+selection order, one quota meter. No inner-card fold.

## Files
MODIFY gui/src/components/codex-account-pool-main-card.tsx
MODIFY gui/src/components/codex-account-pool-cards.tsx
MODIFY gui/src/components/QuotaBars.tsx (compact row only)
MODIFY gui/src/styles.css (quota-compact + priority inline)
MODIFY gui/tests/codex-account-pool-pinned-badge.test.tsx (drop default log/usage assertions from the card body)

## Before
Main/pool cards render: head, email/plan, logLabel, usage30d, healthSummary, cooldown, pinnedHint, AccountPriorityControl row, QuotaBars six-column row (label, resets, day, time, bar, percent).
Skeleton main card currently paints QuotaBars pending under a single email strut.

## After
Default healthy card:
1. card-head (existing actions, badges, pause/remove).
2. one identity row: email · plan · compact AccountPriorityControl on the right. Pool cards may keep a truncated account id on that same row.
3. one quota meter row: window label + bar + percent. Reset date/time moves into title/aria, not extra columns.

Keep on-card only when not default:
- reauth copy, cooldown hint, health summary.
- no logLabel, no usage30d line, no pinnedHint paragraph.
Pinned badge in the head stays.

QuotaBars compact layout becomes a 3-column meter (label | bar | percent). stacked layout is OUT OF SCOPE.
Pending skeleton reserves one meter row, not two six-column rows. Update .codex-account-quota-slot min-height accordingly (about one 18px row + padding).
Do not introduce details/summary, accordion, or show-more inside the card.

## Activation / accept
- Healthy fixture with logLabel+usage30d no longer prints those strings in the card textContent.
- Priority select remains in the document (toast tests still click #codex-account-priority-*).
- Quota percent remains visible.
- Source of both card files contains no <details>.

## Test constraints already in tree
- gui/tests/codex-account-pool-controller.test.ts currently requires both card files to contain t("codexAuth.pinnedHint"). Removing the paragraph means that source assertion must move with 010 (assert pinned badge only).
- gui/tests/codex-account-pool-pinned-badge.test.tsx asserts log label and 30-day usage on card textContent; rewrite that test to assert those strings are absent from a healthy card, and keep pin badge behavioral coverage.
- gui/tests/codex-account-pool-toast-tone.test.tsx clicks #codex-account-priority-*; the control must remain in the document, just inlined on the identity row.
- Compact QuotaBars pending skeleton currently reserves two rows / 48px. Change to one meter row or cards will keep a tall empty slot.
