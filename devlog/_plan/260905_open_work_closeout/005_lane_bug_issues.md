# Lane 005 — Open bug issues (read-only adversarial review)

Worktree: `/private/tmp/ocx-closeout.xomWAA/wt`, detached at `origin/dev` **0f27bbeb3** (2026-09-05).
Repo: `lidge-jun/opencodex`. Scope: READ-ONLY. No `src/`, `tests/`, `gui/` modification; no repository-wide suite run.

SUPERSEDED_BY_PR is used per the lane brief for an issue whose fix is carried by an open PR; it maps to the campaign SUPERSEDED disposition.

## Summary table

| Item | Disposition | One-line reason |
|---|---|---|
| #3522 | SUPERSEDED_BY_PR #3525 | Spill health projection absent on dev (`src/responses/state.ts:2108-2152`); #3525 is MERGEABLE with 25/25 CI green on head `288506dc`. |
| #3506 | DEFER | Upstream-owned no-progress loop; #2628 already ruled the proxy cannot infer workspace progress, and the proposed guard needs a client progress-marker contract that does not exist. |
| #3467 | SUPERSEDED_BY_PR #3469 | `classifyGoogle` has no location branch (`src/adapters/google-errors.ts:74-76`); #3469 is APPROVED with CI green but CONFLICTING — needs a mechanical rebase. |
| #3464 | IMPLEMENT | Version skew is warn-only (`src/cli/version-skew.ts`, `src/cli/doctor.ts`); launchd bakes package-local Bun/CLI paths (`src/service.ts:66-73,490-507`) with no stable-launcher parity. |
| #3462 | SUPERSEDED_BY_PR #3489 (rebase required) | `isBenchmarkDnsAnswer` covers only IPv4 benchmark and explicit-zero-mapped forms (`src/lib/destination-policy.ts:135-145`); #3489 is APPROVED but went CONFLICTING on head `dbcfde8c` during this review. |
| #3433 | DEFER | Reporter's own evidence attributes the regression to a Hermes plugin change; no dev-side defect isolated, and the remaining ask is a diagnostics feature. |
| #3425 | IMPLEMENT | `isTerminalShortWindow` requires a future `shortResetAt` (`src/codex/routing.ts:409-422`) and 502 is classified transient (`src/codex/quota-rejection.ts`); neither #3502 nor #3529 touches the Codex pool path. |
| #3424 | SUPERSEDED (already fixed) | Reporter ran 2.40; the `muse-spark-1.3-contributor` Responses wire default landed in `878f75417`, in v2.41.0 and not v2.40.0 — `src/providers/registry.ts:1627`. |
| #3406 | SUPERSEDED_BY_PR #3407 | Real dashboard defect, but #3407 is DRAFT, CONFLICTING, and RED on 5 checks; carry or reimplement rather than land. |
| #3352 | DEFER | Fail-closed entitlement projection working as designed (`src/codex/model-entitlements.ts:370,552-644`; 401 at `src/codex/auth-context.ts:413,444`); admitting unknown is a security-policy change. |
| #3320 | DEFER | Production XML writes a locale-independent SID (`src/service.ts:1845,1909-1920`); exact UserId matching is a deliberate identity boundary. Needs redacted live XML. |
| #3245 | DEFER | 426 is intentional (`src/server/index.ts:1144`); failure occurs before the Responses bridge, and no post-426 POST trace was captured. |

---

## #3522 — Windows continuation spill failures behind healthy readiness

**Disposition: SUPERSEDED_BY_PR #3525**

PR facts (head `288506dc6883fa8433cf89014e72d01c1675317d`, base `dev`, author Ingwannu): mergeable MERGEABLE, mergeStateStatus BLOCKED (review gate only), reviewDecision REVIEW_REQUIRED, not a draft. CI on that exact head: **25 checks pass, 0 fail** (2 skipping matrix legs), including gates, all 4 test shards, macos 1/2 and 2/2, and all three keyring and npm-global platforms. Not conflicting with current dev.

