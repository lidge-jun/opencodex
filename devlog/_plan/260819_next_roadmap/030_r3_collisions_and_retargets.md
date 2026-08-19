# 030 — R3: duplicate-fix collisions and wrong-branch retargets

Work-phase: wp3. Scope: **review, retarget, rebase. No merges.**

## Collision A — `prompt_cache_retention` (issue #2092), three PRs

The ChatGPT codex backend 400s on gpt-5.6 models when
`prompt_cache_retention` is forwarded. Three PRs fix it three incompatible
ways. Only one can land.

| PR | Where it strips | Predicate | Base |
|---|---|---|---|
| #2091 luvs01 | `stripUnsupportedForwardParams` | ALL ChatGPT-backend Responses, any model | dev |
| #2099 yzxcj797 | new `stripPromptCacheRetentionForGpt56`, forward path | `modelId.startsWith("gpt-5.6")` | **main** |
| #2102 lilinxiong | new `stripDeprecatedPromptCacheRetention`, passthrough | `=== "gpt-5.6" || startsWith("gpt-5.6-")` | dev |

**Recommendation: #2102.**

The deciding evidence is in #2099's own comment: one deployment accepted
`"24h"` and echoed it back. The backend's cache handling is account-level and
has provably varied. So a global strip (#2091) silently removes a parameter
that some accounts honor — it fixes the report by making the feature
unavailable to everyone.

Between the two model-scoped fixes, #2102 is on the right branch and its
predicate is tighter: `startsWith("gpt-5.6")` (#2099) also matches a
hypothetical `gpt-5.60`, while `"gpt-5.6"` exact-or-`"gpt-5.6-"`-prefixed
cannot. #2102 also tests four concrete ids rather than one.

#2102 declines to translate `24h` into the replacement
`prompt_cache_options.ttl`, and says so: GPT-5.6 uses a different TTL
contract, and implicit caching still applies when the caller sent no
replacement. Inventing a translation would be the one change here that could
alter billing behavior.

Action: recommend #2102; close #2091 and #2099 with this rationale. #2099 is
also on the wrong branch and appears in the retarget list below — retargeting
it and closing it are the same decision, taken once.

**One risk to raise with #2102 rather than silently accept.** Its sanitizer is
called *outside* the `if (forward)` branch, so it also strips the field from
API-key and third-party `openai-responses` passthroughs — not just the ChatGPT
forward path the issue is about. Current OpenAI guidance (replace
`prompt_cache_retention` with `prompt_cache_options.ttl` on GPT-5.6) makes
that defensible for genuine OpenAI endpoints, but the tests exercise only the
forward-mode provider. Ask for an API-key regression test and an explicit
decision about custom OpenAI-compatible endpoints before merging.

## Collision B — K12 short-window quota (issue #2047), two PRs

This one is **not** a duplicate, and reading it as one would reintroduce a bug
we already caught.

`#2056` (Ingwannu, base dev) was reviewed and held as needs-work for a
specific reason: a fail-open in `computeCodexUsageScore`. An account whose
cached quota carries only `shortPercent` — no weekly, no monthly — scored 0
instead of `CODEX_UNKNOWN_USAGE_SCORE` (101), making an account with
*unverified* long-window quota look like the coolest candidate to
`pickLowestUsage*`. Short-only WHAM snapshots do enter the valid cache, so this
is reachable.

`#2062` (yzxcj797, base main) fixes the same issue and **has the same
fail-open**. Its `computeCodexUsageScore`:

- 30-day plans: when `monthlyPercent` is absent, `return burst !== undefined ? burst : CODEX_UNKNOWN_USAGE_SCORE` — a short-only account scores `burst`, so `shortPercent: 0` scores 0.
- other plans: `burst` joins `values`, so a short-only account scores `max([burst])` = `burst`.

Its test suite covers the saturated-burst direction
(`{weeklyPercent: 1, shortPercent: 100}` → 100) but never the short-only case
the review flagged.

`pickLowestUsageAmong` keeps the lowest score, so a short-only 0 beats an
account with verified long-window usage.

**Reachability differs from #2056, and an audit lane was right to narrow
this.** #2056 adds `shortPercent` to `hasKnownQuotaValue`, so a short-only
WHAM snapshot enters the valid cache and reaches the scorer on the ordinary
parser path. #2062 does not: its `hasKnownQuotaValue` still checks only weekly
and monthly, so a short-only parse returns `null`. On #2062 the fail-open is
reachable through unvalidated disk hydration or direct cache insertion, not
through a normal WHAM response.

That makes #2062's fail-open narrower, not absent — and it is still the same
defect class the #2056 review named, sitting in code that will be asked to
accept short-only state as soon as anyone finishes the feature.

**A second defect in #2062 that #2056 does not have:** it preserves the short
tuple only during `creditsOnly` refreshes. A later weekly/monthly partial
snapshot without short fields rebuilds `next` and drops the tuple, and
`updateAccountQuota` likewise omits existing `shortPercent`/`shortResetAt`/
`shortWindowSeconds`. #2056 handles both preservation cases explicitly.

So neither supersedes the other: on preservation #2056 is ahead, on
reachability #2062 is accidentally safer, and both carry the scoring
fail-open. Neither should merge until the short window is treated as an
**additional pressure signal gated on a governing long window being present**.

Action: neither merges this phase. Post the shared root cause on both, so two
contributors are not each debugging half of it, and name the preservation gap
on #2062 specifically.

## Wrong-branch retargets — eight PRs

All eight target `main`, are auto-titled `[WRONG BRANCH]`, and are draft.
`main` only moves by maintainer promotion, so none can merge as-is.

| PR | Author | Head | Mergeable |
|---|---|---|---|
| #2110 | drakonkat | `fix/antigravity-allow-baseurl-override` | MERGEABLE |
| #2109 | drakonkat | `fix/anthropic-allow-baseurl-override` | MERGEABLE |
| #2099 | yzxcj797 | `fix/pcr-strip-gpt56-2092` | MERGEABLE |
| #2082 | yzxcj797 | `fix/agr-language-preamble-2074` | MERGEABLE |
| #2063 | yzxcj797 | `fix/k12-detail-denial-2046` | **CONFLICTING** |
| #2062 | yzxcj797 | `fix/k12-short-window-quota-2047` | MERGEABLE |
| #2032 | yzxcj797 | `fix/claude-root-bypass-sandbox-1688` | MERGEABLE |
| #2029 | yzxcj797 | `fix/no-session-bus-absent-1939` | MERGEABLE |

**Every head lives in a contributor fork.** We retarget the base with `gh`; we
do not touch their branches. Rebasing a fork head is the author's job, and
force-pushing someone else's branch is out of scope by the objective.

`#2063` is CONFLICTING and also overlaps `#2055`, which already merged as a
partial fix for #2046. It needs a diff against current dev before it is worth
the author's rebase.

## Exit criteria

- `c-pcr`: winner chosen with written rationale traced to actual diffs.
- `c-k12`: decision recorded, with the shared fail-open named on both PRs.
- `c-wrongbranch`: all eight read `baseRefName=dev`.
- Zero merges in this work-phase.
