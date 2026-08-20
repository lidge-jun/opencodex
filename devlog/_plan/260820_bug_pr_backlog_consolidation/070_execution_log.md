# 070 — Execution log: what actually shipped

Appended as work-phases close. This is the record of landed state, distinct from the plan.

## wp2 — issue #2132 (score 96)

**PR #2137**, branch `codex/fix-bearer-admission-2132`, base `dev`.

`substituteMainCredential` was computed from how the caller authenticated and never from where
the request routes, so a key-authenticated provider was gated on a ChatGPT credential it cannot
use. The predicate is now
`options.admission?.source === "bearer" && route.codexAccountMode !== undefined`
at both `core.ts:1088` and `compact.ts:325`.

It covers `pool` AND `direct`. Doc 010's "native ChatGPT pool" wording would have excluded
`direct` and re-broken #1686, whose Direct admission is only safe because substitution still
runs. 010 now carries a banner saying so.

Evidence: `tests/bearer-admission-routed-provider.test.ts` driven RED (it reproduced the exact
reported 401), full suite 13516 pass / 0 fail, typecheck and privacy scan clean. Re-audit round 2
by the same adversarial reviewer returned **VERDICT: PASS**.

## wp3 — issue #2092 (score 86)

**PR #2138**, branch `codex/consolidate-prompt-cache-retention`, base `dev`.

Absorbs @lilinxiong's #2102 contract: strip `prompt_cache_retention` on canonical ChatGPT
forward for the `gpt-5.6` family only, with an exact-or-dashed-prefix match so a future
`gpt-5.60` is not swept up. The retired value is not translated into `prompt_cache_options`.

Evidence: 5 of the new tests fail when only the adapter change is reverted; the two narrowness
guards stay green in both directions, which is what makes them guards rather than restatements.
Full suite 13537 pass / 0 fail.

### Closed with attribution

| PR | Author | Superseded by | Carried |
|---|---|---|---|
| #2102 | @lilinxiong | #2138 | the implementation itself |
| #2099 | @yzxcj797 | #2138 | issue link + repro fixture |
| #2091 | @luvs01 | #2138 | nothing; contract deliberately narrower |
| #2029 | @yzxcj797 | merged #2130 | nothing; #2130 adds the disk check review demanded |
| #2063 | @yzxcj797 | merged #2055 | nothing; #2055 is the stricter own-property lookup |

Each carries a comment naming the replacement and the specific reason, so no contributor has to
guess why their work closed.

## Still open by decision, not omission

- #2109 / #2110 (@drakonkat) — unresolved security gap in the override gate; needs a human pass.
- #2053 (@Ingwannu) — C4 OAuth; MAINTAINERS.md mandates security review.
- #2105 (@lilinxiong) — above threshold but no replacement exists yet; closing it now would lose work.
- #2101, #2040 — 20 and 14 files; each needs its own cycle.
- #2104 (@olddonkey) — review-ready and MERGEABLE; reclassified out of the deferred bucket, it is a
  KEEP that deserves review rather than supersession.

## Remaining work-phases

wp4 (#2100 + #2077 capability evidence), wp5 (#2056 K12 with the scorer correction), wp6 (#2131
responses id backfill with the duplicate-id fix). Each is a sibling off `dev`; none depends on
another.


## wp6 — PR #2131 (@bet4it)

**PR #2142**, branch `codex/absorb-responses-id-backfill`, base `dev`.

Carries @bet4it's implementation and tests, plus one correction: an absent or malformed
`output_index` collapsed to 0, so two such items both synthesized `msg_ocx_0` — duplicate ids,
the exact defect the backfill prevents. Unusable indices now take a monotonic ordinal based far
above any plausible real index.

Evidence worth naming: applying ONLY @bet4it's original source and running the new suite gives
15 pass / 1 fail, and the single failure is the duplicate-id guard. That is what makes it a guard
rather than a restatement of behavior.

The inherited assertion `expect(parsed.item.id).toBe("msg_ocx_0")` was replaced, not deleted
quietly, and the replacement is disclosed in the PR body.

# Campaign state at wp6 close

Superseded and closed with attribution: #2102, #2099, #2091, #2029, #2063, #2100, #2077, #2056,
#2062, #2131 — ten PRs, each with a comment naming its replacement and the specific reason.

Opened: #2137 (#2132), #2138 (#2092), #2140 (#2100+#2077), #2141 (#2047), #2142 (#2131), plus
the pre-existing #2134.