**Defect proven on dev.** `responseStateMetrics()` exposes only cumulative counters: `spillWrites` and `spillWriteFailures` (`src/responses/state.ts:2108-2109`, populated at `:2151-2152`). There is no status, no failure streak, no last-error code, and no timestamp. That is exactly the observability gap the reporter hit: 1,988 successes frozen while failures climbed to 11,365, with readiness still healthy and no way to distinguish one failed response from a process that can no longer persist continuations.

**Test evidence.** #3525 carries `tests/responses/responses-state.test.ts` (+124 lines) covering repeated-failure-then-success and Windows ACL exhaustion followed by a healthy runner. Those assertions are RED on dev because the fields they assert do not exist.

**Blockers.** None found. The diff is 8 files, confined to `src/responses/state.ts`, `src/server/management/system-routes.ts`, docs, and tests. The projection stays on the authenticated `GET /api/system/memory` and is deliberately kept off unauthenticated `/healthz`, which is the right call for the security boundary. The error-code union is closed and raw messages, paths, and response ids are excluded, consistent with the privacy rule in AGENTS.md.

**Scoping caveat, and it is the PR author's own.** This lands instrumentation, not a root-cause fix. The 2.39.0 incident has not been reproduced on 2.42/2.43. The issue should stay **open** after #3525 merges, pending an exercised snapshot. Closing #3522 on this merge would be wrong.

**Dependencies.** `src/responses/state.ts` is a high-traffic file; sequence #3525 before any other campaign PR touching response state.

## #3506 — Cursor/Grok 4.6 no-progress loop

**Disposition: DEFER**

No open PR. The issue is already labelled `upstream-tracking`, and that label is correct.

**Why this is not implementable as filed.** The reporter is honest that this recurs after #2600/#2628, where the project already established that OpenCodex cannot safely infer workspace progress from protocol activity. The new evidence strengthens the diagnosis — the model ignored an explicit in-prompt no-progress policy, confirming prompt-level guidance is not enforcement — but it does not change ownership. The proxy sees read-only tool traffic and successful HTTP; nothing in that stream distinguishes productive reading from looping.

The reporter's own suggested contract concedes the blocker: it requires an explicit, privacy-safe progress marker from a capable client. No such marker exists in the wire protocol today, and inventing one is a product decision with a client-side counterpart, not a bug fix. Item 3 of that proposal, allowing the guard to cancel an active Cursor stream, also collides with the existing rule against replaying potentially side-effecting tool calls.

**Concrete defer reason:** requires a product decision plus an upstream/client protocol addition. Recommend keeping it open under `upstream-tracking` for discoverability, which is the fallback the reporter explicitly asked for.

## #3467 — Antigravity location error misclassified as invalid_request

**Disposition: SUPERSEDED_BY_PR #3469 (rebase required)**

PR facts (head `e11089af85f8c1da4e67fe388b768d09078e8dcb`, base `dev`, author agentHits — the same person who filed the issue): reviewDecision **APPROVED**, not a draft, CI **25 checks pass, 0 fail** on that head. But mergeable **CONFLICTING**, mergeStateStatus DIRTY.

**Defect proven on dev.** `classifyGoogle()` funnels any `status === 400`, or any message merely containing the substring invalid, into the invalid-request label (`src/adapters/google-errors.ts:74-76`). There is no location or region branch anywhere in that classifier chain (`:58-78`). A FAILED_PRECONDITION user-location rejection therefore surfaces as `invalid_request_error`, telling the operator their payload is malformed when the real cause is geography or a datacenter IP. The misdiagnosis is the whole harm: it sends people to debug their prompt instead of their egress route.

**Test evidence.** #3469 adds coverage in `tests/google-errors.test.ts` (+23), `tests/error-fidelity.test.ts` (+20, including mixed-case), and `tests/google-vertex-http.test.ts` (+28). The classification assertions are RED on dev since `isLocationUnsupportedMessage` does not exist.

