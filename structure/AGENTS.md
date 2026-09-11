# Rules for `structure/`

This file applies to `structure/` and inherits the repository-wide rules in [`AGENTS.md`](../AGENTS.md).
[`INDEX.md`](INDEX.md) is the reading order and the source-to-doc map; it is generated from
[`manifest.json`](manifest.json), so it is never the file you edit to record something.

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

- File names are kebab-case, start with a letter, and sit at most one directory deep:
  `providers/google.md`, not `providers/google/wire.md`, and not `04_transports.md` or `04-transports.md`.
- **Ordering lives in `manifest.json`, never in a filename.** Leading digits are rejected outright.
  The old `NN_topic.md` scheme produced two `09_` files and made splitting a doc cost a renumber, which
  is how `04_transports-and-sidecars.md` reached 1,860 lines before this folder was reorganised.
- A doc stays under the line budget in `manifest.json`. Over budget, split it along a topic boundary
  and give each half its own manifest entry. A `grace.oversizeDocs` entry is for a split already
  planned; the gate drops it again once the doc is back under budget.
- Know what the budget does and does not do: it is a line count, so a doc written as a wide table can
  carry far more prose per line than one written as paragraphs. It bounds the runaway-file failure,
  not density.

## The source-to-doc map

Each doc lists the source areas it describes, in its `documents` array. [`INDEX.md`](INDEX.md) publishes
the inverse.

- **An area can be described by more than one doc, and usually is.** These docs are organised by
  topic; `src/` is organised by module. `src/server/` is genuinely described by the management-API doc,
  the Responses transport doc and the Images doc. An earlier revision of this folder demanded exactly
  one owner per area, and that rule was simply false here — a false rule is worse than none, because
  the gate reports green while the map sends a maintainer to the wrong doc.
- **Changing an area obliges the same change to update every doc listed for it.** Not a follow-up,
  not a later cleanup pass.
- Describing an area means naming a path inside it. If a doc explains a subsystem without ever citing
  a path, the map cannot see it, and the area lands in `grace.undocumentedSourceAreas` instead — which
  is a signal to add the path reference, not a place to park work.
- A new `src/<area>/` or top-level `src/*.ts` either joins a doc's `documents` list or is recorded in
  `grace.undocumentedSourceAreas` with a reason. The gate rejects one that is neither.

What the map still does not do: it cannot tell you that two docs describe the same behavior in
contradictory words. Avoiding that is a review judgement. Prefer one statement and a link over two
statements that will drift apart.

## Decision records

`decisions/ADR-NNNN-<slug>.md` holds the reasoning: intent, prior constraints, alternatives, the
choice, why, and consequences.

- One record has exactly one owning doc, which links it with a `> Decision record:` line.
- Numbers are permanent and unique. They are deliberately **not** required to be contiguous: two
  branches that each add a record would otherwise both take the next number and collide on merge.
- Records are historical. When the contract changes, edit the doc body and add a new record; do not
  rewrite an old one to match. For the same reason the gate does not validate the repository paths a
  record names — a record describes a past tree, and holding it against the present one would force
  you to falsify it.
- Records extracted during the 2026-09-11 reorganisation are titled after the doc section they were
  taken from, which is where they belonged, not necessarily what they decided. Read the body.

## Invariants

[`overview.md`](overview.md) is the invariant index. Each entry needs a stable `INV-<AREA>-NN` id, and a
bound entry adds an `Enforced by` line naming exactly one `tests/**.test.ts` path, with that id repeated
in a comment inside the test.

Be precise about the strength of that binding, because it is easy to overstate:

- It proves the test file exists and claims the id. Deleting or renaming the file fails the gate.
- It does **not** prove the assertions inside still cover the rule. Moving the assertions to another
  file while leaving the comment behind passes. Only review catches that.

An invariant with no honest test goes in the index **without** an `Enforced by` line and with an entry
in `grace.unboundInvariants` explaining why. Naming a test that would pass while the rule was
violated is worse than admitting the gap: it converts an open question into false assurance.

## Adding or changing a doc

1. Write or move the file.
2. Add or update its `manifest.json` entry: `path`, `tier`, `title`, `scope`, `documents`.
3. `bun run structure:index` to regenerate [`INDEX.md`](INDEX.md).
4. `bun run structure:check` until it is green.

## What the gate checks

`bun run structure:check` — also run by `tests/ci-workflows/structure-ssot.test.ts`, so it blocks CI —
verifies that:

- every doc on disk is in the manifest and every manifest doc exists, exactly once;
- file names are kebab-case, letter-initial, and at most one directory deep;
- no doc exceeds the line budget, and no grace entry outlives the split it promised;
- every relative link resolves, including its `#anchor`;
- every backticked repository path a doc names is real, checked against the **git index** rather than
  the filesystem — `existsSync` cannot tell a tracked file from untracked local leftovers, and it is
  case-insensitive on Windows and case-sensitive on Linux CI, which would make the gate mean
  something different on each machine;
- no doc body carries inline decision-log reasoning;
- every decision record is linked from exactly one doc, and no number is reused;
- every bound invariant names an existing test that names the id back, and every unbound one is
  recorded with a reason;
- every `src/` directory and top-level module is described by a doc or recorded as undescribed;
- `INDEX.md` matches the manifest byte for byte.

Checks are scanned with fenced code blocks removed, so an example inside a fence does not trip a rule
it is only illustrating.
