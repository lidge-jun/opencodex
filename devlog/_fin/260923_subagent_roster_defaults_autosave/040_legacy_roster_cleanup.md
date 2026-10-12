# 040 — Legacy 5.x cleanup in the version-2 roster upgrade

User request (2026-09-23, after 010 shipped to PR #5640): when the roster upgrades
automatically, drop every gpt-5.5 / gpt-5.6 entry, and replace Sol and Luna with
their GPT-6 successors.

## Rule (replaces 010's exact-match rule)

In `migrateSubagentModels`, for version < 2, after the existing Astra step:

- map each stored id in order: `gpt-5.6-sol` → `gpt-6-sol`, `gpt-5.6-luna` →
  `gpt-6-luna`; drop any other bare id matching `/^gpt-5\.[56](?:-|$)/`
  (5.5, 5.5-pro, 5.6-terra, and the rest of both families);
- keep the first occurrence of each id;
- only bare ids (no `/`) are rewritten. Routed `provider/model` ids and
  account-qualified `<selector>/<model>` ids keep their exact spelling, because a
  routed id with a 5.x suffix names a different provider's model;
- a list that was non-empty and becomes empty receives the GPT-6 defaults; an
  explicitly empty list stays empty.

The old exact default `[astra, 5.6-sol, 5.6-terra, 5.6-luna, 5.5]` becomes
`[astra, 6-sol, 6-luna]` under this rule, so the exact-match special case goes away.

## Tests (tests/routing/subagent-roster-migration.test.ts)

- replace "an edited version-1 roster is kept" with a table of version-1 inputs and
  their cleaned results (reorder kept, 5.x mapped/dropped, routed ids untouched,
  all-5.x list → defaults, empty stays empty);
- legacy table: `[one, astra, astra, 5.5, two]` → `[astra, one, two]`,
  `[pool/gpt-6-astra, 5.5]` → `[astra, pool/gpt-6-astra]`;
- startup rebasing test: disk `[new, gpt-5.5]` → `[astra, new]`.

Docs: English `agents.md` upgrade paragraph and `structure/subagents.md`.

## Delivery

Commit on `codex/subagent-roster-gpt6-defaults` (PR #5640), then merge that branch
into `codex/subagent-roster-autosave` (PR #5644) with a merge commit, no rebase,
so the stack's squash merges do not conflict.