**Conflict assessment.** Files touched: `src/lib/errors.ts`, `src/adapters/google-errors.ts`, `src/adapters/google-http.ts`, plus 3 test files. Total diff is small (+115/-3). The conflict is **mechanical**, not semantic: these are additive pattern-list and branch insertions into files that moved underneath the branch. No behavioral redesign is implied by a rebase.

**Blocker to check on the rebased head.** The PR logs an actionable diagnostic warning to console in `normalizeFinalGoogleError()` (`src/adapters/google-http.ts`, +16). Confirm that warning emits no request body, URL, or account identifier — privacy:scan must stay green and AGENTS.md forbids logging request bodies or account identifiers. The described text (advising a check of TUN, proxy, or IPv6 routing) appears safe, but verify on the rebased head.

**Fix list for LAND_WITH_FIX:** (1) rebase onto current dev, (2) re-run exact-head CI, (3) confirm the new console warning is privacy-clean and not spammy for a looping client.

## #3464 — mise upgrade leaves launchd proxy on an old version

**Disposition: IMPLEMENT**

No open PR addresses this. Reporter garysassano; this is the macOS counterpart to the resolved Linux/mise issue #2898.

**Defect proven on dev, two distinct halves.**

*Half 1: detection is warn-only.* Version skew is computed in `src/cli/version-skew.ts` and produces a warning string (this ocx on PATH is stale). `src/cli/doctor.ts` merely reports it. Nothing in the request path refuses to route, and nothing repairs the service. So a user whose CLI is 2.42.0 and whose proxy is 2.10.1-preview keeps silently routing through the stale binary — which is exactly how the reporter's Copilot requests kept sending the private metadata field that the installed adapter would have stripped.

*Half 2: the launchd plist bakes package-local paths.* `cliEntry()` resolves both the Bun runtime and the CLI entry from `import.meta.dir` (`src/service.ts:66-73`), and `buildServiceShellCommand()` bakes those absolute paths into the plist as an exec of that bun and cli (`:490-507`, `:556-558`). The comment at `:83` already acknowledges the failure mode: when a version manager deletes the old package, the unit's exec of the old bun and old cli cannot resolve. The reporter's variant is worse in one way — it did resolve, because mise kept the old package tree around, so the stale proxy kept serving. The systemd side gained a stable launcher for exactly this mise/asdf case; launchd did not.

**Test evidence.** Nothing exists on dev; a PR would need to carry its own. Minimal regression: a `tests/service*.test.ts` case asserting the generated launchd plist references a stable launcher path that survives a package-directory swap, plus a version-skew test asserting the mismatch is surfaced as an actionable repair affordance rather than a passive warning.

**Fix sketch.** (1) Give launchd the same stable-launcher indirection the systemd unit already uses, so the plist points at a path that survives an out-of-band package upgrade. (2) On detected skew, either auto-repair the service or fail closed with an actionable error naming `opencodex service restart` — the reporter confirmed that single command fully repaired the state. Prefer the actionable-error route by default: auto-restarting a service mid-request is a larger behavioral change than this issue authorizes.

**Dependencies.** Touches `src/service.ts`, which is also implicated by #3320. Stack #3464 and any #3320 work rather than running them in parallel.

## #3462 — Discovery blocked under Clash/Mihomo IPv6 fake-IP

**Disposition: SUPERSEDED_BY_PR #3489**

PR facts, re-read immediately before verdict (head `dbcfde8ca445c8dd04b04932904798664aae9cab`, base `dev`, author Flowershangfromthebranches): reviewDecision **APPROVED**, not a draft, CI green on the last completed run (24 pass, 0 fail, including CodeRabbit; only a skipping Windows matrix leg is non-pass). But mergeable **CONFLICTING**, mergeStateStatus **DIRTY**.

