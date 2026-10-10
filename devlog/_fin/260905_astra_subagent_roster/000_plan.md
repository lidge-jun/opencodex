# Astra-first subagent roster

- Class: C4 for the one-time saved-list migration; one spec-satisfaction cycle.
- Trigger/goal: user requests fresh Astra/Sol/Terra/Luna/5.5 defaults and existing
  `1,2,3,4,5 -> Astra,1,2,3,4`, then no-verify push and admin merge.
- Non-goals: provider entitlement changes, UI implementation, service deployment,
  releases, unrelated config refactors, local test suites.
- Reuse: `DEFAULT_SUBAGENT_MODELS`, startup's unset-only seed, `saveConfig` atomic
  persistence, and the marker convention in `src/claude/auth-mode-migration.ts`.
  No-op/config-only/default-only changes cannot migrate existing saved choices.
- Verifier: local `bun run typecheck` and `git diff --check`; behavior and full
  suite run in the existing exact-head GitHub CI, not locally (user restriction).
  No pre-patch test baseline or TDD claim. Inspect scripts/workflow before delivery.
- Stop: regression coverage, independent review, passing exact-head CI, merged PR
  and fetched-dev ancestry. DONE then; external failure is BLOCKED/NEEDS_HUMAN,
  unapproved risk UNSAFE. No scope reduction to declare success.
- Memory: this unit and the bound goalplan/ledger. One wp1 consumes 010.
- Scope/resources: current managed worktree, local git/cxc, repository GitHub API,
  read-only reviewer; two-hour wall bound; no new paid services or token cap.
- Escalation: reclaim after two distinct failed reviewers; no delegated writes.
  A broader migration or missing merge authority requires human direction.

## Existing source anchors

- `src/config.ts:1590`: old five-model defaults; `:3702` seeds fresh configs.
- `src/server/index.ts:671`: startup seeds only missing lists before catalog sync.
- `src/types/config.ts:415`: persisted roster shape; schema is passthrough.
- `structure/03_catalog-and-subagents.md:352`: priority and five-row contract.

## Upgrade semantics

Fresh or unset lists use the exact new defaults. An unmarked explicit list,
including empty, becomes Astra plus the first four non-Astra unique old choices.
An Astra already present moves to the front without a duplicate. Exact account
qualified choices remain distinct. Marked configs preserve all later edits,
including an empty list or removal of Astra. This is the user's deliberate one-time
override of the old empty-list behavior, not a permanent forced default.

User amendment: retained bare `gpt-5.5` moves to the very end after truncation.
Therefore the former defaults upgrade to Astra/Sol/Terra/Luna/5.5, exactly the
fresh defaults. Other retained choices keep their relative order.

Do not remove disabled-model choices or alter availability/entitlement gates.
Rollback keeps the new list as an ordinary user list; the dropped fifth item is
intentionally not retained as hidden state. Restore it manually if desired.