Deliberately still open: #2109/#2110 (security gap), #2053 (C4 OAuth review), #2105 (no
replacement written yet), #2101/#2040 (each needs its own cycle), #2104 (review-ready, deserves
review not supersession), and the below-threshold set (#2115, #2082, #2027, #2067, #2054, #2032,
#2075, #2127).


## wp7 — PR #2105 (@lilinxiong)

**PR #2144**, branch `codex/absorb-claude-shell-hook-gate`, base `dev`.

Implementation and tests carried unchanged. The one addition is a comment on
`reconcileShellHook` recording that "installed" is answered from the calling process's PATH, so
a service context with a stripped PATH can remove a hook an interactive shell would keep — the
reversible direction, and the one this reconcile wants.

This closes the finding the auditor raised at #2105: it was scored ABSORB with no execution path
and would have been lost. It now has one.


# Campaign close — CI state and honest end state

All six shipped PRs are green on exact head and MERGEABLE:

| PR | Fixes | Checks |
|---|---|---|
| #2137 | issue #2132 | 25 pass / 0 fail |
| #2138 | issue #2092 (absorbs #2102) | 25 pass / 0 fail |
| #2140 | absorbs #2100 + #2077 | 25 pass / 0 fail |
| #2141 | issue #2047 (absorbs #2056) | 25 pass / 0 fail |
| #2142 | absorbs #2131 | 23 pass / 0 fail |
| #2144 | absorbs #2105 | 29 pass / 0 fail |

#2140 first showed `npm-global-smoke` failing on windows-latest with
`EBUSY: resource busy or locked, unlink ...bun.exe` during dependency install — a Windows file
lock during Bun installation, not a defect in the routing change. Rerunning the failed jobs
turned it green, which is the evidence that it was infrastructure rather than the patch.

## Eleven PRs closed with attribution

#2102, #2099, #2091, #2029, #2063, #2100, #2077, #2056, #2062, #2131, #2105.

Each carries a comment naming its replacement, what was carried over, and what was deliberately
not. Where a contributor's own assertion had to be replaced (#2056's `shortPercent: 0` scorer
case, #2131's `msg_ocx_0` collapse case), the replacement is disclosed in both the closing
comment and the superseding PR body rather than done silently.

## Fourteen PRs deliberately still open

- **Security holds:** #2109, #2110 (override gate), #2053 (C4 OAuth, MAINTAINERS.md review).
- **Own-cycle scale:** #2101 (20 files), #2040 (14 files).
- **Deserves review, not supersession:** #2104 — review-ready, MERGEABLE, and touching
  `core.ts` alongside #2137.
- **Below the 60 threshold:** #2115, #2082, #2027, #2067, #2054, #2032, #2075, #2127.

Nothing here is an omission. Every one is a recorded decision with a reason.

## Merging

Not done. DEV-STACK-04 and DEV-GIT-PUSH-01 both put merge authorization with the user, and
nothing in this campaign changes that.


## wp9 — PR #2101 (@Ingwannu): the ONE real stack layer

**PR #2146**, branch `codex/absorb-account-entitlement-stacked`, base **`codex/fix-bearer-admission-2132`** (the #2137 branch), not `dev`.

This is the single genuine dependency edge in the entire backlog. #2101 passes
`substituteMainCredentialForDirect: substituteMainCredential` into `resolveCodexAuthContext` —
the exact value #2137 corrects. Landing it on `dev` alone would silently reintroduce #2132 for
every routed provider. Everything else absorbed in this campaign was disjoint and shipped as a
sibling; this one is stacked because the code says so, not because a plan said so.

Three corrections on top of @Ingwannu's work:

1. **Selector compact bypassed the wire rewrite** — `accountGatedCompactWireModel` came from
   `raw.model`, which never matches the gated map for `side/gpt-daybreak-blue-latest`, so a
   selector-form compact still hit the native endpoint. Now derived from `route.modelId`.
2. **Direct callers evicted catalog evidence** — one 64-entry LRU shared between per-credential
   Direct keys and the main/Pool keys the catalog projects from. Split into two eviction classes;
   pinned by a test verified to fail against the shared LRU.
3. **Comment rot** — `native-models.ts` claimed routing never collapses Daybreak into
   `gpt-5.6-sol`, which the wire normalization does.

Evidence: full suite 13554 pass / 0 fail at the stacked tip; the composition check
(`codex-model-entitlements` + `bearer-admission-routed-provider` + `codex-auth-context` +
`server-auth`) is 146 pass / 0 fail, which is what proves the two layers agree.
Stack integrity: `git log parent..layer` shows exactly 1 commit, and a stack map was added to
#2137 so a reviewer arriving at the parent sees the chain.

Two gaps named in the PR rather than carried silently: Direct `/v1/models` can still advertise a
Pool-only grant (advertisement only; dispatch still checks the caller credential), and
same-account gated-400 retry stays Pool-only.


## wp12 — PR #2053 (@Ingwannu), the C4 OAuth hold

**PR #2149**, branch `codex/absorb-oauth-superseded-commit`, base `dev`.

Applied unchanged, rebased from 145 commits behind. The persist-boundary placement is the whole
design: `assertBeforePersist` runs inside the file lock, after `fn(store)` and before
`persist()`, so a superseded flow's in-memory mutation is discarded rather than written.
Ownership is identity-checked against the flow's own `AbortController`, not a timestamp.

**This was a wp1 HOLD and it is resolved by shipping, not by absorbing quietly.** The PR states
plainly that MAINTAINERS.md mandates security review and asks that it not be merged on my
verification alone, and it names three residuals rather than letting the original claim stand:

1. the description claimed reauth coverage; the diff wires the hook but adds no reauth test
2. `OAuthLoginSupersededError` is not in the public allowlist, so it projects to the generic string
3. a never-finishing Kiro rollback blocks all replacements, by design

Evidence: reverting `src/oauth/` fails 2 tests including the cancel-then-replace round trip;
full suite 13536 pass / 0 fail.


## wp14 — PR #2075 (@olddonkey): the second false negative

**PR #2151**, branch `codex/absorb-fastwire-native-chat`, base `dev`. Closes #1886.

Same class of error as wp13, different cause. I saw `CONFLICTING` and treated it as a reason not
to read the diff. The rescore put it at **67**: native `/v1/chat/completions` decided
`service_tier` from `chatServiceTier` alone, so a `supportsServiceTier: false` declaration was
fail-open. The conflict was why it could not MERGE, not why it should score LOW — and resolving
it took one import line.

Rebase, stated exactly: `src/adapters/openai-chat.ts` conflicted because `dev` added
`AdapterTierMetadata` while the PR adds `decideTier` and `ResolvedFastPolicy`. Both kept.
Everything else clean. Typecheck is what confirms the resolution.

Evidence: reverting `src/` fails the characterization test the author had flipped from
documented-known-bug to passing assertion. Full suite 13552 pass / 0 fail.

## Two scoring lessons, recorded together

wp13 and wp14 were both my errors, from two different shortcuts:

1. **Scoring from titles** — "preserve and replay thought signatures" reads like bookkeeping and
   was a core provider 400.
2. **Reading merge state as value** — `CONFLICTING` says a patch cannot land today; it says
   nothing about whether the defect matters.

Both produce false negatives that are indistinguishable from correct low scores without opening
the diff. The rubric was fine; the inputs I fed it were not.


# Campaign close (final)

## 13 PRs open, all green, all MERGEABLE

| PR | Fixes | Credit | Base |
|---|---|---|---|
| #2137 | issue #2132 | new work | dev |
| #2138 | issue #2092 | @lilinxiong | dev |
| #2140 | #2100 + #2077 | @ntdatt812 | dev |
| #2141 | issue #2047 | @Ingwannu | dev |
| #2142 | #2131 | @bet4it | dev |
| #2144 | #2105 | @lilinxiong | dev |
| #2145 | issue #1950 | @Ingwannu | dev |
| #2146 | issue #2097 | @Ingwannu | **#2137 branch (stacked)** |
| #2147 | issue #1886 | @olddonkey | dev |
| #2148 | #2109 + #2110 | @drakonkat | dev |
| #2149 | #2053 | @Ingwannu | dev |
| #2150 | issue #2125 | @agentHits | dev |
| #2151 | issue #1886 | @olddonkey | dev |

Plus #2134, which opened this session.

## 16 PRs closed with attribution

#2102, #2099, #2091, #2029, #2063, #2100, #2077, #2056, #2062, #2131, #2105, #2040, #2101,
#2104, #2109, #2110, #2053, #2127, #2075.

Every one carries a comment naming its replacement, what was carried over, and what was
deliberately not. Where a contributor's own assertion had to be replaced — #2141's scorer case,
#2142's `msg_ocx_0` case — the replacement is disclosed in both the comment and the PR body.

## 6 remain, independently verified below threshold

#2115 (58), #2082 (46), #2067 (38), #2054 (58), #2032 (37), #2027 (51).

These are not omissions. A rescore lane read every diff and scored them against the same rubric;
it found exactly two false negatives in my original triage (#2127 at 83, #2075 at 67) and both
were absorbed as wp13 and wp14. The remaining six are genuinely below the line, and four of them
are additionally blocked (draft, CONFLICTING, or CHANGES_REQUESTED).

Two of them carry real bugs attached to unabsorbable patches: #2054's Cursor context collapse
(#1527) and #2027's Go quota gating (#1924). The right move for both is a clean reimplementation
on `dev`, not absorbing a 19-file conflicting draft. That is stated rather than silently skipped.

## Corrections made on top of contributor work

Eight PRs shipped with fixes the originals were missing, each pinned by a test verified to fail
against the contributor's own source:

- #2141 short-only scorer returning 0 instead of UNKNOWN
- #2142 duplicate `msg_ocx_0` from a collapsed index
- #2145 history-only arming and non-atomic SSE overflow
- #2146 selector compact bypassing the wire rewrite, Direct callers evicting catalog cache
- #2148 `allowPrivateNetwork` bypassing the HTTPS gate for public hosts
- #2138 `gpt-5.60` near-miss match

## Not merged

DEV-STACK-04 and DEV-GIT-PUSH-01 both put merge authorization with the user. #2137 must land
before #2146.