**Drift warning.** An earlier read during this same review showed this PR as MERGEABLE/BLOCKED on a different head. It moved to `dbcfde8c` and went CONFLICTING while the review was in progress, and the green CI above belongs to the earlier run rather than to the current head. Re-run exact-head CI after the rebase; do not rely on the recorded pass counts.

**Actual diff surface (re-read).** The change does not live in `src/lib/destination-policy.ts` at all: it touches `src/lib/provider-outbound.ts` (+54/-1, the `isCanonicalUrl` seam), `src/providers/model-discovery.ts` (+76), `src/codex/catalog/provider-fetch.ts` (+11/-2), and `src/server/management/provider-routes.ts` (+7/-2), plus `tests/command-code-fakeip-discovery.test.ts` (+378, new) and `tests/provider-model-discovery-contract.test.ts` (+60). So it admits a proven canonical destination upstream of the policy check rather than widening the policy predicate itself.

**Defect proven on dev.** `isBenchmarkDnsAnswer()` (`src/lib/destination-policy.ts:135-145`) admits only (a) answers already carrying the benchmark-address detail, that is IPv4 198.18/15, canonical mapped, and NAT64 forms, and (b) the explicit-zero-mapped IPv6 spelling whose embedded quad is itself a benchmark address. A Mihomo IPv6 fake-IP answer in `fdfe:dcba:9876::/48` matches neither: it classifies as a non-global address, fails the `EXPLICIT_ZERO_MAPPED_PREFIX` check at `:141`, and is rejected. Called from `:344` and `:443`. The reporter's error text matches this path exactly.

**Why #3489 supersedes rather than merely overlaps.** #3489 addresses the same admission gate (`resolvePublicAddresses` rejecting fake-IP DNS before the TUN layer can intercept) and does so with a **better security posture** than #3462's proposed patch. The issue proposes hardcoding a `startsWith("fdfe:dcba:9876:")` test — a community-convention prefix with no RFC standing, admitted purely on string shape. #3489 instead proves the final request URL against the registry's own canonical discovery URL (`isRegistryModelDiscoveryUrl`), with exact origin, path, and query matching and an `isCanonicalUrl` seam that defaults closed. That is a narrower grant: it admits a specific proven destination rather than widening the private-address allowlist for every caller.

**Residual gap — must be verified before closing #3462.** #3489's writeup is framed around IPv4 fake-IP (198.18.0.0/15) and the no-proxy-env daemon case. #3462 is IPv6 (`fdfe:dcba:9876::7e`) **with** a proxy configured. The canonical-URL proof should admit the IPv6 case too, since it keys on the URL rather than the address family, but that is an inference from the design and not something I confirmed by executing the IPv6 path. **Do not auto-close #3462 on #3489's merge.** Ask the reporter to re-verify on a build carrying #3489, or add an explicit IPv6-fake-IP regression case to `tests/command-code-fakeip-discovery.test.ts`.

**Blockers.** None in #3489 itself; its security-boundary section enumerates the rejections it preserves (literal benchmark IPs, RFC1918, metadata endpoints, NO_PROXY hosts, caller-modified query). Note its self-reported baseline: management-provider-validation shows 19 failures identically on unmodified dev on that host, environmental and unrelated.

**Dependencies.** `src/lib/destination-policy.ts` is security-boundary code per AGENTS.md and requires explicit security review.

## #3433 — Intermittent zero cache hits for Hermes

**Disposition: DEFER**

No open PR. Reported against 2.41.0 by Vivamisu, using a third-party Hermes Agent client.

**No dev-side defect isolated.** Inbound `prompt_cache_key` forwarding demonstrably exists and is deliberate: preserved on the chat inbound path (`src/chat/inbound.ts:316`), parsed into options (`src/responses/parser.ts:827`), and forwarded to `/chat/completions` behind an explicit per-provider opt-in (`src/adapters/openai-chat.ts:156-157`, flag documented at `src/types/provider.ts:592` and `src/providers/registry.ts:303`). That opt-in is a likely partial explanation — a provider row without `promptCacheKey` set will not forward the key — but the reporter has not said which provider row they used, so it cannot be confirmed.

