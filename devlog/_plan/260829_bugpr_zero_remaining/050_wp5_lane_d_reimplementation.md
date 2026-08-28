# wp5 — Lane D: reimplementation lane

Dependency position: after wp8, wp2, wp3. These PRs have correct intent but a branch that
cannot land as-is: a rejected assumption, an unresolved reviewer finding, a hygiene block,
or a base so old that a rebase is a rewrite.

Each member below runs as its OWN full PABCD cycle inside this lane's sequence. One decade
doc holds the lane because the members share one procedure; the one-work-phase-one-cycle
invariant is satisfied by appending a work-phase per member at wp5's P (LOOP-UNIT-CHAIN-01)
rather than building several members in one B.

## Members and the specific defect to carry forward

### #2812 — IPv4-mapped IPv6 with an explicit zero group (issue #2810)

Author widened the mapped-IPv6 regex in src/lib/destination-policy.ts. Ingwannu requested
changes on the exact head: the central equivalence assumption is wrong, because a RESERVED
IPv6 address whose tail merely resembles a public IPv4 would then be admitted as public
(::ffff:0:5db8:d822 must stay blocked). The wanted behavior is the narrow benchmark case,
not a general equivalence. Reimplement on current dev with tests that pin BOTH directions:
::ffff:0:c612:1b classified, ::ffff:0:5db8:d822 still refused. Closes #2810.

Note the ordering dependency: #2798 (wp2) also edits src/lib/destination-policy.ts, so this
member is implemented AFTER #2798 lands and re-reads the merged file.

### #2796 — AgentRouter openai-chat client fingerprint (issue #2717)

Reviewer found the patch incomplete on its own terms: src/adapters/anthropic.ts imports the
shared framing helpers but never applies agentRouterDefaultHeaders, so AgentRouter Anthropic
requests can still omit the required originator. Reimplement so every supported adapter
applies the shared identity policy, with an idempotence test. Closes #2717.

### #2797 — doctor env_key readiness (issue #2713)

Two findings: src/cli/doctor.ts can throw when env_key is an inherited Object.prototype key
such as toString (truthy but no own .trim()), and the PR claims Closes #2713 while only
diagnosing the condition. Reimplement the diagnostic with an own-property guard and a test
for the prototype-key case; do NOT claim #2713 closed, since that issue asks for
shim-independent injection.

### #2835 — Kiro one visible answer

The code/test change is current and focused (src/adapters/kiro.ts + two tests), but the same
commit publishes host identity in devlog/.../030_wp1_live_measurement.md: hostname, internal
address, PID, uptime, flagged P1. Reimplement as a code-and-test-only PR with the
measurement doc redacted or omitted. The disclosure detail itself stays out of any tracked
file.

### #2828 and #2638 — MOVED OUT of this lane to wp9

The A-gate audit found both had advanced since triage: #2828 is now non-draft at
`019c792607` with zero commits behind dev, and #2638 is at a rewritten `375e6f8fb8`, also
zero behind. In both cases the recorded CHANGES_REQUESTED review is bound to a SUPERSEDED
head (#2828: `1031a509a9`; #2638: `c8556f3703`), so the findings that put them in a
reimplementation lane may already be fixed on the current head. Discarding a contributor's
branch over a stale finding is both wasteful and unfair, so they get a current-head re-audit
first: see `080_wp9_current_head_reaudit.md`. Reimplementation stays available if the
current head still fails review.

### #2744 — Recover encrypted agent tasks on the combo path (added after the audit)

Missed by the first triage pass. Draft, CONFLICTING/DIRTY, 140 behind, CHANGES_REQUESTED,
head `1d8e35462a`. Four files: `package.json`, `src/server/responses/core.ts`, and two
agent-task-recovery tests.

Two hard constraints on its replacement:

1. **The `package.json` hunk must NOT be carried forward.** The stale branch bumps
   `2.34.0 -> 2.36.0`, which happens to converge on wp8's value, but a version bump has no
   business in an agent-task-recovery fix, and carrying it forward would re-litigate wp8's
   restricted-surface decision inside an unrelated PR. The replacement touches core plus
   tests only.
2. It touches `src/server/responses/core.ts`, so it runs AFTER wp4 and re-verifies against
   the accumulated file.

Its recorded blocker — recovered plaintext persistence — is a credential surface and needs
non-author security review.

## Ordering constraint for this lane (from the audit)

`src/server/responses/core.ts` is touched by #2807 (wp4), #2497, #2793, and #2744. wp4 lands
FIRST, then each core-touching member rebases onto the accumulated core and re-runs its own
regression rather than trusting a result obtained against an older file. #2807's test scans
`core.ts` and counts rotation sites, so a later core merge can silently invalidate that
assertion — which is exactly why wp4 goes first rather than last.

The verifier for a stale generated surface is `bun run skill:surface:check` (read-only);
`bun run skill:surface` WRITES the file and is a generator, not a gate.

### #2793 — Codex keyring passthrough (issue #2718)

78 files, +2211/-238, 97 behind, hygiene-blocked as unsponsored_surface, seven unresolved
current-diff findings including a cache path that overwrites a known managed account id with
null. This is not a rebase candidate. Extract only the defect issue #2718 actually reports
(persistent "Needs re-authentication" plus truncated catalog) and implement that narrowly;
the WebSocket/quota/GUI work is out of scope for a bug campaign.

### #2497 — native main token refresh (issue #2221)

496 behind, CONFLICTING, 20 files across the credential core, with unresolved design
findings: non-atomic publication (a crash between two writes leaves no auth.json), account-id
equivalence treated as grant ownership, and one logical replay expanding to as many as nine
physical sends. The previous campaign already aborted a rebase here on semantic conflicts.
Reimplement the #2221 refresh defect narrowly on current dev, atomically, with non-author
security review before merge.

## Disposition rule for this lane

A member is only closed as superseded once its replacement PR is MERGED, never on the
promise of one. The close comment names the replacement PR and the merged SHA, and credits
the original author.

## Accept criteria

1. Every member reaches merged-replacement or explicitly-closed-with-reason.
2. Security-surface members carry non-author review, or are reported BLOCKED with the
   MAINTAINERS.md requirement quoted.
3. No security reproduction detail for an unfixed defect is written into devlog/.
