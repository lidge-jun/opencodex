# Delivery record

Append-only. One row per deliverable, filled when it actually lands on `dev`.

## Round opened

- Base: `origin/dev` `cd813d3d9` (round-1 close, PR #4150).
- Roadmap: PR #4155 `docs(devlog): plan the post-2.49 round-2 two-lane delivery`,
  head `9abb66387`. Exact-head CI green — `gh run view 34410586758 --exit-status`
  returns 0 for Cross-platform CI at that SHA, with React Doctor, Enforce PR target
  branch and PR hygiene also 0. No run at that SHA was cancelled.
- Lanes dispatched as two Codex worktree threads running `anthropic/claude-opus-5`,
  each instructed to use read-only `xai/grok-4.6` subagents for verification only.

## Ledger

| Item | Issue | PR | Head | CI | Merged as | Issue closed |
|---|---|---|---|---|---|---|
| roadmap | — | #4155 | `3b9fab90e` | green | `a7509fe00` | — |
| A1 | #4129 | #4157 | `421aea87a` | green | `4498fb910` | yes |
| A2 | #4148 | #4161 | `799330bcf` | green | `5b8f1fcfa` | yes |
| A3 | #4141 | #4164 | `ae057c421` | green | `95a3f6a59` | yes |
| B1 | #3666 | #4156 | `db846c65d` | 23 green, gate red | | |
| B2 | #4075 | #4158 | `3dc7bd19b` | 23 green, gate red | | |
| B3 | #3859 | #4160 | `c8a734cd0` | green | `8a5cfd366` | yes |
| B4 | #1711 | #4165 | `5c3e7e7ff` | 23 green, gate red | | |
| B5 | #4038 | #4166 | `d5e042c9c` | 23 green, gate red | | |
| — | #4147 | #4153 | `abf35fa94` | green | `2ce5f381f` | yes |

### #4147 landed as the contributor's own commit

#4153 merged unmodified, so authorship stays with @richardfeiliu-a11y and reaches
his contribution graph. Nothing was reimplemented or carried, which is why no
`Co-authored-by` trailer was needed.

Two things are worth carrying forward from it. First, the review took one pass
because the contributor read a live `~/.zcode/v2/config.json` and the shipped
parser in `ZCode.app` instead of choosing between the two contradictory schemas in
the issue text — and this tree independently agrees with what he found, since
`src/integrations/ownership-policy.ts` already treats `models.*.reasoning` as
`enabled`/`variants`. Second, a fork pull request does not start repository CI on
its own: Cross-platform CI and React Doctor sat at `action_required` until
approved, which is why the check list looked thin for a while and would have been
easy to mistake for a passing PR.

### #3859 was unstacked rather than left to wait

#4160 was published on top of #4075 and #3666, both of which are held by the
screenshot gate. It depends on neither, so it was rebased straight onto `dev`,
retargeted, and merged on its own.

That force-push produced the round's third cancelled run. An earlier
Cross-platform CI run at the same SHA was cancelled by the concurrency group, and
its aggregate `ci` job reported failure as a consequence. The verdict is run
`34417147997`, which actually concluded. This is the third time this round that a
cancelled run looked like a failure or a pass; the rule that only a real
conclusion counts has earned its place.

### #4141 is unblocked

PR #4152 landed as `9ba04b64d`. Lane A was told to adopt the `runLaunchctl` seam
that PR established rather than invent a second one, to re-verify every anchor in
`040_4141_launchctl_bootout.md` first because `src/service.ts` moved underneath
it, and to prove the behaviour with stderr fixtures — running `launchctl` remains
forbidden while a live proxy is up.

### Open finding on #4156

The Lane B audit (`_research/_audit_wp3.md`) passed all three diffs but found one
real defect: `gui/src/pages/Models.tsx:1405` and `:1475` still count the group
header and `activeCount` from the unfiltered rows, so with the free-only filter on
the header claims more models than the list shows. The empty state at `:1681` does
it correctly. Fixed by Lane B; #4156 is now at `db846c65d`.

### Where the round stopped, and why

Lane A is complete: #4129, #4148 and #4141 are all on `dev` and closed. #4147 and
#3859 are closed too. Five issues delivered.

The remaining four — #3666, #4075, #1711, #4038 — are **code-complete and audited
PASS**, and every one of them sits at twenty-three green checks with
`enforce-target` as the only failure. Its message is literally
`missing UI screenshot`.

That is the whole blocker. The gate requires a screenshot of the interface change,
producing one requires `bun run build:gui`, and this round forbids local builds. It
is not a false positive: PR #4162, which changed nothing but documentation, tripped
the same gate merely by quoting the trigger token in its description, and rewording
the description made the gate pass. So on four PRs that genuinely do change the
dashboard, the requirement is real and the maintainer has to choose between
allowing a build for screenshots, integrating past the gate with admin rights, or
carrying these four into a later round.

#1711 and #4038 were started on the recommendations already recorded in their plan
docs rather than waiting further, because the round's instruction was to finish the
work. Each PR body states the contested choice: #1711 says plainly that a custom
catalog field cannot grey out the native Codex picker, which only understands
`list` and `hide`; #4038 names #4040 and explains that the minimum-decode-window
guard is what answers the objection that closed it. Both are cheap to revert.

### Second-round audit findings, all fixed

`_research/_audit_wp3b.md` passed #4165 and #4166 and raised four items, all since
addressed by Lane B: custom dashboard rows dropped `quotaInactiveReason` on the
rebuild from `config.customModels`; the zero-credit test covered the helper and
`deriveEntry` but not the gather-to-served-entry path; the Logs attempt table
rendered only the end-to-end rate although the DTO already carried the decode rate;
and the new field reached `/api/request-history`, which the plan had asked to keep
out.

The audit also answered the question worth asking about #4165's earlier CI failure:
the fix filled a missing stamp on the `deriveEntry(null, …)` fallback and extended
the new test to cover both derivation paths. No existing catalog equality was
relaxed to make the suite pass.

Fixing the last of those broke the typecheck, which is worth recording because it
is a direct cost of this round's constraints: with local typecheck forbidden, a
signature change is only discovered by remote CI, and the `gates` job's failing
step has to be read out of the workflow rather than seen locally.

A1 and A2 were audited again **after** they landed, against `origin/dev` rather
than against the lane's own report. Both match the fix the plan chose, both
regression tests are genuinely red on the old code, and nothing the plan named as
"must stay green" was deleted to make the suite pass. Record:
`_research/_audit_wp2.md`.

One behaviour worth knowing, found by that audit and not by the change itself: a
Claude request carrying **only** in-messages system text and no `metadata.user_id`
now emits no `prompt_cache_key` at all, because the fallback hashes `systemParts`
and that is empty once the reminders move into the timeline. That is absence, not
rotation — before the change those turns produced a key that moved every turn — so
it is an improvement, but a request in that exact shape no longer gets a proxy-set
key.

## Decisions taken during the round

Record each one here as it happens, with who decided and on what evidence. A
dropped item is a decision, not a gap — say why it was dropped and leave the issue
open with a comment explaining the state it was left in.

**Lane re-split, main session, after the roadmap audit.** #1711 moved from Lane A
to Lane B because the two lanes' write sets overlapped in
`src/codex/catalog/parsing.ts`, `provider-fetch.ts` and `Models.tsx`. Lanes are
now 3 and 5. Evidence: `_research/_audit.md` finding 8, commit `9abb66387`.

**#4148 scope, main session, recorded in the plan and the PR body.** Every
in-messages system message becomes a developer item, not only the ones after the
first user turn. A leading-only hoist keeps the old test green while still
mutating `instructions` when a client injects a fresh leading system message each
turn, which is the reported failure.

**#4141 held, main session.** It must rebase onto PR #4152, which rewrites the
same `runLaunchctl` runner and belongs to the separate task investigating the
live-proxy shutdowns. Lane A was told to hold rather than invent a second seam.

**Lane B dammed by the UI-screenshot gate, escalated to the maintainer.**
`enforce-target` requires a screenshot whenever a PR mentions `gui` and auto-drafts
until one exists, so #4156 and #4158 fail on that alone with every other check
green. Producing one needs `bun run build:gui`, which this round's no-local-build
constraint forbids. #4160 is fully green but sits behind them. Lane B reported
itself blocked rather than working around the gate, which is the correct behaviour.

## Rules this record exists to enforce

- A PR is only "merged" here once `git fetch origin && git merge-base --is-ancestor`
  proves the merge commit is on `dev`.
- "CI green" means a run at the **exact head SHA** concluded `success`, proven by
  `gh run view <id> --exit-status`. A cancelled run never counts.
- PRs here target `dev`, so GitHub does not auto-close the linked issue. The
  "Issue closed" column is only ticked after closing it by hand with the merge
  commit as evidence.
- Local suite, typecheck, build, lint and `privacy:scan` are NOT RUN for every item
  in this round, by the maintainer's constraint. Remote CI is the only gate, and
  each PR body says so.

## Lane B landed — 2026-09-10

The maintainer's answer to the escalation above was to land the stack. All four
are on `dev`, each proven with `git merge-base --is-ancestor` against a fetched
`origin/dev`:

| PR | Issue | Merge commit |
|---|---|---|
| #4156 free-model classification and filter | #3666 | `2b1146eeee6c9ea55ea842286c31e7f2bbedc0f4` |
| #4158 model-sync discovery dependency | #4075 | `8471ecccd8d8dd20c8b3d56858aa13ff8cc77ddf` |
| #4166 estimated decode rate in Logs | #4038 | `386b6a0d9a8acef818b9c40ebd472e4974750199` |
| #4165 quota-exhausted models marked inactive | #1711 | `27836a0128b1cc386a05cd324a9260483a3d6fe7` |

### How the gate was cleared

With `gui-screenshot-waived`, applied by the project owner, plus a comment on each
PR saying what that means. The reasoning is in `120_landing_gate_decision.md`; the
short version is that the label is described in this repository as a waiver for
*false-positive* screenshot requirements and these four are not false positives,
so the record says so rather than letting the label imply the gate misfired. The
maintainer-comment waiver path was deliberately not used, because the phrase that
satisfies it asserts the change does not touch the GUI, and that would be false.

Mechanically the gate is not a merge blocker: ruleset 20763889 on `dev` carries
only `deletion`, `non_fast_forward` and `pull_request` rules, with no required
status check. What it does is hold the PR in draft, and a draft cannot be merged.
The waiver drops `missing_ui_screenshot` and the same run marks the PR ready,
because each carried a stored gate comment with `autoDraftedByBot` true.

### What the independent audit changed

Two read-only `xai/grok-4.6` reviewers were dispatched before anything was
mutated: one re-read every open bot finding against the current head, one verified
the merge mechanics against the live ruleset and the workflow source.

The findings reviewer produced one blocking result, and it was a real defect
rather than a style note. On #4156 the Free-only narrowing read the raw per-provider
flag while the switch that controls it renders under `pricingKnown`. When the
pricing evidence goes away, the control disappears and the stale `true` keeps
filtering an inventory in which nothing can classify as free, so the list empties
with no visible way to undo it — and `models.noFreeMatch` then tells the operator
to turn off a switch that is not on screen. Fixed in `07d7f49c4` before the merge:
`freeOnlyInForce` lives beside the predicate in `models-shared.ts` so both consumers
read the same derived flag, and `tests/gui/models-free-filter.test.ts` covers the
lapse plus source-oracle assertions that neither surface goes back to the raw flag.

Two threads on #4165 were already fixed by later commits and were dismissed on the
evidence: the CodeRabbit dual-path `deriveEntry` stamp (`sync.ts:395` and `:443-446`,
with the regression test looping both a null and a cached template) and the Codex
P2 on custom management rows (`model-rows.ts` copies the gather reason by slug).

### Findings landed with a written disposition

- **#4165, Codex P1, prime quota evidence before stamping.** Not taken. The badge
  is deliberately cache-only: `quotaInactiveReason` reads `getCachedProviderQuota`
  and a null cache ends the vote, so an unprobed provider is unknown rather than
  exhausted. The cost of the alternative is quota fan-out on every catalog gather.
  The visible consequence is a first Models load that shows no badge until some
  other quota consumer has run, which is the fail-closed direction.
- **#4165, Codex P1, document the new dashboard state.** Not taken here. No
  `docs-site/` page describes the catalog chips today; the chip carries its own
  tooltip. A dashboard-guide paragraph is follow-up work, not a merge blocker.
- **#4165, CodeRabbit minor, "every provider" vs "every usable target".** Accurate
  criticism of the copy: disabled or missing targets drop out of the vote, so the
  sentence overstates on a combo with a disabled member. Left as-is because the
  same phrasing exists in the five locales the bot did not flag, and changing four
  of nine would make the catalogs disagree.
- **#4166, Codex P2 and CodeRabbit minor, decode-rate label and accessible name.**
  The compact table stacks a second rate under a header whose tooltip still
  describes full-request throughput, and the stacked span carries only `title`. The
  detail dialog does label it. Follow-up polish.
- **#4166, docs.** `web-dashboard.md` still documents only full-request speed.
  Same follow-up.

### Conflicts

All four touch the nine locale catalogs, and three touch `Models.tsx`,
`models-shared.ts` and the catalog parser, so each landing invalidated the next
branch. #4158 needed no rebase: its duplicated commit has the same patch-id as the
one already on `dev`, so the three-way merge was clean. #4165 conflicted in eleven
files, every one of them an additive collision — the same declaration list, the
same locale catalog, the same row type — resolved by keeping both sides.

Worth recording because it nearly shipped: two of those hunks shared a single
JSDoc opener, so keeping both bodies left the second block without its `/**` in
`models-shared.ts` and `parsing.ts`. A mechanical keep-both resolution produces
broken TypeScript there, and the only reason it did not reach CI is that the
merged region was read afterwards.

### Evidence and what was not run

Every merge waited for a green run at the exact head SHA, including the two heads
created during this landing (`07d7f49c4` on #4156 and `ae56a60de` on #4165) — so
both the fix and the conflict resolution were verified remotely before landing.
Local suite, typecheck, build, lint and `privacy:scan`: **NOT RUN**, unchanged from
the rest of this round. Pushes used `--no-verify`.

Issues #3666, #1711 and #4038 were closed by hand with the merge commit as
evidence. #4075 was already closed against `8471ecccd` and received the same
evidence comment.