**The reporter's own evidence points away from the proxy.** Their before/after table brackets a Hermes update (90.7% cache-read rate down to 26.0%, 0 up to 26 zero-cache requests), and they document a Hermes plugin that failed to load because it passed an unsupported `supports_codex_affinity_headers` constructor field. Cache identity that alternates between a large prefix, a small fixed prefix, and zero, then recovers to 393,728 cached tokens without any endpoint change, is the signature of a client varying its own prompt prefix rather than a proxy dropping a header.

**What the issue actually asks for.** Five of its questions are documentation requests, and the sixth (question 5) is a feature request: expose redacted presence/absence diagnostics for cache key, affinity identifiers, and resolved routing cohort. That is reasonable and would settle the question empirically, but it is new observability work, not a bug fix, and it must respect the AGENTS.md privacy rule (presence/absence booleans only, never values).

**Concrete defer reason:** needs reporter evidence — specifically the provider row in use and whether `promptCacheKey` forwarding is enabled on it, plus an A/B against an unchanged Hermes build. Answer their protocol questions in-thread; split the diagnostics ask into a separate feature issue.

## #3425 — Routing continues to a 5h-exhausted Codex account after repeated 502s

**Disposition: IMPLEMENT**

**Neither suggested PR addresses this.** I checked both. #3502 (Ingwannu) is generic and Anthropic OAuth pool plus Kiro continuation credentials and docs — it touches `src/oauth/anthropic-routing.ts` and `src/oauth/generic-account-failover.ts`, not the Codex pool. #3529 (yansigit, DRAFT) is API-key failover persistence in `src/providers/key-failover.ts`. The Codex ChatGPT account pool (`src/codex/routing.ts`) is a different code path from both, so #3425 remains unowned.

**Defect proven on dev, two reinforcing mechanisms.**

*Mechanism 1: a 100% window only excludes an account when a future reset timestamp is present.* `isTerminalShortWindow()` (`src/codex/routing.ts:409-422`) returns false unless `shortResetAt` is a finite positive number and resolves to a moment still in the future (`:418-421`). A snapshot carrying `shortPercent: 100` with a missing or already-elapsed `shortResetAt` scores `CODEX_UNKNOWN_USAGE_SCORE` instead of `CODEX_EXHAUSTED_USAGE_PERCENT` (`:387`), so the exhausted account stays selectable. The doc comment at `:395-407` shows this is a deliberate trade — a wrongly-selected account fails one request. The reporter's data is what that trade looks like when it goes wrong: **118 consecutive HTTP 502s over 23 minutes**, not one failed request.

*Mechanism 2: 502 is classified transient, so it never demotes the account.* `src/codex/quota-rejection.ts` lists 502 among `TRANSIENT_SERVER_STATUSES`, yielding a transient-server-error kind. A quota exhaustion wrapped in a 502 without a canonical message body therefore produces no quota signal at all — consistent with the reporter's log showing `sendCount: 1` and an empty `recoveryKinds` on every attempt. Nothing feeds back into selection, so the next request picks the same account again.

Together: the fresh quota snapshot says 100% but cannot exclude (missing or stale `shortResetAt`), and the 502s say nothing. Account B at 3% is never reached until a human pauses A.

**Test evidence.** None on dev. The reporter supplied a good regression spec; the minimal test is account A with `shortPercent: 100` and an absent `shortResetAt`, account B healthy, threshold 80, multiple admissions, asserting that new admissions select B. A second case should assert that a bare 502 with no persisted canonical message does not override a fresh snapshot already marking A at 100%. Both are RED on dev.

**Fix sketch.** Let a fresh, recently-observed `shortPercent >= 100` reading exclude an account even without a future `shortResetAt`, gated on snapshot freshness rather than on reset presence. This preserves the `:395-407` intent (do not exclude on a stale reading) while closing the missing-timestamp hole. Additionally, clear or re-evaluate sticky affinity after a bounded run of consecutive failures on one account, so a 502 storm cannot pin the pool. Keep post-200 streamAborted terminal as today.

