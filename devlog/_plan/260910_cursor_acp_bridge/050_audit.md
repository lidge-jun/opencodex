---
title: A-phase audit
unit: 260910_cursor_acp_bridge
date: 2026-09-10
reviewer_verdict: FAIL (round 1), FAIL (round 2)
main_disposition: folded twice
---

# 050 -- Audit

## Setup

Independent reviewer, read-only, dispatched on `gpt-5.6-sol` at `xhigh` with
`cxc-dev-code-reviewer` and `cxc-search` attached. Read bounds: this repository,
`cli-jaw`, and the public web.

Model family was chosen deliberately for decorrelation (REVIEW-DECORRELATE-01).
The three evidence lanes and the design consult all ran on `xai/grok-4.6`; a
fourth grok context would have shared their blind spots, and the blind spot is
exactly what turned out to matter.

The reviewer's brief was adversarial by construction: verify every `path:line`
by opening the file, and specifically attack the central premise by checking the
ACP spec for any client-side mechanism to constrain the agent.

## Verdict

**FAIL**, 8 blockers. The unit did not advance to B on this audit.

That was the correct call, and the reviewer earned it: **blocker 1 falsified the
document's main argument.**

## Blockers and dispositions

**1. The "no tool-less lever" premise was false. FOLDED -- verdict rewritten.**

040 asserted "ACP offers no such lever [...] There is no client-supplied tool
list and no tool-less mode." The reviewer cited ACP's `session/set_mode` and
session config options, and Cursor's own ACP documentation for `plan` and `ask`
modes.

Main verified this independently rather than taking it on report, by fetching
`cursor.com/docs/cli/acp` directly:

> **Modes** -- ACP sessions support the same core modes as CLI:
> `agent` (full tool access), `plan` (planning, read-only behavior),
> `ask` (Q&A/read-only behavior)

The reviewer is right and the claim is retracted in 040. The verdict was rebuilt
on contract semantics and on Cursor's proprietary blocking extension methods,
which are grounded in the same page and do not depend on any unproven filesystem
behavior. Confidence in the verdict was lowered explicitly.

**2. Protocol claims about `session/update` timing were overstated. FOLDED.**
ACP does define a pending -> permission -> `in_progress` tool-call lifecycle. The
"reports an edit that already happened" framing was withdrawn and replaced with
the narrower, defensible point: the ownership direction is inverted between
Codex's `tool_call_start` and ACP's `tool_call`.

**3. A residual had leaked into the verdict body. FOLDED.**
"Cursor works anyway, because it does the IO in its own process rather than
asking" was an inference stated as fact, violating this unit's own accept
criterion 6. Removed; the current verdict relies on it nowhere, and residual 3
now says explicitly that no claim is made about mutation-under-denial.

**4. Citation ranges were wrong. FOLDED.**
`src/types/request.ts:310-354` excluded the `error` member it was cited for (it
is at `:355`). `turn.ts:81-144` did not contain the spawn/stdin/stdout/stderr
handling attributed to it (`:147-152`, `:243-258`, `:194-222`). Docs paths
carried literal `...` placeholders. Test paths were bare basenames. All corrected
in 030 after main re-opened each file.

Root cause worth recording: 030 was assembled from a subagent report, and
citation drift is the characteristic defect of that pattern. The lane's numbers
were mostly right and its anchors were mostly one region off. A verbatim-anchor
requirement on the lane is necessary but not sufficient -- someone has to reopen
the files.

**5. The stated verifier read none of the unit's files. FOLDED.**
`scripts/privacy-scan.ts:60` sources its input from `git ls-files`. Every file
in this unit was untracked, so `bun run privacy:scan` passed while scanning none
of them, and the plan's claim that it "observes every file this unit adds" was
false as written.

Fixed properly rather than reworded: the unit was `git add`-ed,
`git ls-files -- devlog/_plan/260910_cursor_acp_bridge` now returns all five
files, and both gates were re-run against the tracked state
(`privacy:scan` exit 0; `repo-hygiene` 14 pass / 0 fail). 000 now records the
original failure as a worked example of the PLAN-VERIFIER-REAL-01 trap.

**6. Model-surface claim overclaimed. FOLDED.**
"Strictly smaller" was not supported by the cited threads, which also record
later improvements including a fast Composer 2.5 variant. Replaced with dated,
attributed, per-claim statements and an explicit note that no live ACP roster was
collected, so set inclusion is unproven.

**7. Deliverable contradicted the scope boundary. FOLDED.**
The plan promised "a correction to an existing OpenCodex planning document" while
also declaring nothing outside this unit would be touched. Reworded: the
deliverable is the *recommendation*; the edit belongs to `800_agent-fabric/`.

**8. Architect gate unmet. FOLDED as an explicit waiver.**
The reviewer correctly observed that recording a gap does not close it. Native
`agent_type: "architect"` is absent from this session's schema and registering it
needs a separate authorized install plus a fresh session. 000 now records an
explicit process waiver scoped to a docs-only unit, and states that a GO decision
on ACP-D2/D3/D4 may not inherit it.

## Rebutted

None. All eight were accepted. That is itself a signal about the first draft.

## What the audit changed

The conclusion ("not a provider") survived, but its **reasoning was replaced**.
The original argument was that Cursor could not be constrained over ACP. That was
wrong. The surviving argument is that a mode is a behavioral assertion rather
than a structural guarantee, that cursor-agent ignores Codex's tool list either
way, and that Cursor's blocking `cursor/ask_question` and `cursor/create_plan`
would force an OpenCodex adapter to answer human-facing questions with no human
present.

