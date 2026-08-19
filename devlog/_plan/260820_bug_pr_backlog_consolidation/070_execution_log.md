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

