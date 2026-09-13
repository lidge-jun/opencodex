# 008 — Lane G: stale tail (oldest open PRs and issues)

Read-only research lane. Worktree /tmp/ocx-249.xGQnxl/wt detached at
origin/dev = 7dc7dc99e65268bc8764e19840952256b030bce9. Live GitHub state pulled with
gh --repo lidge-jun/opencodex on 2026-09-09. Divergence measured with
"gh api repos/lidge-jun/opencodex/compare/dev...HEADSHA --jq '.behind_by'", never by
fetching PR refs.

## Headline finding, stated up front

**This lane is not a stale tail.** The lane brief presumed abandonment; the live data
contradicts it for most items. Of 11 PRs, **7 have author activity within the last 8-18
days** and three (#2527, #2355, #2351) received author pushes on **2026-09-05**, four days
before this triage. Of 9 issues, **zero** are resolved-on-dev and **zero** are duplicates;
every one is a live unimplemented request, and two are explicitly protected classes
(roadmap #95, RFC #2358) with a third (#1213) being a maintainer-analyzed feasibility
boundary.

The honest verdict is therefore **2 CLOSE, 9 DEFER, 9 KEEP OPEN**. Closing the other nine
PRs on age alone would discard active contributor work, and closing the issues would
reverse a deliberate 2026-09-04 hygiene-campaign decision recorded in
devlog/_fin/260904_repo_hygiene_campaign/120_issue_verdicts.md.

The strongest anchor against a bulk close is that campaign's own reasoning, which already
covered seven of this lane's nine issues. VERBATIM, 120_issue_verdicts.md:53-56:

> Closing a report because its author has not replied yet is how a project stops receiving
> reports, and several of these are plausible defects whose evidence simply has not arrived.

A second anchor is the 2026-09-07 release-recommendation pass, which already classified
every one of these PRs as DEFER or NOT_NOW — a deferral, not a closure. VERBATIM,
devlog/_plan/260907_next_release_recommendations/010_recommendations.md:66 and :76:

> #3463, #3389, #3652, #3635 (REIMPLEMENT later), #2921, #2280, #2366, #2362, #2355, #2213, #2230, #1645, #3741, #3738,

> #3376, #3375, #3255, #3191, #2834, #2811, #2730, #2511, #2455, #2358, #1811, #1782, #1416, #1213, #95, #3464,

## Summary table

| Item | Verdict | Reason | Last activity | behind_by | Shipped-on-dev evidence |
|---|---|---|---|---|---|
| PR #2527 auto-review model override | **CLOSE** | Capability shipped on dev via a different vehicle; author still pushing a superseded branch | 2026-09-05 (author push) | 831 | src/codex/catalog/sync.ts:1689 finalizeAutoReviewModelOverride; merge 848a66d15 "ship the auto-review model override (#1688 #1225)"; docs providers.md:306 |
| PR #2462 hubapi SaaS console | **CLOSE** | 95 files, +9542 lines, no review ever started, abandoned 2026-08-24, product-direction change never agreed | 2026-08-24 | 2183 | Nothing on dev; no docs-site/src/content/docs/guides/hosted-hub.md in tree; no tenant surface |
| PR #2366 stream timeline + failure attribution | **DEFER** | Twice CHANGES_REQUESTED, author responded both times, latest round unreviewed | 2026-09-02 (author push) | 1246 | Partial: src/usage/log.ts:94 firstOutputMs, :119 tierOutcome; no durable per-attempt timeline |
| PR #2362 Responses terminal repair | **DEFER** | Feature shipped registry-side; remaining delta is the custom-provider escape hatch, not on dev | 2026-09-02 (author push) | 1244 | Shipped for registry providers only: src/providers/registry.ts:62, :206, :2026; no user config opt-in |
| PR #2355 config divergence warning | **DEFER** | Author push 4 days before triage; maintainer in live conversation 2026-09-05 | 2026-09-05 (author push) | 831 | Not on dev — no divergence string in gui/src/i18n/en.ts |
| PR #2351 config mutation audit | **DEFER** | Author push 4 days before triage; 42 files, privacy/security review needed | 2026-09-05 (author push) | 831 | Not on dev — no configAudit or mutation-audit symbol in src/ |
| PR #2280 per-model synthetic max suppression | **DEFER** | APPROVED then re-CHANGES_REQUESTED, unaddressed; parent issue #2279 still valid | 2026-09-02 (maintainer) | 2258 | Not on dev — src/codex/catalog/effort.ts:237-242 still adds synthetic max+ultra |
| PR #2244 workbuddy OAuth provider | **DEFER** | 3x CHANGES_REQUESTED in 64 min, author engaged, then silent; new credential path needs security review | 2026-08-29 (rebase only) | 1600 | Not on dev — zero workbuddy matches in src/ or docs-site/ |
| PR #2230 Gemini OAuth accounts | **DEFER** | Embedded OAuth client secret; already REJECT-for-stack with mandatory security review | 2026-08-29 (rebase only) | 1600 | Adjacent shipped (src/oauth/google-antigravity.ts, oauth/index.ts:299); no Code Assist/AI Studio subtypes |
| PR #2213 Grok direct-first tool projection | **DEFER** | 2x CHANGES_REQUESTED never addressed in code; author replied once and stopped | 2026-08-29 (rebase only) | 1600 | Not on dev — src/adapters/tool-catalog-nudge.ts has no Grok/direct-first branch |
| PR #1645 vision chat + Google sidecars | **DEFER** | Oldest and most divergent; vision sidecar shipped, chat/Google sidecar delta did not | 2026-08-21 | 2399 | Partial: src/types/config.ts:709-712 sidecar config; backends at :1072 are openai/anthropic/routed only |
| Issue #2455 queue latency + granted tier | **KEEP OPEN (partial)** | Item 2 shipped and a contributor reported it; item 1 queue latency unshipped | 2026-09-02 | — | Tier shipped: src/server/request-log.ts:607, :663-669; no queue-latency surface |
| Issue #2358 compatibility contract RFC | **KEEP OPEN** | Umbrella RFC; Phase 1 landed via #2439 and deliberately does not close it | 2026-08-23 | — | Phase 1 on dev: src/compatibility/manifest.ts:1; no CLI/GUI consumer, by design |
| Issue #2279 per-model synthetic max | **KEEP OPEN** | Valid narrow enhancement; its PR #2280 is incomplete by the reviewer's own analysis | 2026-08-21 | — | Unshipped — src/codex/catalog/effort.ts:237-242 |
| Issue #1811 Claude Science integration | **KEEP OPEN (needs-info)** | Maintainer asked one specific question 2026-09-03 and said "This is not closed" | 2026-09-04 | — | Unshipped — nothing matches in native-integration-routes.ts |
| Issue #1782 M365 Copilot provider | **KEEP OPEN (needs-info)** | Upstream-tracking; blocked on Microsoft publishing an API, not on the reporter | 2026-09-04 | — | Unshipped — no M365 symbols in src/, gui/, docs-site/ |
| Issue #1711 grey out zero-credit models | **KEEP OPEN** | Explicit maintainer keep decision; paired with #1702 | 2026-08-19 | — | Unshipped — no no_credit or disabled_reason in src/codex/catalog/sync.ts |
| Issue #1416 Orca launch manifest | **KEEP OPEN** | Maintainer left a full implementation map; only the home-collision diagnostic exists | 2026-08-19 | — | Partial: src/codex/home.ts:173 collectOrcaCodexHomeDiagnostic; no orca export client |
| Issue #1213 additive Claude Desktop catalog | **KEEP OPEN** | Original defect fixed; the reopened broader request is unaddressed | 2026-08-19 | — | Base integration on dev (agent-settings-routes.ts:935, :944); no additive/coexistence mode |
| Issue #95 hosted multi-user roadmap | **KEEP OPEN (roadmap)** | Roadmap-labeled long-term tracker with an agreed next slice | 2026-08-21 | — | Unshipped — zero TenantContext/tenantId matches in src/ |

Counts: **PRs** 2 CLOSE / 9 DEFER. **Issues** 0 CLOSE / 9 KEEP OPEN.

---

## Per-item detail

### PR #2527 — feat(catalog): provider-level auto-review model override — **CLOSE**

@harryzhou2000 · created 2026-08-25 · draft · CONFLICTING · 19 files +1983/-58 ·
reviewDecision CHANGES_REQUESTED · behind 831 / ahead 7 · last author commit
**2026-09-05T12:59:08Z**, last author comment 2026-09-05T12:31:20Z.

This is the one close that overrides recent author activity, so the reason has to be stated
plainly: **the capability the PR proposes is already on dev, landed through a different pull
request.** The author is actively pushing to a branch whose destination is occupied.

Shipped anchor, VERBATIM from src/codex/catalog/sync.ts:1689-1695:

```ts
export function finalizeAutoReviewModelOverride(
  models: RawEntry[] | undefined,
  sourceModels: readonly RawEntry[] = [],
): AutoReviewModelOverrideResult {
  if (models && sourceModels.length > 0) preserveNativeAutoReviewModelOverrides(models, sourceModels);
  return applyAutoReviewModelOverride(models, readConfiguredAutoReviewModel(), sourceModels);
}
```

It is called from the catalog write path and additionally from src/codex/convergence.ts:388,
which is precisely the dashboard-writer gap that sank an earlier attempt at this feature. The
landing commit is 848a66d15 "fix: gate root skip-permissions bypass and ship the auto-review
model override (#1688 #1225)".

The reader is src/codex/catalog/parsing.ts:236, VERBATIM including its docstring:

```ts
/**
 * Read the configured auto-review model from the root of Codex's config.toml (issue #1225).
 * Stamped onto catalog entries as `auto_review_model_override` during sync so the auto-review
 * subagent uses the operator's chosen model across catalog regenerations.
 */
export function readConfiguredAutoReviewModel(): string | null {
```

Documented at docs-site/src/content/docs/reference/configuration/providers.md:306, VERBATIM
excerpt:

> `auto_review_model` | `string` | Public catalog selector in `provider/model` form, for
> example `opencode-go/deepseek-v4-flash`. After each catalog merge, OpenCodex resolves it
> against the final catalog and stamps the trimmed value as `auto_review_model_override` on
> catalog entries. ... If it is syntactically invalid or absent from the final catalog
> (including after provider/model removal), OpenCodex fails closed for the override only: it
> clears the dead override, preserves normal upstream behavior, and emits a diagnostic.

The shipped version even satisfies the slug-validation blocker that an earlier sibling
attempt failed on. VERBATIM from
devlog/_plan/260822_backlog_disposition_program/090_wp9_new_pr_disposition.md:

> **No slug validation.** Issue #1225 requires validating the target against the same
> sync's catalog and failing clearly on an unresolved target. A stale slug is stamped
> silently, and fail-closed auto-review then denies every approval.

The prior recommendation pass already put this PR in NOT_NOW (010_recommendations.md:75).
With the feature now on dev, NOT_NOW resolves to CLOSE.

One caveat the maintainer should carry into the close: the shipped selector is read from the
root of config.toml, so it is global, while this PR's title claims *provider-level*
granularity. That narrower gap is real and the drafted comment invites it back as a small
focused PR.

**Drafted closing comment:**

> Thank you for this, and for continuing to push on it as recently as September 5 — that
> persistence is why I want to be direct rather than leave it sitting.
>
> The auto-review model override has since shipped on `dev` through a different pull request,
> 848a66d15 ("ship the auto-review model override (#1688 #1225)"). The override is stamped
> from the catalog write path in `src/codex/catalog/sync.ts:1689`
> (`finalizeAutoReviewModelOverride`), it is also applied by the dashboard/convergence writer
> at `src/codex/convergence.ts:388` so the GUI path no longer undoes it, the selector is read
> by `readConfiguredAutoReviewModel` in `src/codex/catalog/parsing.ts:236`, and the behavior
> is documented at `docs-site/src/content/docs/reference/configuration/providers.md:306`,
> including the fail-closed handling for a target that cannot be resolved.
>
> Because of that, this branch — 831 commits behind `dev` and currently conflicting across 19
> files — would be rebased onto code that already does the job. I am closing it as superseded
> rather than asking you to carry that rebase.
>
> One thing your version raises that the shipped one does not settle: the shipped selector is
> read from the root of `config.toml`, so it is global rather than provider-scoped. If
> per-provider granularity is what you actually need, that is a real remaining gap and a much
> smaller change on top of the current code. Please open a focused issue or PR for it and I
> will look at it directly.
>
> If you think the shipped implementation misses something your branch handled, reopen this
> with a rebase onto current `dev` and I will re-review.

### PR #2462 — feat(gui): deliver hubapi phase-one SaaS console — **CLOSE**

@kwannz · created 2026-08-24 · draft · CONFLICTING · **95 files +9542/-798** ·
reviewDecision REVIEW_REQUIRED (the reviews array is empty — no review was ever submitted) ·
behind 2183 / ahead 6 · last commit 2026-08-24T01:35:38Z, last activity 2026-08-24T01:36:54Z.

Abandoned after a single day of work, and the only human comment is the maintainer's on the
day it opened. VERBATIM from devlog/_fin/260904_repo_hygiene_campaign/100_pr_verdicts.md:30,
where the columns are Touched and "Still differ":

> | #2462 | @kwannz | 95 | 95 |

Every one of its 95 files still differs from dev. It was placed in NOT_NOW by the
release-recommendation pass (010_recommendations.md:75).

The scope is the problem, not the age. Its file list includes PRD.md, a rewritten AGENTS.md,
docs-site/src/components/Landing.astro, docs-site/src/content/docs/guides/hosted-hub.md and
multi-locale web-dashboard pages: a hosted SaaS product direction attached to a local proxy.
None of it is on dev — there is no hosted-hub guide in docs-site/src/content/docs/guides/,
and the tenant matches in src/ are unrelated (src/adapters/cursor.ts, src/types/config.ts).
The architectural question it raises is tracked properly as roadmap issue #95, which stays
open.

A 2183-behind, 95-file, zero-review, product-direction PR is not rebasable; it is a proposal,
and #95 is the right container for it.

**Drafted closing comment:**

> Thank you for the effort here — 95 files is a serious amount of work and I do not want that
> to go unacknowledged.
>
> I am closing this as unlandable in its current form rather than as unwanted. The branch is
> 2183 commits behind `dev` and conflicts across all 95 files, so there is no realistic rebase
> path. More importantly, the change mixes a GUI console with a product-direction shift — a
> `PRD.md`, an `AGENTS.md` rewrite, landing-page components, and a new `hosted-hub` guide
> across several locales — and a change of that shape needs agreement on the direction before
> the implementation rather than after it.
>
> That direction already has a home: #95, the roadmap issue for centrally hosted multi-user
> OpenCodex with tenant isolation, which stays open. The most recent discussion there
> converged on a concrete first slice — an immutable `TenantContext` derived only from trusted
> admission state, paired with one explicit policy contract — and that is a much better place
> to land your thinking. Nothing in this area exists on `dev` yet: there is no `TenantContext`
> or `tenantId` anywhere in `src/`.
>
> If you would like to pursue it, please comment on #95 with the slice you want to take and
> open it as a focused PR against current `dev`. I am happy to reopen this one if you rebase
> and want it reviewed as it stands.

### PR #2366 — feat(usage): durable stream timeline and failure attribution — **DEFER**

@chilung-cgu · draft · CONFLICTING · 8 files +741/-12 · behind 1246 / ahead 9 · last author
commit **2026-09-02T13:13:25Z**.

Not stale. Two separate CHANGES_REQUESTED from @Ingwannu (2026-08-29T19:25:14Z and
2026-09-01T11:57:28Z), and the author pushed again on 2026-09-02. So the answer to whether
CHANGES_REQUESTED was ever addressed is yes, twice, and the latest round has not been
re-reviewed.

Part of the scope landed independently. VERBATIM from src/usage/log.ts:94-95 and :118-119:

```ts
  /** TTFT relative to THIS attempt's start (WP4); unset for non-streaming/tool-only. */
  firstOutputMs?: number;

  /** Adapter-produced tier fact for this physical attempt; absent on pre-B0 rows. */
  tierOutcome?: AttemptTierOutcome;
```

What has not landed is the durable per-attempt timeline object and the failure-attribution
model the PR proposes; src/server/request-log.ts carries no timeline symbol. Already DEFER at
010_recommendations.md:66. Keep it there: it needs a re-review, not a close.

### PR #2362 — feat(providers): Responses terminal repair escape hatch — **DEFER**

@chilung-cgu · draft · CONFLICTING · 11 files +839/-5 · behind 1244 / ahead 10 · last author
commit **2026-09-02T14:36:21Z**, with CHANGES_REQUESTED from @Ingwannu the same day at
14:50:34Z.

The underlying feature shipped, but for registry-declared providers only. VERBATIM from
src/providers/registry.ts:62-64, :206 and :2026:

```ts
export interface ResponsesTerminalRepairPolicy {
  /** Quiet time after a structurally complete output graph before synthesizing completion. */
  graceMs: number;

  modelResponsesTerminalRepair?: Record<string, ResponsesTerminalRepairPolicy>;

    modelResponsesTerminalRepair: { "deepseek-v4-flash": { graceMs: 5_000 }, "deepseek-v4-pro": { graceMs: 5_000 } },
```

The relay is src/server/responses-terminal-repair.ts, wired at src/server/responses/core.ts
:5636-5647. The PR's actual remaining delta is the **custom-provider config escape hatch**,
which is not on dev: there is no user-facing terminalRepair field in src/types/provider.ts or
src/config.ts, so an operator running a custom provider cannot opt in.

This PR has the most instructive history in the lane, and it argues directly against closing
on age. VERBATIM from the commit message of 0b7a77194:

> The review lane for #2362 was retired under DISPATCH-RETIRE-01 after three silent wait
> cycles, and the PR was reviewed directly instead. The lane then returned with three
> resolver defects the direct review had missed, each since reproduced at the PR head: the
> canonical ChatGPT forward provider can opt into terminal repair, an invalid per-model grace
> falls through to the provider default instead of failing closed, and duplicate case-folded
> keys resolve by request casing.
>
> Retiring the lane was right; treating retirement as a verdict would not have been.

And VERBATIM from
devlog/_plan/260822_backlog_disposition_program/090_wp9_new_pr_disposition.md:

> | #2362 | Closes #1809 | reviewer lane failed to return; **reviewed directly** | **LEAVE OPEN**, blockers restated |

Those three resolver defects are exactly why this needs review rather than a merge or a
close.

### PR #2355 — feat(status): warn when config.json diverges from the running proxy — **DEFER**

@harryzhou2000 · draft · CONFLICTING · 28 files +1110/-17 · behind 831 / ahead 2 · last author
commit **2026-09-05T12:59:15Z**. Maintainer @lidge-jun commented 2026-09-05T11:50:25Z and the
author replied eight minutes later at 11:58:30Z.

Four days old at the time of this triage, with the maintainer in live conversation. Not on
dev: no divergence-warning string in gui/src/i18n/en.ts. Closing this would be a plain error.
Already DEFER at 010_recommendations.md:66.

### PR #2351 — feat(config): audit persisted config mutations — **DEFER**

@harryzhou2000 · draft · CONFLICTING · **42 files +2817/-150** · behind 831 / ahead 5 · last
author commit **2026-09-05T13:27:24Z**.

Same author, same active week. Unshipped: no configAudit or mutation-audit symbol anywhere in
src/. It is large and touches config persistence broadly (src/cli/*, src/codex/*,
src/client/state.ts), which is why it sits in NOT_NOW at 010_recommendations.md:75 and in the
hygiene table, VERBATIM at 100_pr_verdicts.md:34:

> | #2351 | @harryzhou2000 | 41 | 41 |

Redacted before/after logging of config values also sits near the privacy boundary that
`bun run privacy:scan` guards, so it needs a deliberate review pass. Defer, do not close.

### PR #2280 — feat(catalog): per-model synthetic max suppression — **DEFER**

@cristph · draft · CONFLICTING · 17 files +553/-15 · behind 2258 / ahead 7 · last author
commit 2026-08-22T10:57:53Z; maintainer comment 2026-09-02T06:31:47Z.

The review history is unusual: CHANGES_REQUESTED (2026-08-21T12:16:27Z) then APPROVED
(13:03:52Z) then CHANGES_REQUESTED again (21:03:57Z). The second rejection stands unaddressed
in code.

Unshipped, and the exact construct the parent issue names is unchanged. VERBATIM from
src/codex/catalog/effort.ts:237-242:

```ts
  if (!preserveExact && efforts.length > 0 && efforts.some(effort => effort !== "none" && effort !== "minimal")) {
    const additions: string[] = [];
    if (!efforts.includes("max")) additions.push("max");
    if (!efforts.includes("ultra")) additions.push("ultra");
    if (additions.length > 0) efforts = sanitizeCodexReasoningEfforts([...efforts, ...additions]) ?? efforts;
  }
```

Parent issue #2279 stays open, and @Ingwannu's assessment there names the incompleteness,
VERBATIM:

> The linked #2280 is not complete yet. Its current final merge can prevent a new synthetic
> max from being added, but it cannot remove a synthetic max already preserved from an
> earlier sync during degraded discovery.

Deferred as a cluster at 010_recommendations.md:56 (#2279 <-> #2280 <-> #3336). Closing the PR
while keeping the issue open is defensible in a later pass, but only alongside an explicit
REIMPLEMENT decision.

### PR #2244 — feat(workbuddy): experimental desktop OAuth provider — **DEFER**

@ZSN12 · draft · CONFLICTING · 9 files +913/-0 · behind 1600 / ahead 3 · last commit
2026-08-29T02:06:35Z, which is a rebase; the substantive work ended 2026-08-21.

Three CHANGES_REQUESTED from @Ingwannu within 64 minutes on 2026-08-21 (02:28:11Z, 02:51:42Z,
03:32:23Z), with the author replying in-thread at 03:10:35Z. None of it is on dev: zero
workbuddy matches across src/ and docs-site/.

It adds a **new OAuth credential path** (src/oauth/workbuddy.ts,
src/oauth/workbuddy-credentials.ts), which per MAINTAINERS.md requires explicit security
review. It also carries a test-layout violation: its tests are tests/workbuddy-adapter.test.ts
and tests/workbuddy-oauth.test.ts at the repository test root, where only two files may now
live. Confirmed on dev: tests/*.test.ts contains exactly tests/test-layout.test.ts and
tests/test-layout-tooling.test.ts. NOT_NOW at 010_recommendations.md:75. Defer pending a
security-review sponsor.

### PR #2230 — feat(oauth): Gemini OAuth accounts with Code Assist and AI Studio subtypes — **DEFER**

@ppvia · draft · CONFLICTING · **33 files +1637/-61** · behind 1600 / ahead 2 · last commit
2026-08-29T02:09:21Z, a rebase; substantive work ended 2026-08-20.

CHANGES_REQUESTED 2026-08-21T06:40:03Z, never addressed in code. Adjacent capability exists on
dev — src/oauth/google-antigravity.ts, src/adapters/google-antigravity-wire.ts, and the
"google-antigravity" OAuth kind at src/oauth/index.ts:299 — but the Google-account Code Assist
and AI Studio subtypes this PR adds are not there.

The blocking fact is already recorded. VERBATIM from
devlog/_fin/260908_provider_runtime_stack/013_secondary_dispositions.md:15:

> | #2230 Gemini OAuth accounts | ppvia | 33 files +1637/−62 | 16 / 16 | yes (embedded OAuth client secret) | maintainer-sponsored security review mandatory | unregistered tests | REJECT |

REJECT there is stack-scoped ("DEFER/REJECT items are not closed by this unit", same file),
not a close verdict, and the reason — an embedded OAuth client secret — is a security finding.
Handle it through security review, not through a stale-tail close.

### PR #2213 — feat: add Grok direct-first tool projection — **DEFER**

@louis-tepe · draft · CONFLICTING · 18 files +510/-98 · behind 1600 / ahead 2 · last commit
2026-08-29T02:28:09Z, a rebase; substantive work ended 2026-08-20.

Two CHANGES_REQUESTED from @Ingwannu (2026-08-20T15:44:03Z, 2026-08-21T06:42:00Z). The author
replied once at 2026-08-20T16:31:57Z and made no code change addressing them. This is the
clearest never-addressed case in the lane.

Not on dev. src/adapters/tool-catalog-nudge.ts exists but is provider-neutral and contains no
Grok or direct-first branch. VERBATIM at :19:

```ts
const NEIGHBOR_AGENT_TOOL_NAMES = ["Read", "Grep", "Glob", "Bash", "LS"] as const;
```

DEFER at 010_recommendations.md:66. This is the strongest DEFER-to-CLOSE candidate for a later
pass if the author stays silent, but the capability is still wanted, so it should eventually
be closed with a REIMPLEMENT note rather than as stale.

### PR #1645 — feat(vision): add chat and Google sidecars — **DEFER**

@waw4303 · draft · CONFLICTING · **68 files +1425/-151** · behind **2399**, the oldest and most
divergent item in the lane · last commit 2026-08-21T14:09:40Z, with CHANGES_REQUESTED from
@Ingwannu 37 minutes later at 14:46:29Z.

The sidecar subsystem has been built out substantially on dev since: src/sidecar/ exists
(auth.ts, candidates.ts), there is a full docs-site/src/content/docs/guides/sidecars.md titled
"Sidecars: Web Search & Vision", and the area is still actively maintained (3f07e09bc,
f46a7f49c, both 2026-09). VERBATIM from src/types/config.ts:709-712:

```ts
  /** Web-search sidecar: route web_search for non-OpenAI models through a gpt-mini via ChatGPT passthrough. */
  webSearchSidecar?: OcxWebSearchSidecarConfig;
  /** Vision sidecar: describe images via a gpt vision model so text-only models can "see" them. */
  visionSidecar?: OcxVisionSidecarConfig;
```

And the vision backends, VERBATIM at src/types/config.ts:1072:

```ts
  backend?: "openai" | "anthropic" | "routed";
```

So the Google sidecar and the chat sidecar this PR adds are genuinely not on dev, even though
the surrounding subsystem is. 68 files at 2399 behind is not rebasable. This is a REIMPLEMENT
candidate, and the honest handling is to keep it deferred until someone decides whether the
Google sidecar backend is wanted, then close it citing that decision. DEFER at
010_recommendations.md:66.

---

## Issues — all nine stay open

None is resolved on dev, none is a duplicate, and each was checked against the tree rather
than assumed. Seven of the nine were explicitly reviewed and left open by the 2026-09-04
hygiene campaign. VERBATIM from 120_issue_verdicts.md:38-41 and :47-49:

> ## Left open — still valid, unimplemented
>
> #95, #1213, #1416, #1533, #1711, #2279, #2358, #2455, #2495, #2511, #2730,
> #2811, #2834, #2894, #3191, #3259, #3266, #3352, #3353, #3366 and the
> needs-info set below.

> ## Left open — blocked on the reporter
>
> #1527, #1782, #1811, #3245, #3255, #3279, #3320.

### Issue #2455 — queue latency and granted service tier — **KEEP OPEN (partial)**

@nowhere1975 · created 2026-08-23 · labels enhancement, proxy · last comment 2026-09-02 by
@abhisheksharma2411.

Two-part request. Part 2 shipped, and a contributor said so unprompted. VERBATIM from that
comment:

> I went to implement item 2 and found it already ships. Writing up what I traced so nobody
> builds it twice, on `dev` at `7d25f996`.
>
> **The granted tier is captured on the `/v1/responses` path.**

Confirmed on the pinned tree. VERBATIM from src/server/request-log.ts:607-609 and :663-669:

```ts
export function requestLogSpeedLabel(serviceTier: string | undefined): string | undefined {
  const normalized = serviceTier?.trim().toLowerCase();
  if (normalized === "priority" || normalized === "fast") return "fast";

  const serviceTier = (source as { service_tier?: unknown }).service_tier;
  if (typeof serviceTier === "string" && serviceTier.trim()) {
    const sanitized = sanitizeLogMetadataString(serviceTier);
    if (sanitized) logCtx.responseServiceTier = sanitized;
    logCtx.activeTierMetadata?.observeResponseServiceTier(serviceTier);
```

Part 1 — surfacing the ~11 s public-endpoint queue wait the reporter measured — has no
implementation; request-log.ts carries no queue-latency field. Keep open, narrowed to the
queue-latency half.

### Issue #2358 — [RFC] compatibility contract, proxy budgets, OS-backed credentials — **KEEP OPEN**

@thatlev · created 2026-08-22 · labels enhancement, streaming, tools · last comment
2026-08-23 by @Ingwannu.

An umbrella RFC, and the implementer of its first slice was explicit that landing it does not
close the issue. VERBATIM:

> Implemented the maintainer-approved Phase 1 slice in #2439.
>
> The PR adds a strict passive manifest schema plus one exact fixture-backed subject
> (`openai` / forward auth / `openai-responses` / `gpt-5.6-sol`). It deliberately does not add
> the CLI/GUI surface, broaden claims to other providers, change request routing, or close
> this umbrella RFC.

Phase 1 is on dev. VERBATIM from src/compatibility/manifest.ts:1-10:

```ts
export const COMPATIBILITY_MANIFEST_SCHEMA_VERSION = 1 as const;

export const COMPATIBILITY_DISPOSITIONS = [
  "passthrough",
  "translated",
  "degraded",
  "unsupported",
] as const;
```

No CLI or GUI file imports compatibility/manifest, which matches the stated Phase 1 scope
rather than contradicting it. Phases 2 and 3 (proxy budgets, OS-backed credentials) are
unshipped. **This is the RFC the lane brief correctly flagged as stay-open.**

### Issue #2279 — suppress synthetic max per model while retaining ultra — **KEEP OPEN**

@cristph · created 2026-08-21 · labels enhancement, catalog · last comment 2026-08-21 by
@lidge-jun.

Unshipped at src/codex/catalog/effort.ts:237-242, quoted under PR #2280 above. The maintainer
confirmed the issue's diagnosis still holds on the then-current dev, VERBATIM: "지금 `dev`
HEAD `e3b2136b2`가 이슈가 찍은 그대로임" (the current dev HEAD is exactly as the issue
describes). Its PR is incomplete by the reviewer's own analysis. Keep open.

### Issue #1811 — Claude Science client integration — **KEEP OPEN (needs-info)**

@jmzhang1911 · created 2026-08-16 · labels enhancement, needs-info · maintainer comment
2026-09-03T17:28:09Z, issue updated 2026-09-04.

The maintainer asked one specific unblocking question six days before this triage. VERBATIM:

> @jmzhang1911 — following up during a backlog review. This is not closed; it needs one piece
> of information from you to move.
>
> **Where this stands.** No Claude Science integration exists on `dev`;
> `src/server/management/native-integration-routes.ts` covers the currently supported clients
> and nothing matches this one.
>
> **What would unblock it.** Please add the concrete configuration surface Claude Science
> reads — which file or endpoint it uses to discover a model provider.

The stale-bot's 7-day timer restarted that day. Unshipped. Keep open; the reply window has not
lapsed.

### Issue #1782 — Microsoft 365 Copilot as a provider — **KEEP OPEN (needs-info)**

@jojodat · created 2026-08-15 · labels enhancement, upstream-tracking, needs-info, provider ·
maintainer comment 2026-09-03T17:28:06Z.

VERBATIM from that comment:

> **Where this stands.** There is still no Microsoft 365 Copilot provider on `dev`; searching
> `src/`, `gui/`, `docs-site/`, and the git history finds no related symbols. This is
> upstream-tracking: it depends on an interface Microsoft has not made available for this kind
> of client.

The blocker is Microsoft publishing a usable API, not the reporter's diligence. This is
exactly the case 120_issue_verdicts.md:53-56 was written about. Keep open.

### Issue #1711 — grey out zero-credit models/combos — **KEEP OPEN**

@ardjo-s · created 2026-08-14 · labels enhancement, catalog · last comment 2026-08-19 by
@lidge-jun.

The maintainer recorded an explicit keep decision. VERBATIM:

> ## 리뷰 · 우선순위 40 / 80 · 유지
>
> 유지함. #1702랑 같이 가는 피커 쪽. 숨기면 안 됨. 회복되면 자동으로 다시 활성.

(Keeping it. It belongs with #1702 on the picker side. Must not hide entries. Reactivates
automatically on recovery.) Unshipped: no no_credit or disabled_reason field in
src/codex/catalog/sync.ts. Keep open.

### Issue #1416 — versioned Orca launch manifest — **KEEP OPEN**

@str0203 · created 2026-08-10 · labels enhancement, account-pool, catalog · last comment
2026-08-19 by @lidge-jun.

Lowest priority in the set (28/80), but the maintainer left a detailed implementation map with
upstream Orca links (stablyai/orca#13555, #2314, #5370) and named the consumer files, opening
VERBATIM with "구현할 때 볼 곳. 기존 export에 orca를 끼워 넣지 말고, 아래 런치 면부터 맞출 것."
(Where to look when implementing. Do not wedge orca into the existing export; start from the
launch surface below.)

Only the home-collision diagnostic exists on dev. VERBATIM from src/codex/home.ts:169-173:

```ts
/**
 * High-confidence Orca/ChatGPT dual-home diagnosis. Explicit CODEX_HOME remains
 * authoritative; this only explains when an Orca-owned shell targets a home the
 */
export function collectOrcaCodexHomeDiagnostic(deps: OrcaCodexHomeDeps = {}): OrcaCodexHomeDiagnostic {
```

There is no orca client in the export contract. Keep open.

### Issue #1213 — additive Claude Desktop catalog mode — **KEEP OPEN**

@str0203 · created 2026-08-07 · labels enhancement, catalog · last comment 2026-08-19 by
@lidge-jun.

The original destructive-restore defect is fixed, and the issue body says so itself, VERBATIM:
"The original destructive-restore defect is **partially resolved**." Base integration
confirmed on dev at src/server/management/agent-settings-routes.ts:935 (`/api/claude-desktop`
GET) and :944 (PUT), with src/codex/desired-state.ts present.

The reopened request — native Claude subscription models and OpenCodex routes coexisting in
one picker — is unaddressed, and the maintainer analyzed the feasibility split (true
first-party coexistence versus a replacement profile) rather than dismissing it. Keep open.

### Issue #95 — [Roadmap] centrally hosted multi-user OpenCodex with tenant isolation — **KEEP OPEN (roadmap)**

@rafalkwol · created 2026-07-11 · labels enhancement, **roadmap**, proxy · 13 comments · last
comment 2026-08-21 by @Ingwannu.

The most recent exchange converged on a concrete first slice. VERBATIM:

> The key distinction is exactly the one you called out: the admission-derived `apiKeyId`
> gives us attribution, not authorization. It is currently a logging/query dimension and must
> not be treated as a tenant principal or policy decision by itself.
>
> The right first implementation slice is an immutable `TenantContext` derived only from
> trusted admission state, paired with one explicit policy contract.

Nothing on dev: zero TenantContext or tenantId matches in src/. The issue's own body frames it
as "the long-term tracker for making that deployment a supported OpenCodex architecture rather
than a collection of reverse-proxy workarounds." **This is the roadmap placeholder the lane
brief correctly flagged as stay-open**, and it is also the destination for closed PR #2462.

---

## Scope and limits

Read-only lane. No push, comment, merge, close, or edit to src, tests, or gui; no subagents
spawned. No test suite was run — `bun run test` and bare `bun test` are outside this lane — so
every shipped-on-dev claim rests on source reading, git log, and rg against the pinned
worktree rather than on execution. That is the main limitation of the evidence here: a symbol
present in the tree is strong evidence a capability exists, but it is not proof the capability
behaves correctly at runtime.

Divergence figures come from the GitHub compare API against origin/dev = 7dc7dc99e and will
drift as dev advances; re-verify behind_by immediately before acting on any item. The two
drafted closing comments are drafts for a maintainer to post; nothing was posted.