**Blockers and risks.** This is account-pool and quota logic, adjacent to the security boundary. The opposite-direction regression (#3029 pointed the other way) is real: over-eager exclusion strands a recovered account. Freshness-gating is what keeps both directions safe; any patch must carry tests for both.

**Dependencies.** Touches `src/codex/routing.ts` and `src/codex/quota.ts`. Independent of #3502 and #3529 — no file overlap — so it can proceed in parallel.

## #3424 — opencode-go muse-spark-1.3-contributor unusable

**Disposition: SUPERSEDED (already fixed on dev; needs reporter re-verify)**

No PR needed. Reporter mszero, on version 2.40, Claude Code surface, HTTP 500 from upstream.

**Evidence it is already fixed.** The reporter's log shows the request routed with adapter `openai-chat`, the provider-wide default, and got a provider 500. On current dev, `muse-spark-1.3-contributor` is declared `openai-responses` in `modelWireDefaults` for the `opencode-go` row (`src/providers/registry.ts:1627`). The decision-log comment immediately above (`:1616-1624`) states the exact problem: the provider is mixed-wire, but its provider-wide `openai-chat` adapter was sending these models to `/chat/completions`; the fix routes the named models to `/responses`.

**Version boundary confirmed by git.** The declaration landed in `878f75417` (feat(models): add Muse Spark 1.3 on the 1.2 spec, #3317, 2026-09-03). `git merge-base --is-ancestor` confirms it **is** in v2.41.0 and **is not** in v2.40.0. The reporter ran 2.40, precisely the last release without the fix. That also explains their observation that the model works in other software (which sends it to /responses) but not through OpenCodex.

**Caveat, stated plainly.** The upstream error was a 500, not a 400, so a wrong-endpoint diagnosis is strong but not airtight — a gateway-side outage could produce the same code. The issue also carries `needs-info` and the report is thin (no config, minimal repro). Recommend replying with the version boundary and asking for re-verification on 2.41.0 or later before closing. Do not close silently.

## #3406 — Codex disable dialog and state are misleading

**Disposition: SUPERSEDED_BY_PR #3407 — but the PR is not landable as-is**

PR facts (head `38d45300a644dd0aa641a0a9b76f293169ab8ef9`, base `dev`, author turin-dev — the same person who filed the issue): isDraft **true**, mergeable **CONFLICTING**, mergeStateStatus DIRTY, reviewDecision REVIEW_REQUIRED. CI on that head is **RED**: ci, gates, macos, test 1/4, and test 2/4 all fail. The four review-readiness boxes are unticked, so the gate correctly holds it in draft.

**Defect is real and proven on dev.** The issue describes three concrete faults: the Codex toggle reuses the Grok Build consequence copy, the status API reports the OpenCodex config path instead of the effective `$CODEX_HOME/config.toml`, and the card retains pre-toggle state until reload. The PR's file list corroborates where these live — `gui/src/pages/integrations/IntegrationsOverview.tsx`, `gui/src/pages/integrations/overview-clients.ts`, and `src/server/management/native-integration-routes.ts` (+4/-1, the config-path field).

**Test evidence.** The PR carries `gui/tests/integrations-overview-rows.test.ts` (+61), `gui/tests/integrations-surfaces.test.tsx` (+74), and `tests/native-codex-toggle.test.ts` (+16), the last asserting the effective Codex config path, which would be RED on dev.

**Blockers.**

1. **RED CI on the exact head** across 5 checks, including two test shards. Whatever the author's local run showed, the repository's own gate disagrees. This alone blocks landing.
2. **CONFLICTING** against dev. The diff spans 9 i18n locale files plus GUI components; i18n files are high-churn, so expect real conflicts. Mostly mechanical, but the `overview-clients.ts` changes (+54/-13, desired-vs-observed state separation) are **semantic** and need re-reasoning after rebase.
3. **Screenshot hosted off-repo.** The PR embeds the required GUI screenshot from a fork-owned raw.githubusercontent.com URL. It satisfies enforce-target today but will rot if the fork disappears. The PR also adds `docs/pr-assets/3407-codex-disable-dialog.png` to the repo; confirm that binary belongs in the tree.
4. **Draft checklist unticked** — the author has not attested readiness.

**Fix list (LAND_WITH_FIX / REIMPLEMENT).** (1) Rebase onto current dev, resolving the 9 i18n files and re-reasoning `overview-clients.ts`. (2) Get CI green on the exact rebased head — diagnose the 5 failing checks first, since they may be pre-existing on that stale base rather than caused by the change. (3) Decide the docs/pr-assets binary question. (4) Have the author tick the readiness checklist, or carry the work with a `Co-authored-by: turin-dev` trailer per AGENTS.md if a maintainer reimplements it.

**Dependencies.** GUI integrations surface — stack after any other campaign PR touching `gui/src/pages/integrations/` or the i18n locale files.

## #3352 — Plus account entitled to GPT-5.6 gets 401 through the proxy

**Disposition: DEFER** (re-verified independently against dev; prior research reached the same call)

No open PR. Reported on 2.40.0 by ZhenyuXiao, with a clean A/B matrix (native succeeds, proxied 401s).

**Re-verification against current dev.** The 401 originates at `src/codex/auth-context.ts:413` and `:444`, a CodexPoolAuthenticationError carrying the selected-account-does-not-support-this-model text. The entitlement projection is a three-state machine, granted / denied / unknown (`src/codex/model-entitlements.ts:370`). Every failure path — timeout, unparseable body, parsed-but-empty rows — routes to `unconfirmedAccountModels()` (`:552`, called at `:592`, `:603`, `:607`, `:618`, `:644`) on a short failure TTL, and the comment at `:965` states the policy explicitly: fail closed for unconfirmed accounts. The comment at `:206` adds that admitting these would turn an honest unknown into a cached denied.

So the reported behavior is the designed behavior. The account is genuinely entitled, the roster fetch is not confirming it, and the fail-closed rule converts non-confirmation into a 401.

**Why this is not a safe IMPLEMENT.** The obvious fix — let unknown through — is a security-policy change, not a bug fix: it would admit requests for accounts whose entitlement the proxy could not verify. That needs a maintainer decision, and per AGENTS.md this is auth-boundary code requiring explicit security review.

**What would unblock it.** The real question is why the roster fetch returns nothing for this account. A corroborating signal sits in the reporter's own data: `/api/codex-auth/accounts` returns `plan: null` for a Plus account. If the roster call is failing or returning empty for a class of accounts, that is a fixable defect with a different shape than loosening the gate. Needs the redacted roster-fetch outcome — which of the five unconfirmed branches fired — from an affected account on a current build.

**Concrete defer reason:** needs reporter evidence (which unconfirmed branch fires) plus a product and security decision on fail-closed semantics.

## #3320 — Windows misclassifies a valid scheduler task for non-ASCII account names

**Disposition: DEFER** (re-verified independently)

No open PR. Reported on 2.40.0 by chowyuan1314; already carries `needs-info`.

**Re-verification against current dev.** The report contains two separable claims.

*Claim A — schtasks /create Access is denied from a non-elevated shell.* This is expected Windows behavior for task registration, not a non-ASCII defect. The reporter confirms elevated registration succeeded.

*Claim B — a valid task is still reported expired or missing reboot protection.* The non-ASCII hypothesis is that the UserId comparison breaks on the account name. Current dev writes a locale-independent SID, not a name: `sessionTriggerUserId = cachedCurrentWindowsIdentity()?.sid` (`src/service.ts:1845`), and the resolver returns `identity.sid` (`:1920`), with the name available but separate (`:1909`). A SID contains no non-ASCII characters, so the stated mechanism does not hold against production-registered XML.

Exact matching is also a deliberate identity boundary. The comment above `windowsTaskTriggerScopeAcceptable()` (`src/service.ts:2110-2125`) states that treating an unknown expected identity as a wildcard would let a fresh status process accept a task bound to another user's session and suppress the repair that should replace it; a prefixed UserId tag is rejected outright rather than guessed. Folding two non-ASCII identities together would be exactly the adoption bug that code prevents.

**Residual possibility worth naming.** The report may still be real via a path other than the one proposed: a task registered by an older, name-based version, or schtasks output decoding — the reporter explicitly raises decoding, and console-codepage mangling of schtasks stdout on a non-ASCII system is plausible and would not be fixed by SID-based writes.

**Concrete defer reason:** needs the redacted live task XML (UserId element only) plus the raw `schtasks /query /xml` bytes from the affected machine. Without knowing whether the installed task is SID-scoped or legacy name-scoped, any patch is a guess at an identity boundary.

**Dependencies.** `src/service.ts` overlaps #3464. Stack, do not parallelize.

## #3245 — macOS Codex 0.152.0 streams disconnect through ocx 2.39.0

**Disposition: DEFER** (re-verified independently)

No open PR. Already carries `upstream-tracking` and `needs-info`.

**Re-verification against current dev.** The 426 the reporter sees first is intentional and correct: a 426 upgrade_required response stating the Responses WebSocket transport is disabled and HTTP should be used (`src/server/index.ts:1144`), with the comment at `:1140` explaining that codex-rs maps a connect-time UPGRADE_REQUIRED to a clean HTTP fallback. That is #324's documented behavior, and the reporter correctly identifies it as expected.

The reporter's own controls are what make this a defer rather than an implement. They proved: a direct local `POST /v1/responses` with streaming completed with response.completed and [DONE]; a direct `POST /v1/chat/completions` completed; all three providers connected; the upstream HTTP proxy is reachable. So the Responses bridge and SSE delivery both work under direct load. The failure is specific to the full request shape Codex CLI emits, and per the prior lane's reading no subsequent POST was observed after the 426, which places the break before the Responses bridge rather than inside it.

**What would unblock it.** A debug classification of whether the close occurs before or after upstream response.created — which the reporter proposes themselves and is the right ask. Concretely: a captured request-log entry for the failing `codex exec` on a current build (2.43.0 or later), showing whether the POST reached the proxy at all. Version drift matters here: the report is against 2.39.0 with Codex CLI 0.152.0, both several releases stale.

**Concrete defer reason:** needs reporter evidence (post-426 POST trace on a current build). The configuration is also unusual — an upstream HTTP proxy at 127.0.0.1:1082 plus native Codex integration — and no maintainer reproduction exists.

---

## Cross-item dependency map

| File / surface | Items | Stack order |
|---|---|---|
| `src/service.ts` | #3464 (implement), #3320 (deferred) | #3464 first; revisit #3320 only with new evidence |
| `src/lib/destination-policy.ts` | #3462 via PR #3489 | Security-boundary review required |
| `src/responses/state.ts` | #3522 via PR #3525 | Land before other response-state work |
| `src/codex/routing.ts`, `src/codex/quota.ts` | #3425 (implement) | Independent of #3502/#3529 |
| `src/adapters/google-*.ts`, `src/lib/errors.ts` | #3467 via PR #3469 | Rebase first |
| `gui/src/pages/integrations/`, i18n locales | #3406 via PR #3407 | Blocked on green CI plus rebase |

## Method note

Issue and PR metadata read via `gh` on 2026-09-05 against `lidge-jun/opencodex`. CI states are from `gh pr checks` on the exact head SHAs recorded above and will drift as branches move; re-read immediately before any merge decision. All file:line citations were read in the pinned worktree at `0f27bbeb3`. No files under `src/`, `tests/`, or `gui/` were modified, and no repository-wide suite was executed.