A conclusion that survives while its premise is destroyed deserves suspicion. It
is recorded here so a later reader can weigh it, and the decisive residual -- a
live `ask`-mode trace -- is named in 040 as the thing that would reopen ACP-D2.

## Non-blocking findings accepted

- The HTTP write/delete guard is narrower than `--tools ""`; the real redirect
  explanation lives at `native-exec-fs.ts:42-46`, and `native-exec.ts:649-650`
  only selects the helper. 040 no longer calls them equivalent.
- `--no-session-persistence` disables vendor session persistence; "denies it
  memory across turns" overstated it, since OpenCodex replays conversation input.
- 010 mislabelled the IBM Research project page's date; the 2025-06-13 date
  belongs to a linked Think article. Corrected. The protocol distinction stands.
- ACP v1 has no generic client-provided allowlist over an agent's built-in tools.
  Clients can supply MCP servers, select modes, decline client fs/terminal
  methods, and answer permission requests -- but permission requests are optional
  from the agent's side, so refusal alone is not a sandbox.
- Source snapshots matched: OpenCodex `58acdaeb7`, cli-jaw `f626a0428`.

## Round 2 -- the folds were incomplete

The same reviewer re-audited the folded text and returned **FAIL again**. It was
right a second time, and the failure mode is worth recording because it is
specific and recurring.

B1, B7 and B8 were confirmed RESOLVED. The rest were not, for one reason: the
round-1 folds **added retractions without removing the retracted sentences**. 040
gained a section correctly withdrawing the timing claim while, further down, the
containment argument still read "`session/update` reports an edit that has
already landed" and "ACP never routes the mutation through the client at all".
010 still said the HTTP provider "strictly dominates" after 040 had withdrawn
exactly that phrase. 020 still asserted that declining client capabilities "does
not prevent the agent from touching the disk".

A retraction that leaves the original standing is not a retraction. It is worse
than the original error, because the document now contradicts itself and a reader
can quote either half.

The reviewer also caught the round-1 folds introducing a **new** overclaim: 040
said an adapter "must fabricate answers" to `cursor/ask_question`, when the
documented contract allows `skipped` and `cancelled` outcomes, and the source
never established that every `plan`-mode turn raises `cursor/create_plan`. Both
corrected.

Round-2 dispositions:

| Blocker | Round-2 status | Round-2 action |
|---|---|---|
| B1 | RESOLVED | none needed |
| B2 | NOT RESOLVED | contradicting sentences in the containment section rewritten around discretionary-vs-structural mediation |
| B3 | NOT RESOLVED | 020's disk assertion bounded to what it proves; 040's containment claim no longer rests on it |
| B4 | PARTIAL | 030 model-catalog rows given file-head anchors; accept criterion 3 in 000 amended to match what the unit actually delivers rather than quietly under-delivering |
| B5 | PARTIAL | 050 itself was untracked; now staged with the rest and gates re-run over all six files |
| B6 | PARTIAL | 010's "strictly dominates" withdrawn to match 040 |
| B7 | RESOLVED | none needed |
| B8 | RESOLVED | none needed |
| NEW-1 | folded | "must fabricate" corrected; `plan`-mode trigger claim qualified |
| NEW-2 | folded | this section; the round-1 closure record was inaccurate when written and is superseded here |
| NEW-3 | folded | 050 staged |

## Process note

The reviewer exceeded its wait window repeatedly and was time-boxed in round 1
with an instruction to return what it had verified. Its round-1 citation table
covers ~45 anchors.

Two rounds, sixteen accepted findings, zero rebuttals. The honest reading is that
the first draft of this unit was confidently wrong in its central claim and
sloppy in its citations, and that both were caught only because the audit was
dispatched on a different model family with an explicitly adversarial brief. A
same-family reviewer had already read this material three times without noticing
that Cursor documents a read-only mode.

## Cycle 2 audit -- the live trace

After the keychain was unlocked, the trace this unit could not run was run and
recorded in [070](./070_live_trace.md). A bounded reviewer (`gpt-5.6-sol`) audited
the **harness**, not the prose, and returned GO-WITH-FIXES with four blockers.
All four were folded; all four were about claiming more than two runs support.

| # | Finding | Fold |
|---|---|---|
| 1 | "no protocol-level request of any kind" overclaims: the harness counted four frame classes, not all inbound methods | 070 now says none of those four classes was observed, and adds an explicit scope note |
| 2 | One ask run and one agent run generalized into "enforced", "all-or-nothing", "exactly two settings" | every conclusion now scoped to this version/model/prompt |
| 3 | Unique display names do not prove one variant per underlying model; the 1M check was a string match that would miss `1024k` | roster claims softened to what was positively observed |
| 4 | 040 still said mutation-without-asking "was not tested" and carried a stale ACP-D2 row | both rewritten |

The reviewer confirmed the two things that mattered: the harness genuinely does
detect `session/request_permission`, `fs/*` and `terminal/*` (dispatch order does
not swallow them), and the mutation is proved because the same path is hashed and
reread with full content captured. So the zero-permission result is a real zero,
not an instrumentation artifact.

**This cycle reversed a retraction.** Cycle 1 withdrew the claim that Cursor
mutates without offering a refusal point, because it could not be shown. Cycle 2
showed it. The reviewer had been right about the ACP *specification* and wrong
about *Cursor's implementation of it* -- and the unit had been right for the
wrong reason, then wrong to retract, then right again with evidence.

That sequence is the most useful thing in this unit. A spec-grounded objection
defeated an implementation-grounded intuition during audit, and only a live trace
could settle which one described reality. Prose review could not have.
