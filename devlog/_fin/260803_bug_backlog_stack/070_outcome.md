# 070 — Outcome

## What shipped

A four-layer stack off `origin/dev` at `14b20def2`, each layer targeting the
one before it.

| PR | Layer | Contents |
|---|---|---|
| #951 | 1/5 | triage: 22 label corrections + this plan unit |
| #952 | 2/5 | #908 long-context pricing tiers |
| #953 | 3/5 | six carried contributor bug fixes |
| #954 | 4/5 | #545 classifier thinking round-trip |
| #955 | 5/5 | #915 cooldown early-recovery probe |

All four checks green on every layer. `enforce-target` passes on the stacked
children, which is the gate that decides whether this shape is allowed at all.

## Disposition of the sixteen bug issues

| Outcome | Issues |
|---|---|
| fixed in this stack | #908, #545, #915 |
| blocked upstream, evidenced | #907 (canonical source in `lidge-jun/jawcode`) |
| stale evidence, re-test requested | #875 (tested 115 commits before the fix) |
| reclassified | #919 → `enhancement` (deliberate policy, not a defect) |
| already owned by an open PR | #586, #893, #914, #938 |
| upstream trackers | #92, #241, #417 |
| awaiting reporter | #418, #796, #904 |

Zero closed on a partial fix. Every open issue now carries at least two labels.

## What the audit gates were worth

Twelve adversarial rounds across three units, nine FAIL.

On the plan (4 rounds, 3 FAIL): long context × Fast composition is impossible —
OpenAI does not serve long context in Fast mode, so the `$7.80` figure
described a request that cannot exist. The `-pro` aliases were unpriceable, so
a tier row could never have been reached and the proposed test would have
failed against the real estimator. `usesAdaptiveThinking()` was the wrong gate
and would have required breaking a passing test to ship a 400.

On the #545 code (3 rounds, 2 FAIL): the gate silently missed
`anthropic/claude-sonnet-5`. Then **my own remediation was worse than the bug** —
normalizing with `lastIndexOf("/")` fixed the prefix case and broke the suffix
case, and since the adaptive-wire predicate shares that parse, a slash-suffixed
Sonnet 5 would have been sent obsolete manual `thinking.enabled` and 400d. A
silent truncation traded for a hard failure, caught only because the reviewer
re-ran the comparison across the full existing matrix rather than trusting the
four ids I had listed.

Two of the plan blockers would have shipped code that passed CI and was wrong.

On the #915 code (5 rounds, 4 FAIL) the failures compounded, and each one was a
smaller version of the same mistake:

1. Unknown plans failed **open** — an unfamiliar `plan_type` cleared a cooldown
   on evidence we could not interpret.
2. The fix for that was an allowlist, which missed `prolite`.
3. The allowlist was then the wrong *shape*: the snapshot carries 21 plan
   strings with 12 unclassified, and `CodexAccount.plan` is unrestricted. Every
   omission meant an account cooled **forever** — this unit's own defect,
   reintroduced as a typo-shaped hole. Replaced with the parser's binary rule,
   now shared by parsing, exhaustion, and recovery.
4. The replacement test computed its expectation from the function under test,
   so ablating the rule to always-weekly still passed 18/18.

Three of those four were introduced by *fixing the previous one*. The lesson is
not that lists need care; it is that a list was never the right answer where the
domain is an open string.

Three tests also passed vacuously and were rebuilt: both lease-release cases
asserted only that the cooldown survived, never that the lease returned (a
stranded lease means that account is never probed again), and the fairness test
spaced its passes inside the probe interval, so already-probed accounts dropped
out on their own and the ordering was never exercised.

## Two hypotheses that did not survive

**#545's recorded cause was impossible.** The analysis said the prepended OAuth
identity block consumed the classifier's 64 output tokens. The identity goes
into the system prompt; `max_tokens` caps output. This repository had already
rejected that theory once — `devlog/_fin/260728_bug_bundle_resolution/030_claude_system_dedup.md`
abandoned an identity-dedup patch for the same reason — and it was re-derived
anyway. The real cause was a round-trip loss where `disabled` and `omitted`
collapsed to one representation, and omitted means thinking-**on**.

**#875's reopen was correct on the evidence and wrong on the facts.** The
reporter tested `0b30283b6`; `git merge-base` puts it 115 commits before
`5dd965a13`, the commit that fixes exactly that path. Left open with a re-test
request rather than closed on an argument the reporter cannot check from their
side.

## Carried contributor work

Six PRs cherry-picked with `-x`, authorship intact, no content changes:
#939, #943, #944, #945 (@DevMello), #942 (@L14nY1Wang), #948 (@mushikingh).

Not carried, each for a stated reason: #947 conflicts with #942 on the same
relay path and resolving that is its author's call; #933 is a draft with a
failing gate; #928, #922, #940, #935 carry `CHANGES_REQUESTED`, and carrying a
PR past requested changes routes around the review.

The source PRs stay open until #953 lands, so the direct path remains available
if a maintainer prefers it.
