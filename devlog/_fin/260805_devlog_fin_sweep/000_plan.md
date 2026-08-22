# 000 — Archiving the finished `_plan` units

Unit: `devlog/_fin/260805_devlog_fin_sweep/`
Opened: 2026-08-05 · Work class: C3 · Branch target: `dev`
Base commit for every citation: `8949c4940` ("fix(deps): clear the two high
advisories blocking the release audit").

## Objective

`devlog/_plan/` holds 53 units. Some of them closed days or weeks ago and their
work is on `dev`; they sit in the open drawer only because nobody moved them.
`_plan/` is supposed to answer "what is still live", and at 53 entries it does
not answer anything.

Adjudicate them all, move the genuinely finished ones to `devlog/_fin/`, and
leave the rest where they are with a recorded reason.

(The opening inventory found 51. Two more appeared while this unit was being
written — this unit, and `260805_issue_pr_triage` from a concurrent session.
Neither is archivable; the count is reconciled in `020`.)

## What "finished" means here

A unit is COMPLETE only when all three hold:

1. Its docs record a terminal outcome, or the work is demonstrably landed.
2. The change is verifiable on `dev` — merged commits, merged PRs, closed
   issues — or the unit is provably superseded by a later unit that landed it.
3. No doc names live remaining work: no unexecuted work-phase, no open PR the
   unit is waiting on, no pending follow-up, no decade doc that is still an
   outline.

Ambiguity resolves toward staying in `_plan/`. A unit archived while its
phase 3 is unwritten is a lie the next reader inherits; a unit archived a week
late costs nothing. That asymmetry decides every borderline call below.

A landed implementation does NOT by itself close a unit. Several units here
have their code on `dev` and still stay open, because the unit's own record
stops mid-phase — `500_storage-page-session-cleanup` shipped all three phases
and its docs still describe them in the future tense. Fixing that record is
work, and this unit does not do it.

## Method

13 read-only adjudicators, one batch of 3-4 units each, covering all 51. Each
read every doc in its units, extracted the referenced commits/PRs/issues, and
verified them: `git merge-base --is-ancestor <sha> dev`, `gh pr view`,
`gh issue view`, plus `rg` against `src/`, `gui/`, `docs-site/`, `scripts/` to
confirm the claimed symbols actually exist in the tree.

No adjudicator could mutate anything. Their verdicts are in `010`.

What the batch split could not see, and the main agent checked afterwards, is
cross-unit coupling: source-code comments that cite `devlog/_plan/<unit>/`
paths, `../<unit>/` relative links between units, and the two gates that
path-pin a unit by name. Those are in `020`.

## Result

11 COMPLETE, 42 OPEN. The moves and their required reference edits are
specified in `020_move_execution.md`.

It took four audit rounds to get there. The first pass said 21/30; independent
adversarial reviewers returned FAIL four times, and every blocker was verified
against the tree before being accepted or rebutted.

**Round 1** (five blockers):

1. The counts were stale and `260805_issue_pr_triage` was missing from the
   matrix entirely.
2. `260803_integrations_toggle_all` was archived in violation of this unit's own
   completion rule — its `000_plan.md` still calls itself docs-only. Reversed to
   OPEN.
3. The reference ledger inventoried only source files and gates, missing seven
   inbound links from staying devlog units.
4. Two SHAs cited as `ON_DEV` for `260730_devlog_publication_feasibility`
   (`f6ce1d5bd`, `bc2f9502e`) are not ancestors of `dev` — they were pre-push
   local commits. Replaced with the commits that actually landed, `8ae52e429`
   and `50cbf5162`.
5. The stated OPEN reason for `260803_pr_issue_sweep` was disproven: PR #916 is
   CLOSED, not awaiting review. The unit still stays open, but for the correct
   reason.

**Round 2** (three blockers): residual "21 moves" instructions survived the
round-1 edit in three places, and — applying the precedent round 1 established —
`260731_api_tab_improvement` and `260802_api_tab_client_connect_simplify` are
the same shape: commits on `dev`, no closeout, final phase docs still written in
the future tense. Both reversed to OPEN.

**Round 3** (four blockers): residual reversed-unit rows still sat in the
reference table; the carve-out defending `260802_client_toggle_api` was special
pleading, because its own `080` defers three defects and calls each "its own
work-phase"; four more units (`260730_prerelease_blockers`,
`260730_server_auth_suite_flake`, `260804_stack7_service_vision`,
`260804_stacked_pr_ci`) end on procedures rather than outcomes; and one file in
the stale-path exemption list was a live pointer, not a historical record.

**Round 4** (three blockers): `260731_260730-gui-sidebar-star-update-orbs` fell
to the round-3 standard — its `040_verification.md` lists commands to run and
browser checks to perform, with no record that anyone ran them. The inbound-link
ledger also needed a third pass, because each demotion turns a moving unit's
outbound links into a staying unit's inbound links.

Round 1's blocker 2 is the one that mattered; rounds 2-4 are its consequences.
The rule that keeps `500_storage-page-session-cleanup` open — implementation
landed, unit record never caught up — applied identically to nine units the
first pass waved through because their code was visibly on `dev`. A rule applied
to nine units and not the tenth is not a rule. Stated properly, it took nine
more with it and cut the move list from 21 to 12.

The bar that settled: archive when the unit's own record states an outcome in the
past tense, not when the code merely landed. Round 4 closed the loop by naming
the qualifying record for each of the twelve survivors individually; they are
cited per row in `010`.

Worth saying plainly, since the number moved four times: the first pass was
wrong in a specific and predictable way. It treated "the code is on `dev`" as
proof that the unit was done — which is exactly the inference `_fin/` exists to
spare the next reader from having to repeat.

## Scope

IN: `git mv` of the 11 adjudicated units; the reference edits `020` names; this
unit's own docs; a local commit on `dev`.

OUT: no push, no PR or issue mutation, no `_chase/` changes, no rewriting of
any archived unit's substance, no closing out the 30 units that stay open. In
particular this unit does NOT fix stale phase docs, resolve open questions, or
record missing terminal outcomes for anything — that is each unit's own work.

## Accept criteria

- [ ] 11 units moved: `devlog/_fin/` 295 -> 306, `devlog/_plan/` 53 -> 42, no
      file lost.
- [ ] `bun test tests/repo-hygiene.test.ts` green — including the tripwire that
      path-pins `260730_devlog_publication_feasibility`.
- [ ] `bun run privacy:scan` green — same path pin, in `scripts/privacy-scan.ts`.
- [ ] `rg -n "devlog/_plan/<moved-unit>"` finds nothing outside `devlog/_fin/`,
      except the three files `020` step 5 names and leaves intact.
- [ ] The 11 COMPLETE rows in `010` and the 11 `git mv` lines in `020` are an
      exact set match, and COMPLETE + OPEN = 53 distinct units with no overlap.
- [ ] `git ls-files -s devlog` shows no mode other than `100644`.
- [ ] `git status` shows renames plus the intended edits, and nothing the user
      had in flight before this ran.
