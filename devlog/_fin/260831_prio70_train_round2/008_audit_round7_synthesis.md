# 008 — audit round 7: five phases clean, and wp3's predicate was in the tree all along

Round 7 found **no blockers in wp1, wp2, wp4, wp5 or wp6**. It also confirmed `000` and
`070` now agree, the below-bar matrix sums, and the legacy refusal is scoped to shape C.

Both remaining blockers were wp3, and they ended the sequence by making the real problem
visible.

## Blocker 1 — the computed post-image would erase genuine user activity

Routing derives `has_user_event` from the message **at snapshot time**
(`src/codex/history-provider.ts:1162` CASes the original value, `:1184` reads it). My
round-6 computation read the message **as it is now**.

The divergence is reachable: an `openai/vscode/0` entry with a null message routes to
`opencodex/vscode/0`; the user sends their first message; the row becomes
`opencodex/vscode/1`. Recomputing from the current non-empty message yields `1`,
declares a match, and restore writes the user's activity back to `0`.

The manifest records neither the message nor its emptiness
(`src/codex/history-manifest.ts:7-13`), so the entry needs `hadFirstUserMessage` — a
boolean, never the text. The manifest is on disk and the message is user content.

## Blocker 2 — my table dropped a bridge `dev` deliberately supports

`opencodex/exec/1` routes to `opencodex/cli/1`, then legacy recovery produces
`openai/cli/1` (`:991`). That row was neither A, B nor C in the round-6 table, so the
fallback refused a manifest `dev` restores today.

## The root cause, after five rounds on one predicate

`rowMatchesExpectedPostImage` **already exists** at
`src/codex/history-provider.ts:487-500`. It computes the post-image from the entry. It
handles the nullable-message branch. It accepts the `openai/cli/1` bridge at `:496-499`,
with coverage at `tests/codex-history-provider.test.ts:345`.

Every version of my predicate — the tuple test (round 3), the provenance flag (round 4),
the shape table (round 5), the computed post-image (round 6) — was a reimplementation of
that function, each missing a different branch of it. Round 6 correctly said "derive
rather than pattern-match" and then wrote the derivation beside the tree instead of
taking it from the tree.

wp3 now extends the existing helper and fixes its one real defect: the snapshot-vs-current
message read at `:488`. Exhaustiveness stops being an argument and becomes a property —
every row `dev` accepts is accepted afterwards, because it is the same function.

**Before writing a predicate that recognizes your own system's output, search for the one
that already does.** Five rounds, roughly two hours of high-effort review, and the answer
was thirteen lines in the file the phase was already editing.

## Process note

From this point the A-phase reviewer is resumed rather than respawned, per the user's
instruction. A resumed reviewer keeps its own findings in context, which is the right
shape for blocker-closure rounds — it can tell a genuine fix from a restatement without
re-deriving the history.
