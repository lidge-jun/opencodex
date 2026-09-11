# Rules for `structure/`

This file applies to `structure/` and inherits the repository-wide rules in [`AGENTS.md`](../AGENTS.md).
[`INDEX.md`](INDEX.md) is the reading order and the source-ownership table; it is generated, so it is
never the thing you edit to record a decision.

## What belongs here

A doc in this folder states **the contract that holds right now**, in the present tense, for one
subsystem. That is the whole job.

- Public user workflows belong in `docs-site/`.
- Open work, triage, and investigation belong in `devlog/`.
- Superseded or alternative reasoning belongs in `decisions/`, not in the doc body.
- Unreleased security findings belong in scratch space and nowhere in this repository. The rule in
  the root [`AGENTS.md`](../AGENTS.md) binds this folder without exception.

If you cannot write a sentence in the present tense about how the system behaves today, it is not a
structure doc.

## Layout rules

- File names are kebab-case and at most one directory deep: `providers/google.md`, not
  `providers/google/wire.md` and not `04_transports.md`.
- **Ordering lives in `manifest.json`, never in a filename.** Numeric prefixes are banned. The old
  `NN_topic.md` scheme produced two `09_` files and made splitting a doc cost a renumber, which is
  how one file reached 1,860 lines.
- A doc stays under the line budget in `manifest.json` (600). Over budget, split it along a topic
  boundary and give each half its own manifest entry. A grace entry in `grace.oversizeDocs` is for a
  split already planned, not for a doc you would rather not split.
- Every path you name in backticks must exist. A path that is deliberately absent goes in
  `absentPaths` and the gate then fails if somebody re-creates it.

## Ownership and the sync obligation

Every source area has exactly one owning doc, declared in `manifest.json` and published in
[`INDEX.md`](INDEX.md).

- **Changing an owned area obliges the same change to update its doc.** Not a follow-up, not a
  cleanup pass later — the same change.
- Two docs may not claim the same area. If a change does not fit under one owner, the boundary is
  wrong; move the section, do not describe the behavior twice.
- A new `src/<area>/` either joins a doc's `owns` list or is recorded in
  `grace.unownedSourceAreas` with a reason. The gate rejects a new area that is neither.

Duplication is the failure mode this folder is built against: two true-looking paragraphs that
disagree cost more than one missing paragraph.

## Decision records

`decisions/ADR-NNNN-<slug>.md` holds the reasoning: intent, prior constraints, alternatives, the
choice, why, and consequences.

- One record has exactly one owning doc, which links it with a `> Decision record:` line.
- Numbers are permanent and contiguous. A superseded record stays; it does not get deleted or
  renumbered.
- Records are historical. When the contract changes, edit the doc body and add a new record; do not
  rewrite an old one to match.

## Invariants

[`overview.md`](overview.md) is the only place an invariant is declared. Each entry needs a stable
`INV-<AREA>-NN` id and an `Enforced by` line naming one test path, and that test file must name the
id back in a comment. Both directions are checked, so renaming or splitting the test without moving
the marker fails the gate rather than quietly unbinding the invariant.

## Adding or changing a doc

1. Write or move the file.
2. Add or update its `manifest.json` entry: `path`, `tier`, `title`, `scope`, `owns`.
3. `bun run structure:index` to regenerate [`INDEX.md`](INDEX.md).
4. `bun run structure:check` until it is green.

## What the gate checks

`bun run structure:check` — also run by `tests/ci-workflows/structure-ssot.test.ts`, so it blocks CI —
verifies that:

- every doc on disk is in the manifest and every manifest doc exists, exactly once;
- file names are kebab-case, at most one directory deep, and free of numeric prefixes;
- no doc exceeds the line budget without a grace entry;
- every relative link resolves and every backticked repository path exists;
- no `[Decision Log]` block is left inline in a doc body;
- every decision record is linked from exactly one doc, and numbering has no holes;
- every invariant names an existing test, and that test names the invariant;
- no two docs claim the same source area, and no `src/` area is silently unowned;
- `INDEX.md` matches the manifest byte for byte.
