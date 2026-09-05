> **Amended by 008 (audit round 1):** #3489 merges clean under `git merge-tree` (no rebase); only #3469 keeps the test-rename recipe. Co-authored-by trailers use the ID-prefixed noreply form resolved via `gh api users/<login>`.

# 020 — wp2 / Stack B: bug PRs needing carry or reimplementation

Unit: `devlog/_plan/260905_open_work_closeout`. Work-phase: **wp2**.
Sources: `001_lane_bug_prs_a.md` (#3502, #3519, #3524) and `002_lane_bug_prs_b.md`
(#3489, #3469, #3407, #3348, #3388), both read in full.

Planning worktree: `/private/tmp/ocx-closeout.xomWAA/wt` (detached at `0f27bbeb3`).
`git fetch origin dev` at plan time: `origin/dev` = **`6580694c7`**
("test(oauth): restore a deleted contract test, and fail when one disappears (#3530)").

> **Second fetch, immediately before finalizing: `origin/dev` moved again to `79e03643d`.**
> Two commits, and unlike the first drift **both affect this doc**. The corrections are
> folded in below and marked "(drift-corrected)". Re-fetch before you branch; if
> `origin/dev` has moved past `79e03643d`, re-run the two drift commands in this section
> before trusting any line number or test path here.
>
> 1. `79e03643d` "test(layout): move server, storage, ci-workflows into tests/<domain>/
>    (#3497) (#3518)" — `server` and `storage` are **now migrated domains** with real
>    directories. Every "stays at `tests/` root" instruction below is inverted: those files
>    now live in `tests/server/` and `tests/storage/` at depth 1.
> 2. `bdafc5191` "test(oauth): prove the unobservable quorum staleness window is harmless
>    (#3533)" — adds 13 lines to `src/oauth/anthropic-routing.ts`, shifting B1's target line
>    from `:662` to **`:675`**. The line's text is unchanged, so the conflict stays
>    mechanical; the anchor moved, not the content.

**Drift check against the lane snapshot (`0f27bbeb3`).** One commit, and it touches
nothing this work-phase owns:

```
git log --oneline 0f27bbeb3..origin/dev
  6580694c7 test(oauth): restore a deleted contract test, and fail when one disappears (#3530)
git log --oneline 0f27bbeb3..origin/dev -- src/oauth src/cli/claude.ts src/lib/errors.ts \
  src/lib/provider-outbound.ts src/server/responses/core.ts src/combos \
  src/server/management/native-integration-routes.ts src/codex/catalog/provider-fetch.ts \
  src/adapters/google-errors.ts gui/src/pages/integrations
  (empty)
```

Every `src/` line cited below was re-read on the tree at plan time, so all line numbers are
current. **Branch from `origin/dev` = `6580694c7`, not the lane snapshot.**

## Corrections to the lane docs (verified at plan time)

Three lane claims are wrong or stale, and an implementer following them literally would
produce a broken branch. Each was re-verified against the tree:

1. **001 says three of #3502's four test files "do not exist on dev".** They exist, in
   their migrated domains: `tests/oauth/adapter-event-oauth-failover.test.ts`,
   `tests/oauth/generic-oauth-failover.test.ts`, `tests/routing/always-on-429-failover.test.ts`
   (`ls` exit 0 on all three). The conflict is the `tests/<domain>/` migration described in
   002, not a deletion. The test half is replayable at the new paths.
2. **002's rebase recipe ("apply the hunk to the file's new path") is necessary but not
   sufficient for NEW test files.** `tests/test-layout.test.ts` and
   `tests/test-layout-tooling.test.ts` require every new basename to *resolve* to a domain
   through `scripts/test-layout/layout.json`, and `tests/test-layout-tooling.test.ts:250`
   asserts `layout.explicit` equals `tests/fixtures/test-layout-expected.json` byte for byte.
   A new file whose name matches no regex seed fails `unresolvedNew` even if placed correctly.
   Verified with the repo's own resolver — every new basename prescribed below resolves:

   | New basename | `resolveTarget` | Directory |
   |---|---|---|
   | `command-code-fakeip-discovery.test.ts` | `providers` | `tests/providers/` |
   | `server-startup-reconcile-resilience.test.ts` | `server` | `tests/server/` (drift-corrected) |
   | `router-combo-failover-classification.test.ts` | `routing` | `tests/routing/` |
   | `policy-fallback-exhaustion.test.ts` | `routing` | `tests/routing/` |
   | `storage-cooldown-disk.test.ts` | `storage` | `tests/storage/` (drift-corrected) |

   **(drift-corrected at `79e03643d`.)** At the lane snapshot `server` and `storage` were
   unmigrated, so files resolving to them stayed at `tests/` root. `79e03643d` migrated
   `server`, `storage`, and `ci-workflows`, so `layout.migrated` on `79e03643d` is:
   adapters, ci-workflows, claude-integration, cli, clients, codex-integration, config, gui,
   lab, lib, oauth, providers, responses, routing, **server**, service, **storage**, update,
   usage, vision, web-search, windows. Both directories now exist, so these files go **in
   them**, at depth 1 (`../src/` → `../../src/`). The rule itself is unchanged — a file
   resolving to a *migrated* domain may not sit at root (the guard's `stragglers` branch), and
   a file resolving to an unmigrated one may not sit in a directory (`misplaced`). Only the
   membership moved. Re-read `layout.migrated` at branch time rather than trusting this list.
3. **002's #3348 subset lists `AttemptRecoveryKind` and `COOLDOWN_RECOVERY_KINDS` as one
   item.** They live in two different modules — the type at `src/usage/log.ts:45` with its
   runtime set at `src/usage/log.ts:256`, and the analytics set at
   `src/routing/analytics.ts:117`. Adding `key-401` is a four-site chain (§4), not one edit.

## 1. Loop-spec header

**Archetype:** spec-satisfaction repair. Each layer restores behavior the repository already
documents or already implements elsewhere; none of it invents product surface. The two
exceptions are called out where they occur (#3519 is a deliberate UX change; #3489 widens a
security exception).

**Trigger:** wp1 (Stack A, doc `010`) has merged into `dev`, or has been confirmed to touch
none of this phase's files. The only cross-phase file overlap is
`src/server/responses/core.ts`: wp1 lands #3515 near line 4925, this phase lands #3502's Kiro
fix near lines 3380/6693. ~1,500 and ~3,300 lines apart, so the overlap is ordering hygiene,
not a conflict.

**Goal:** land the six carryable bug fixes in this family on `dev` as a reviewable stack plus
two independent merges, with the two contributor reimplementations reduced to the bounded,
defensible subsets the lane research identified, and every carried piece credited.

**Non-goals:**

- No `main`/`preview` promotion, no release, no version bump.
- No repository-wide suite. `bun run test` and bare `bun test` with no file argument are
  forbidden here; `bun run test:changed` and named files only.
- Not landing #3388 (deferred, §6), #3348's disk persistence beyond PR B, #3348's
  policy-fallback semantics beyond PR C, or #3407's tracked PNG.
- No `git reset --hard`, no force-push to a shared branch, no rewriting a contributor's
  branch in place. Carried work goes on **new** `codex/260905-*` branches.

**Verifier commands.** Every one of these was run at plan time in the worktree at
`0f27bbeb3`; the file exists and the command reads the change target. Exit codes are the
**baseline on unmodified dev**, which is what makes the RED/GREEN claims per item falsifiable.

| # | Command | Baseline on dev | Reads |
|---|---|---|---|
| V1 | `bun test tests/server/error-fidelity.test.ts` | 7 pass / 0 fail, exit 0 | `classifyError` (#3469) |
| V2 | `bun test tests/adapters/google/google-errors.test.ts` | 10 pass / 0 fail, exit 0 | google classifier (#3469) |
| V3 | `bun test tests/adapters/google/google-vertex-http.test.ts` | 24 pass / 0 fail, exit 0 | vertex retry fetch (#3469) |
| V4 | `bun test tests/providers/provider-model-discovery-contract.test.ts` | 36 pass / 0 fail, exit 0 | discovery contract (#3489) |
| V5 | `bun test tests/claude-integration/claude-cli.test.ts` | 34 pass / 0 fail, exit 0 | `src/cli/claude.ts` (#3519) |
| V6 | `bun test tests/oauth/oauth-provider-reconcile.test.ts` | 9 pass / 0 fail, exit 0 | `reconcileOAuthProviders` (#3524) |
| V7 | `bun test tests/routing/always-on-429-failover.test.ts` | 8 pass / 0 fail, exit 0 | 429 failover (#3502) |
| V8 | `bun test tests/codex-integration/native-codex-toggle.test.ts` | 6 pass / 0 fail, exit 0 | codex toggle route (#3407) |
| V9 | `bun run typecheck` | exit 0 | whole tree |
| V10 | `bun run test:changed` | resolves against merge-base | import graph of the touched set |

Note V1 **(drift-corrected)**: V1 was executed at `tests/error-fidelity.test.ts`, which is
where the file sat at the lane snapshot. `79e03643d` moved it to
`tests/server/error-fidelity.test.ts`; the 7-pass baseline is unaffected by the move. Same for
V-adjacent combo files: `tests/server-combo-failover-e2e.test.ts` is now
`tests/server/server-combo-failover-e2e.test.ts`.

**Two verifiers are environment-red and must not be used as gates.** Re-run at plan time on
**unmodified** dev:

- `bun test tests/server/server-combo-failover-e2e.test.ts` → 36 pass / **45 fail**
  (path drift-corrected; executed at its pre-move root path)
- `bun test tests/routing/combo-management-api.test.ts` → 27 pass / **3 fail**

Every failure is `error: Failed to start server. Is port 0 in use? code: "EADDRINUSE"` from
`Bun.serve({ port: 0 })` — a sandbox restriction, not a regression. Treat both as
**hosted-CI-only** verifiers for B6. Do not "fix" these failures.

**Stop condition.** Stop when every branch below is either merged into `dev` (proven by
`git fetch origin dev && git merge-base --is-ancestor <squash-sha> FETCH_HEAD`) or explicitly
recorded as deferred in `060` with a reason. A layer whose exact-head CI is not green does not
merge; it stops the stack above it and is reported, not forced.

**Memory artifact.** This doc plus the merge ledger in `060`. Each landing appends: PR number,
branch, squash SHA, ancestry proof output, and the exact-head CI conclusion.

**Expected terminal outcomes.**

- Merged: #3489, #3469 (independent of the stack), #3502 (split into B1 + B2), #3519 (B3),
  #3524-reimplementation (B4), #3407-reimplementation (B5), #3348 PR A (B6).
- Closed with a pointer to the replacement: #3524, #3407, #3348 (superseded by
  reimplementations, each carrying `Co-authored-by`).
- Deferred: #3388 (§6).

**Escalation — stop the phase and report rather than improvising:**

1. `hygiene` reports `unsponsored_surface` on a branch you authored and you lack the
   `maintainer-sponsored` label (B1, B4 — see §5).
2. A test the lane calls RED-on-dev passes on dev. That invalidates the defect claim; report
   it instead of adjusting the test.
3. A rebase conflict is **semantic** where this doc says mechanical.
4. #3519's `Ingwannu` `CHANGES_REQUESTED` cannot be cleared — a reimplementation does not
   dismiss another PR's review state.
5. Exact-head CI fails for a reason not explained here.

## 2. Stack map (DEV-STACK-01..03)

Two independent merges first, then one six-layer stack. The split is driven by shared files,
not by convenience.

**Merged directly (not restacked).** #3489 and #3469 are `APPROVED` with fully green
exact-head CI, and their only conflict is the `tests/<domain>/` migration. They share no file
with the stack: #3489 touches `src/lib/provider-outbound.ts`, `src/providers/model-discovery.ts`,
`src/codex/catalog/provider-fetch.ts`, `src/server/management/provider-routes.ts`; #3469 touches
`src/lib/errors.ts`, `src/adapters/google-errors.ts`, `src/adapters/google-http.ts`. Neither
file appears in any stack layer.

*Caveat that changes the plan:* both are `CONFLICTING/DIRTY` at plan time (re-read immediately
before writing this doc), and a conflicting PR cannot be squash-merged. Since these are
contributor branches you cannot push to, each becomes a maintainer carry branch (§3.1, §3.2)
that closes the original with credit. The "direct merge" path applies only if the author
rebases first. Both routes are specified.

Pre-merge checks, in order, for either route:

1. `gh pr view <n> --json headRefOid,mergeable,mergeStateStatus,reviewDecision,isDraft` — head
   must be MERGEABLE and not draft.
2. Dismiss any review that is stale against the current head:
   `gh api -X PUT repos/lidge-jun/opencodex/pulls/<n>/reviews/<review_id>/dismissals -f message=...`.
   Neither #3489 nor #3469 needs this (both APPROVED against the reviewed head); it applies to
   #3519 in B3.
3. Mark ready if draft: `gh pr ready <n>`.
4. Exact-head CI: `gh pr checks <n>` and confirm every row's SHA equals `headRefOid`. A row
   from an older SHA is not evidence.
5. Admin squash: `gh pr merge <n> --squash --admin --body-file <file>`, body carrying the
   `Co-authored-by` trailer when the head is not the contributor's own commit.

**Stack (bottom targets `dev`; each upper targets the branch below).**

| Layer | Branch | Targets | Proves alone |
|---|---|---|---|
| B1 | `codex/260905-oauth-failover-policy-boundaries` | `dev` | Disabled pools stop reactivating proactive strategy; per-provider `true` beats global `false` |
| B2 | `codex/260905-kiro-continuation-auth-context` | B1 | A rotated Kiro bearer carries its own region/profile into the terminal continuation |
| B3 | `codex/260905-claude-native-fallback` | B2 | `ocx claude` launches native Claude when routing is explicitly off, without leaking a loopback credential |
| B4 | `codex/260905-startup-reconcile-persistence` | B3 | Startup reconciliation rebases on the persisted config and **cannot** kill boot |
| B5 | `codex/260905-codex-toggle-truthful` | B4 | The Codex dashboard row shows Codex's own config path and the user's setting |
| B6 | `codex/260905-combo-failure-classification` | B5 | Cooldown scope and hop/stop verdicts match the failure's actual blast radius |

**Why this order.**

- **B1 → B2** is a hard dependency: both come from #3502 and B2 edits
  `src/server/responses/core.ts`. B1 carries the OAuth policy halves
  (`src/oauth/anthropic-routing.ts`, `src/oauth/generic-account-failover.ts`, `src/types/*`,
  docs); B2 carries the Kiro `applyFailoverSnapshot` change alone. Splitting isolates the
  `src/oauth/` security surface (§5) from a `core.ts` change that needs no sponsorship —
  exactly the lane's fix-list item 5.
- **B2 → B3** is ordering only, no shared file. B3 sits above B2 so the `core.ts` region
  settles before a large `src/cli/claude.ts` diff enters review.
- **B3 → B4**: no shared file, but B4 changes startup (`src/oauth/index.ts`,
  `src/providers/model-rename-startup.ts`, called from `src/server/index.ts`) and B3's
  `ensureProxyForClaude` path spawns the proxy. Reviewing a startup-failure-mode change under
  a launcher change that depends on startup succeeding is the wrong order.
- **B4 → B5**: no shared file. B5 is GUI + management routes. Placed above B4 because #3407's
  reimplementation must rebase after **#3484** lands (wp1/Stack A, shared
  `gui/src/pages/integrations/IntegrationsOverview.tsx`, per 002). If #3484 has not merged when
  you reach B5, stop and report — do not reimplement on top of an unlanded #3484.
- **B5 → B6**: no shared file. B6 is last because it is the largest carry and the only one
  whose local verifiers are environment-blocked; a failure there should not hold five clean
  layers behind it.

**Carried contributor work.** Every branch below is created **from `origin/dev`** with the
contributor's hunks cherry-picked or reapplied by hand (their heads are too far behind to
branch from). Each needs a `Co-authored-by` trailer in a branch commit so it survives the
squash. Emails read at plan time via `gh pr view <n> --json commits`:

| Layer | Source PR | Trailer |
|---|---|---|
| B1, B2 | #3502 | `Co-authored-by: Ingwannu <ingwannu@users.noreply.github.com>` |
| B3 | #3519 | `Co-authored-by: everton-dgn <evertondgn@hotmail.com>` |
| B4 | #3524 | `Co-authored-by: yansigit <44089734+yansigit@users.noreply.github.com>` |
| B5 | #3407 | `Co-authored-by: turin-dev <koomj5258@gmail.com>` |
| B6 | #3348 | `Co-authored-by: RHODIZSECURITY <info.rhodiz@gmail.com>` |
| carry-3489 | #3489 | `Co-authored-by: Flowershangfromthebranches <flowershangfromthebranches@users.noreply.github.com>` — see note |
| carry-3469 | #3469 | `Co-authored-by: agentHits <zvercombat26rus@icloud.com>` |

**#3489's commit email is unusable.** `gh pr view 3489 --json commits` returns an empty login
and `<opencodex-fix@local>` — a local placeholder, not a GitHub-linked address, so it credits
nobody. Use the `@users.noreply.github.com` form above, which resolves by login. If the carry
route is taken, ask the author for their preferred address on the PR before merging; do not
guess a personal email.

## 3. Per item

### 3.1 #3489 — fake-IP TUN discovery exception (LAND_WITH_FIX)

Head `dbcfde8ca`, APPROVED by Ingwannu after explicit security review, 24 green checks on the
exact head, `CONFLICTING/DIRTY`.

**File change map.** Take the PR's `src/` half unchanged — it applies cleanly and no dev
commit touched these files since. Concretely, `src/lib/provider-outbound.ts:157` is currently:

```ts
      allowBenchmarkAddresses: proxyConfigured && !noProxyMatches(parsed),
```

and becomes:

```ts
      allowBenchmarkAddresses: (proxyConfigured && !noProxyMatches(parsed))
        || transparentFakeIpException(url, parsed, isCanonicalUrl, name),
```

with `isCanonicalUrl?: (name: string, url: string) => boolean` added to
`ProviderOutboundDependencies` (defaulted at the `providerOutboundRequest` destructure as
`dependencies.isCanonicalUrl ?? (() => false)` — fail-closed), `transparentFakeIpException`
added above `normalizeProxyHostname`, and `isRegistryModelDiscoveryUrl` added in
`src/providers/model-discovery.ts` then wired at the call sites in
`src/codex/catalog/provider-fetch.ts` (~1669) and `src/server/management/provider-routes.ts`
(~1237).

**Conflict resolution recipe — mechanical, two items only.**

1. `src/codex/catalog/provider-fetch.ts`: dev's `8b6e4542a` rewrote a **comment** at line 720
   (a test path). The PR's hunk is at ~1669. Take dev's side of the comment; the PR hunk
   applies untouched.
2. Tests: `tests/provider-model-discovery-contract.test.ts` is now
   `tests/providers/provider-model-discovery-contract.test.ts`. The new
   `command-code-fakeip-discovery.test.ts` must be **created at `tests/providers/`**
   (resolver: `providers`, which is migrated). In both files rewrite `../src/` →
   `../../src/`. `../helpers/` specifiers stay as-is: `helpers` is anchored to `tests/` and
   `rewriteSpecifier` leaves it unchanged at depth 1 (`tests/test-layout-tooling.test.ts:58`).

**Regression tests.**

- `tests/providers/command-code-fakeip-discovery.test.ts` (new, ~304 lines). RED on dev because
  `isRegistryModelDiscoveryUrl` does not exist there — `rg -n "isRegistryModelDiscoveryUrl" src`
  returns nothing, so the import fails outright. GREEN after: the symbol exists and the
  transport consults it.
- `tests/providers/provider-model-discovery-contract.test.ts` (+60). RED on the new assertions
  for the same reason; the existing 36 stay green.

**Focused verifier:** V4 (dev baseline 36 pass / exit 0) plus
`bun test tests/providers/command-code-fakeip-discovery.test.ts`, then V9.

**Accept criteria, with activation scenario per conditional path (C-ACTIVATION-GROUNDING-01).**
The exception is a new security-relevant branch, so every path needs a named scenario:

| Path | Activation scenario | Expected |
|---|---|---|
| `isCanonicalUrl` default `() => false` | Any caller that does not inject the seam | Exception never granted (fail-closed) |
| `noProxyMatches(parsed)` true | `NO_PROXY=api.example.com`, TUN active | Exception refused, benchmark answer rejected |
| Canonical URL, no proxy env, all answers 198.18.x.x | Clash TUN, discovery to the registry's fixed URL | Exception granted, fetch proceeds |
| Canonical origin+path, extra/missing query | `?token=…` appended | Rejected (`candidate.search === expected.search` exact) |
| `http:`, or embedded `username`/`password`, or `hash` | Retargeted custom row | Rejected outright |
| Literal `198.18.x.x` URL | `baseUrl` set to the fake IP | Rejected by the literal gate before DNS answers are read |
| Renamed custom row pointing at attacker host | OAuth/forward name matches any `baseUrl` | Rejected — proof is on the URL, not the name |
| Mixed public + benchmark answers | DNS rebind attempt | Rejected — exception requires every answer benchmark |
| `privateNetwork` destination | Image/Lab fetch | Unchanged; those paths never pass the flag |

**Docs-site sync:** none. The PR ships no user-facing config surface; the exception is
internal transport policy.

**PR skeleton (carry route).** Title:
`fix(discovery): allow canonical model endpoints through fake-IP TUN DNS`

```
## Summary
Carries #3489 onto current dev. Model discovery to a registry's own fixed discovery URL is
rejected under Clash/Surge/Mihomo TUN mode, because the fake-IP (198.18.0.0/15) DNS answer is
only tolerated when an outbound proxy env is configured (src/lib/provider-outbound.ts:157).
TUN intercepts the fake-IP destination itself, so the request would succeed.

The exception is proven on the FINAL request URL, injected as a dependency defaulting to
"not canonical" so a caller that forgets the seam fails closed.

## Verification
- bun test tests/providers/command-code-fakeip-discovery.test.ts
- bun test tests/providers/provider-model-discovery-contract.test.ts
- bun run typecheck

## Checklist
(all four boxes)

Stack: independent of the wp2 stack; shares no file with B1-B6.

Co-authored-by: Flowershangfromthebranches <flowershangfromthebranches@users.noreply.github.com>
```

No `Closes #` line — this carries #3489; close #3489 manually with a pointer once the carry
lands on `dev` (GitHub auto-close only fires on `main`).

### 3.2 #3469 — classify "User location is not supported" (LAND_WITH_FIX)

Head `e11089af8`, APPROVED, 25 green checks on the exact head, `CONFLICTING/DIRTY`.

**File change map.**

`src/lib/errors.ts` — add after `isPermissionMessage` (currently ends at line 128):

```ts
export const LOCATION_UNSUPPORTED_PATTERNS = [
  "location is not supported", "location not supported", "unsupported location",
  "region is not supported", "unsupported region", "country is not supported",
  "not supported in your country", "not supported in your region",
] as const;

export function isLocationUnsupportedMessage(text: string): boolean {
  const lower = text.toLowerCase();
  return LOCATION_UNSUPPORTED_PATTERNS.some(needle => lower.includes(needle));
}
```

The PR's own second commit **removed** `"not supported for the api use"` from this list. Keep
it removed: it is the broad pattern CodeRabbit worried about, and the PR's negative test
asserts `isLocationUnsupportedMessage("not supported for the api use") === false`.

In `classifyError`, insert **before** the generic invalid-request branch that currently begins
at `src/lib/errors.ts:271` (`text.includes("validationexception") || text.includes("invalid request") || …`)
and after the `subscription_required` branch:

```ts
  if (type === "location_not_supported" || isLocationUnsupportedMessage(text)) {
    return { message, type: "permission_error", code: "location_not_supported" };
  }
```

Placement is load-bearing: dev's stop-list at :271 matches `"invalid request"` first, which is
exactly why a geo-block is reported as a malformed request today.

`src/adapters/google-errors.ts` — replace the local copies with re-exports so adapter and lib
cannot drift:

```ts
export const GOOGLE_LOCATION_UNSUPPORTED_PATTERNS = LOCATION_UNSUPPORTED_PATTERNS;
export const isGoogleLocationUnsupportedText = isLocationUnsupportedMessage;
```

`src/adapters/google-http.ts` — in `normalizeFinalGoogleError`, wrap `formatMessage` to
`console.warn` a static TUN/IPv6-leak hint when `isGoogleLocationUnsupportedText(payloadText)`.
Static string only — no payload, key, or account id, so `privacy:scan` is unaffected.

**Conflict resolution recipe — mechanical, tests only.** No `src/` file overlaps dev.

- `tests/google-errors.test.ts` → `tests/adapters/google/google-errors.test.ts`
- `tests/google-vertex-http.test.ts` → `tests/adapters/google/google-vertex-http.test.ts`
- `tests/error-fidelity.test.ts` → `tests/server/error-fidelity.test.ts` **(drift-corrected:
  `server` was migrated by `79e03643d`; it no longer stays at root)**

For the two Google files rewrite `../src/` → `../../../src/` (depth 2). For
`tests/server/error-fidelity.test.ts` rewrite `../src/` → `../../src/` (depth 1) — the file
already carries the rewritten specifiers on `79e03643d`, so only the PR's added hunk needs care.

**Regression tests.** Three, all RED on dev:

- `tests/server/error-fidelity.test.ts` — asserts `code: "location_not_supported"`. Dev returns
  `invalid_request_error`; the lane executed it directly:
  `classifyError(400, "upstream_error", "User location is not supported for the API use.")`
  → `{ type: "invalid_request_error", code: "invalid_request_error" }`. GREEN once the new
  branch precedes the stop-list.
- `tests/adapters/google/google-errors.test.ts` — imports `isGoogleLocationUnsupportedText`;
  compiles only after the re-export exists.
- `tests/adapters/google/google-vertex-http.test.ts` — positive and negative warning
  assertions; the warning does not exist on dev.

**Focused verifier:** V1, V2, V3 (dev baselines 7 / 10 / 24 pass, exit 0) then V9.

**Accept criteria + activation scenarios.**

| Path | Scenario | Expected |
|---|---|---|
| `type === "location_not_supported"` | Adapter already classified it | `permission_error` / `location_not_supported` |
| Message match, status 400 | Vertex "User location is not supported for the API use." | `permission_error`, not `invalid_request_error` |
| Negative: `"not supported for the api use"` alone | Model-capability rejection with no geo cue | Falls through to the generic branch |
| Warning path | Geo rejection through `normalizeFinalGoogleError` | One `console.warn`, static text |
| Warning negative | Any other Google error | No warning |
| Shard coverage | Lane noted only shards 1/4 and 2/4 ran | Confirm all four shards on the rebased head |

**Docs-site sync:** none required (error-classification internals).

**PR skeleton.** Title: `fix(google): classify "User location is not supported" as a location error`.
Same three-section body shape as §3.1; Verification lists V1-V3 + V9; trailer
`Co-authored-by: agentHits <zvercombat26rus@icloud.com>`; no `Closes #`, close #3469 manually.

### 3.3 B1 — #3502 OAuth failover policy boundaries (LAND_WITH_FIX, split 1 of 2)

Head `6671a1623`, `CONFLICTING/DIRTY`, CI green but on stale base `2fb11f4a0`.
**Security surface: `src/oauth/` — see §5.**

**File change map.**

`src/oauth/anthropic-routing.ts:675` **(drift-corrected: `:662` at the lane snapshot;
`bdafc5191` added 13 lines above it — the line text is unchanged)** — current:

```ts
  const next = pickAlternateAnthropicAccount(config, failedAccountId, now);
```

target:

```ts
  // The pool's strategy is a PROACTIVE policy. When the pool is disabled, reactive
  // presence-only recovery must not silently reactivate round-robin/fill-first merely
  // because those dormant values remain in config. The quota picker is the neutral
  // recovery policy already used by the default strategy.
  const next = isAnthropicAccountPoolEnabled(config)
    ? pickAlternateAnthropicAccount(config, failedAccountId, now)
    : pickLowestUsage(config, failedAccountId, now);
```

Both helpers already exist in this file (`isAnthropicAccountPoolEnabled` at :83,
`pickLowestUsage` at :334 as of `0f27bbeb3`; both shift down by `bdafc5191`'s 13 lines on
`79e03643d`) — no import needed. Locate them by name, not by line.

`src/oauth/generic-account-failover.ts:189` — inside `isProactivePreferenceEnabled`, current:

```ts
  if (provider.oauthAccountFailover?.enabled === false) return false;
  if (config.oauthAccountFailover?.enabled === false) return false;
  return hasFailoverAccountQuorum(providerName, now);
```

target:

```ts
  const perProvider = provider.oauthAccountFailover?.enabled;
  // Preserve the published narrow-over-broad precedence. A provider-specific true may
  // opt this provider into proactive preference even when the global default is false;
  // a provider-specific false refuses it even when the global setting is true.
  if (typeof perProvider === "boolean") {
    return perProvider && hasFailoverAccountQuorum(providerName, now);
  }
  if (config.oauthAccountFailover?.enabled === false) return false;
  return hasFailoverAccountQuorum(providerName, now);
```

The `typeof … === "boolean"` guard is what keeps a malformed value falling through rather than
taking a provider out of service — preserve it exactly.

`src/types/config.ts:794` and `src/types/provider.ts:433` — doc-comment only. Replace
"only `false` is meaningful — `true` adds nothing over presence" with "per provider in either
direction; reactive 429 rotation remains presence-driven". **No field is added or removed**
(see §4).

`structure/04_transports-and-sidecars.md` — add the "OAuth account failover" row to the owner
table and the Decision Log block; applies cleanly.

**Conflict resolution recipe.**

- `src/oauth/anthropic-routing.ts`: **mechanical.** The PR's hunk anchors at old line 621; dev
  inserted `quorumCache = null;` above it (at :660 on `6580694c7`, :673 on `79e03643d`), and
  `bdafc5191` then added a comment block in the same function. The target line itself is
  byte-identical on dev in both. Re-apply below the `quorumCache = null;` that immediately
  precedes the `const next = pickAlternateAnthropicAccount(...)` call — anchor on that pair,
  not on a line number.
- Docs: **semantic, and this is the real work.** #3520 (`5d10a1900`) already landed
  "stop promising a 429 failover kill switch that no longer exists" and rewrote this prose. Do
  **not** replay the PR's docs hunks. Write a fresh delta on top of #3520's current text
  describing per-provider precedence in both directions, and remove the enabled-only opening
  condition CodeRabbit named: `fr/reference/configuration/providers.md` ~:207,
  `zh-cn/reference/configuration/providers.md` ~:172, and the English pair at
  `reference/configuration/providers.md` ~:437-438. Re-read each file first; those line
  numbers are from the PR's base, not dev.
- `docs-site/**/guides/claude-code.md` (en, fr, tr, zh-tw) hunks in #3502 are unrelated to this
  split and overlap B3's docs work. **Drop them from B1**; B3 owns that guide.

**Regression tests.** Replay at migrated paths — all three exist on dev, contrary to the lane
doc:

- `tests/routing/always-on-429-failover.test.ts` — RED on dev for the disabled-pool case: dev
  calls `pickAlternateAnthropicAccount` unconditionally (`:675` on `79e03643d`), so a disabled pool still
  applies round-robin/fill-first. GREEN after the branch.
- `tests/oauth/generic-oauth-failover.test.ts` — RED for "provider-specific `true` opts in
  under a global `false`": dev returns `false` at the global check. GREEN after.
- `tests/oauth/adapter-event-oauth-failover.test.ts` — replay as-is.
- `tests/adapters/anthropic/anthropic-sidecar-account-failover.test.ts` — new (+277). Resolver
  confirms `adapters/anthropic`, which is migrated and exists, so create it **there**.

Rewrite specifiers by depth: `tests/routing/` and `tests/oauth/` are depth 1
(`../src/` → `../../src/`); `tests/adapters/anthropic/` is depth 2 (`../../../src/`).

**Focused verifier:** V7 (dev baseline 8 pass / exit 0), plus
`bun test tests/oauth/generic-oauth-failover.test.ts tests/oauth/adapter-event-oauth-failover.test.ts`,
plus the new anthropic file, then V9 and V10.

**Accept criteria + activation scenarios.** Every conditional path added here is a policy
branch, so each needs a scenario:

| Path | Scenario | Expected |
|---|---|---|
| Anthropic pool **enabled**, 429 | pool enabled, strategy round-robin, 2 accounts | `pickAlternateAnthropicAccount` — unchanged behavior |
| Anthropic pool **disabled**, 429 | pool disabled, dormant `strategy: "fill-first"` left in config, 2 eligible accounts | `pickLowestUsage` — recovery happens, strategy does **not** reactivate |
| Disabled pool, all accounts cooled | same, both in cooldown | `null` → existing 429 + `[anthropic-pool]` warn |
| Per-provider `true`, global `false` | `providers.x.oauthAccountFailover.enabled = true`, `oauthAccountFailover.enabled = false` | Proactive preference **on** for x (quorum permitting) |
| Per-provider `false`, global unset/true | inverse | Proactive preference **off** for x |
| Per-provider unset, global `false` | only the global key written | Off — unchanged from dev |
| Per-provider malformed (`"yes"`) | hand-edited config | `typeof` guard falls through to global; provider stays in service |
| Quorum absent | per-provider `true`, 1 account | Off — presence still governs |

**Docs-site sync:** required, and it is the semantic conflict above. English +
`fr/ja/ko/ru/tr/zh-cn/zh-tw` copies of `reference/configuration/providers.md` and
`reference/cli/providers-accounts.md`. Locales must not contradict the English source.

**PR skeleton.** Title: `fix(oauth): repair proactive-failover policy boundaries`

```
## Summary
Carries the policy half of #3502 onto current dev, rebased, with docs rewritten on top of
#3520 rather than replayed.

1. src/oauth/anthropic-routing.ts consults the pool's proactive strategy even when the
   pool is disabled, so a disabled pool silently reactivates round-robin/fill-first on the
   reactive 429 path.
2. src/oauth/generic-account-failover.ts:189 honours only enabled === false per provider, so
   a provider-specific true cannot opt back in when the global default is false.

The Kiro continuation half of #3502 is split into the next PR in the stack.

## Verification
- bun test tests/routing/always-on-429-failover.test.ts
- bun test tests/oauth/generic-oauth-failover.test.ts tests/oauth/adapter-event-oauth-failover.test.ts
- bun test tests/adapters/anthropic/anthropic-sidecar-account-failover.test.ts
- bun run typecheck

## Checklist
(all four boxes)

| Layer | Branch | Targets |
|---|---|---|
| B1 (this) | codex/260905-oauth-failover-policy-boundaries | dev |
| B2 | codex/260905-kiro-continuation-auth-context | B1 |
| B3 | codex/260905-claude-native-fallback | B2 |
| B4 | codex/260905-startup-reconcile-persistence | B3 |
| B5 | codex/260905-codex-toggle-truthful | B4 |
| B6 | codex/260905-combo-failure-classification | B5 |

Co-authored-by: Ingwannu <ingwannu@users.noreply.github.com>
```

No `Closes #`; close #3502 manually once B2 also lands.

### 3.4 B2 — #3502 Kiro continuation auth context (split 2 of 2)

**File change map.** `src/server/responses/core.ts` only — no `src/oauth/` file, so **no
sponsorship needed** (§5). That isolation is the point of the split.

At `core.ts:3364`, widen the closure signature:

```ts
  const applyFailoverSnapshot = (
    snapshot: OAuthAccessSnapshot,
    retryParsed: OcxParsedRequest = parsed,
  ): boolean => {
```

At `core.ts:3380`, current:

```ts
    if (route.providerName === "kiro") parsed._kiroAuthContext = { ...(snapshot.kiro ?? {}) };
```

target:

```ts
    if (route.providerName === "kiro") {
      const kiroContext = { ...(snapshot.kiro ?? {}) };
      // Terminal-guard continuations are rebuilt from a shallow clone. Updating only the
      // outer request pairs the new bearer with the failed account's region/profile on
      // the retry. Keep both owners synchronized; for ordinary paths they are identical.
      parsed._kiroAuthContext = kiroContext;
      if (retryParsed !== parsed) retryParsed._kiroAuthContext = { ...kiroContext };
    }
```

At `core.ts:6693`, current `if (applyFailoverSnapshot(snapshot)) {` becomes
`if (applyFailoverSnapshot(snapshot, nextParsed)) {`.

**Conflict resolution recipe:** mechanical. The default parameter keeps all other call sites
source-compatible, so only the terminal-guard site changes. If wp1's #3515 landed first, its
edit is at ~4925 — no overlap with 3380 or 6693.

**Regression test.** New: `tests/providers/kiro/kiro-auth-context-continuation.test.ts`
(resolver: `providers/kiro`, migrated, directory exists; specifiers `../../../src/`). Asserts
that after a 429 rotation on the terminal-guard path, the object passed to the retry carries
the **rotated** account's region/profile. RED on dev: dev writes only `parsed`, so `nextParsed`
keeps the failed account's context. GREEN after.

**Focused verifier:** `bun test tests/providers/kiro/kiro-auth-context-continuation.test.ts`
then V9. Add `bun test tests/providers/kiro/` for the sibling Kiro files.

**Accept criteria + activation scenarios.**

| Path | Scenario | Expected |
|---|---|---|
| `retryParsed === parsed` (default) | Ordinary rotation, non-terminal | One write; behavior identical to dev |
| `retryParsed !== parsed` | Terminal-guard continuation with `nextParsed` | Both objects carry the rotated context |
| Non-Kiro provider | Anthropic/Google rotation | Branch not entered; no `_kiroAuthContext` written |
| `snapshot.kiro` undefined | Kiro account with no stored region/profile | `{}` on both, never the failed account's values |

**Docs-site sync:** none (internal retry plumbing).

**PR skeleton.** Title: `fix(responses): carry rotated Kiro auth context into the terminal continuation`.
Body: same shape; stack table with B2 marked "(this)"; trailer
`Co-authored-by: Ingwannu <ingwannu@users.noreply.github.com>`.

### 3.5 B3 — #3519 native Claude launch fallback (LAND_WITH_FIX)

Head `6b92ab7db`, draft, `CHANGES_REQUESTED` (Ingwannu, against an older head — the lane
verified both blockers are fixed on `6b92ab7db`).

**Route decision.** #3519 is `MERGEABLE` and the author is active. Prefer asking the author to
exit draft, tick 4/4, and get the review re-run — then merge #3519 directly with the three
fixes below pushed by the author. Only if that stalls, carry it as B3. Either way the three
fixes are required, so they are specified as changes.

**File change map (fixes on top of the PR's head).**

1. **Docs (High, AGENTS.md "Docs sync").** `docs-site/src/content/docs/guides/claude-code.md`
   plus `fr/ja/ko/ru/tr/zh-cn/zh-tw` twins (all eight verified present) still describe
   `ocx claude` as proxy-only. Add: when `claudeCode.enabled` is explicitly `false` — in
   config or reported live by `GET /api/claude-code` — `ocx claude` launches the native
   `claude` binary instead of erroring, and what happens to `ANTHROPIC_BASE_URL`.
2. **Silent `readPickerDefaultModel` failure (Medium).** The PR adds:

   ```ts
   function readPickerDefaultModel(configDir: string): string | null {
     try {
       const parsed = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")) as Record<string, unknown>;
       return typeof parsed.model === "string" && parsed.model.trim() !== "" ? parsed.model.trim() : null;
     } catch { return null; }
   }
   ```

   A corrupt `settings.json` is indistinguishable from an absent one, so the
   "saved model requires the proxy" warning disappears exactly when the file is broken.
   Distinguish absent (`ENOENT` → `null`, silent) from unparseable (`console.warn` naming the
   file, no contents echoed). Keep the repo's `no-excuse-ok` marker convention on the catch.
3. **Restore the deleted `#764 / SERVICE_STOP_LIVENESS` rationale comment** above
   `ensureProxyForClaude`. The diff deletes it while keeping the behavior, discarding the
   reason the 3-attempt budget exists.

For orientation, dev's current behavior is the hard error at `src/cli/claude.ts:420`:

```ts
  if (config.claudeCode?.enabled === false) {
    console.error("Claude inbound is disabled (config.claudeCode.enabled=false — flip the Claude ON toggle in the GUI or edit config).");
    return 1;
  }
```

**Conflict resolution recipe:** none — `MERGEABLE`, and its test already sits at
`tests/claude-integration/claude-cli.test.ts` (migrated, correct).

**Regression tests.** `tests/claude-integration/claude-cli.test.ts` (+6 unit tests: plan
matrix, preflight ordering, env scrubbing, the `http://localhost:8080` loopback negative,
`isProxyOnlyModelId` incl. an AWS Bedrock ARN false-positive guard, root opt-in). These are
RED on dev by **compile failure** — `claudeLaunchPlan`, `buildNativeClaudeEnv`,
`claudeLaunchPreflight`, `isProxyOnlyModelId` do not exist on dev. That is the honest state
for new behavior. Add a seventh: corrupt `settings.json` produces a warning and still returns
`null` (RED against the PR's own head, GREEN after fix 2).

**Focused verifier:** V5 (dev baseline 34 pass / exit 0) then V9.

**Accept criteria + activation scenarios.** This layer adds the most branches in the phase:

| Path | Scenario | Expected |
|---|---|---|
| `claudeCode.enabled` absent | Default install | Routed launch, exactly as dev |
| Config `enabled: false` | User flipped Claude OFF | Native launch + `CLAUDE_NATIVE_ROUTING_OFF` notice |
| Live `enabled: false` from `GET /api/claude-code` | Toggle flipped in GUI while proxy runs | Native launch + `CLAUDE_NATIVE_LIVE_DISABLED` |
| Older proxy omitting `enabled` | Proxy predates the field | Stays routed (only explicit `false` disables) |
| Proxy absent, routing on | Proxy not started | `ensureProxyForClaude` still spawns — **not** native fallback |
| Env scrub: owned admission + loopback + exact port | `ANTHROPIC_BASE_URL=http://127.0.0.1:<config.port>` | Deleted |
| Env scrub negative | `ANTHROPIC_BASE_URL=http://localhost:8080` + user credential | **Preserved** (both) |
| Preflight ordering | Invalid/mismatched client state | Preflight errors **before** any native fallback |
| `settings.json` absent | Fresh install | `null`, silent |
| `settings.json` corrupt | Truncated JSON | `null` + one warning naming the file |
| Root + `--dangerously-skip-permissions` | Root shell | Existing `rootSkipPermissionsNotice` unchanged |

The env-scrub guard is `hasOwnedAdmission && targetsLocalClaudeProxy(baseUrl, config.port)`;
dev's `targetsLocalClaudeProxy` (`src/cli/claude.ts:60`) already requires http + loopback host
+ exact configured port + no embedded credentials.

**Docs-site sync:** required — the eight `guides/claude-code.md` files above.

**PR skeleton.** Title: `fix(claude): fall back to native launch when routing is off`.
Body must state the behavior change plainly (dev hard-errors at `src/cli/claude.ts:420`), list
the three fixes, carry the stack table, and — if carried — the
`Co-authored-by: everton-dgn <evertondgn@hotmail.com>` trailer.
**Pre-merge:** the stale `CHANGES_REQUESTED` must be dismissed by Ingwannu or superseded by a
fresh review; a maintainer merge does not clear it.

### 3.6 B4 — #3524 reimplementation: startup reconciliation persistence

**Why REIMPLEMENT.** The defect is real: `reconcileOAuthProviders` at `src/oauth/index.ts:1250`
mutates the in-memory config then `saveConfig(config)`, so a startup snapshot can overwrite an
operator edit made after load. But the PR's rewrite adds an **unguarded `throw` on the boot
path** (lane reproduced it live: "THREW: OAuth provider reconciliation persistence unavailable:
missing"). `reconcileOAuthProviders(config)` is called with no try/catch at
`src/server/index.ts:663`, and `runModelRenameStartupMigration` at `:651` has the same shape.
Both are inside `startServer`, which is synchronous by design.

**File change map.**

`src/oauth/index.ts` — take the PR's projection/adopt refactor
(`projectOAuthProviderReconciliation`, `adoptOAuthReconciliation`,
`withOAuthReconciliationTouchedKeys`, `reconcileOAuthProviders(config, persist = true)` using
`mutatePersistedConfig`), but **replace** the PR's:

```ts
  if (outcome.status === "unavailable") {
    throw new Error(`OAuth provider reconciliation persistence unavailable: ${outcome.reason}`);
  }
```

with the degrade-and-warn shape every other `mutatePersistedConfig` consumer already uses
(`src/storage/policy.ts:473`, `src/codex/plan-from-token.ts:92`, `src/codex/auth-api.ts:1089`,
`src/server/management/agent-settings-routes.ts:124`): warn once with the reason, adopt the
in-memory projection so the running process is still correct, and return `true`. Same change in
`src/providers/model-rename-startup.ts` for
`"model rename startup persistence unavailable: …"`.

`src/server/index.ts` — no change required once the throws are gone. Do **not** add an
`await` anywhere near `Bun.serve`; AGENTS.md's synchronous-activation invariant is scanned by
the guard in `tests/lab/core-lab-boundary.test.ts`. Both call sites (`:651`, `:663`) sit far
above `Bun.serve` and stay synchronous.

`adoptConfig` in `src/providers/model-rename-startup.ts` deletes every key of the caller's
object and re-assigns from a `structuredClone`. Object identity survives, but a live reference
to a nested sub-object held elsewhere is silently detached. Reimplement as a key-by-key assign
over the touched keys only (the projection already tracks `touchedProviders` and
`touchedAntigravityVersion`).

**Split.** The PR bundles OAuth and model-rename. Keep both here — same failure mode, same
helper — but if sponsorship (§5) stalls, the model-rename half
(`src/providers/model-rename-startup.ts`, not a restricted path) can ship alone.

**Regression tests.**

- `tests/oauth/oauth-provider-reconcile.test.ts` — carry the PR's coverage, but **invert the
  throw assertion**: the PR asserts the throw string at its `:81`; the reimplementation asserts
  `status: "unavailable"` degrades, warns, and returns without throwing. RED against the PR's
  head, GREEN here.
- `tests/providers/model-rename-migration.test.ts` — same inversion.
- **New:** `tests/server/server-startup-reconcile-resilience.test.ts` **(drift-corrected:
  `server` became a migrated domain in `79e03643d`, so this goes in `tests/server/` at depth 1
  with `../../src/` specifiers — at the lane snapshot it would have stayed at root)**.
  This is the gap the lane named: the PR proves the new failure mode in
  isolation and never checks where it matters. Assert `startServer` completes and serves
  `/healthz` when the config file disappears between `loadConfig()` and reconcile.
  RED against the PR's head (throws), GREEN here.

  Reproduction recipe from the lane: isolated `OPENCODEX_HOME`, load a valid config, remove
  `config.json`, then reconcile. Benign paths that must stay `changed=false`: fresh install with
  no `config.json`, malformed JSON, unreadable file.

**Focused verifier:** V6 (dev baseline 9 pass / exit 0),
`bun test tests/providers/model-rename-migration.test.ts`,
`bun test tests/server/server-startup-reconcile-resilience.test.ts`, then V9.

**Accept criteria + activation scenarios.**

| Path | Scenario | Expected |
|---|---|---|
| `status: "unchanged"` | Nothing to reconcile | No write, no warn, returns `false` |
| Committed mutation | Preset gained a model | Persisted via rebase; concurrent operator edit preserved |
| `status: "unavailable"` | `config.json` removed between load and reconcile | Warn once, adopt in-memory, **`startServer` completes** |
| Fresh install, no config | First run | `changed=false`, no warn |
| Malformed JSON | Hand-edited broken config | `changed=false`, degrade |
| Unreadable file | Permissions / unmounted volume | `changed=false`, degrade |
| `persist = false` | Callers that manage their own write | In-memory adopt only |
| Rebase contention | Competing writer during the mutation | Retries within `CONFIG_MUTATION_MAX_REBASE_ATTEMPTS`, then degrades |

**Docs-site sync:** none (startup internals, no user-facing surface).

**PR skeleton.** Title: `fix(oauth): rebase startup reconciliation on the persisted config`.
Summary must state explicitly that reconciliation **degrades and warns** rather than throwing,
and that a startup-path regression covers it. Trailer
`Co-authored-by: yansigit <44089734+yansigit@users.noreply.github.com>`. Close #3524 manually
with a pointer. Needs `maintainer-sponsored` (§5) and a clean `enforce-target`.

### 3.7 B5 — #3407 reimplementation: truthful Codex dashboard toggle

**Precondition:** #3484 must be on `dev` (shared
`gui/src/pages/integrations/IntegrationsOverview.tsx`). If not, stop and report.

**Why REIMPLEMENT.** Five CI jobs fail on the PR's exact head (`ci`, `gates`, `macos`,
`test 1/4`, `test 2/4`), it is 121 commits behind, and it tracks a 166 KB PNG at
`docs/pr-assets/3407-codex-disable-dialog.png` — confirmed present in the PR's file list. The
`gui` gate wants a screenshot **in the description**, not a binary in the tree.

**File change map.**

`src/server/management/native-integration-routes.ts:686` — current:

```ts
      clients: [claudeStatus(config, getConfigPath()), grokStatus(config), codexStatus(config, getConfigPath()), desktopStatus(config)],
```

`codexStatus` writes its `configPath` parameter straight into the row (`:164`), so the Codex
row reports **opencodex's** config file. Target: pass `join(getCodexHome(), "config.toml")` for
the Codex row only; `claudeStatus` legitimately keeps `getConfigPath()`. `getCodexHome` is
already exported and used across `src/codex/` (`src/codex/inject.ts:68`).

`gui/src/pages/integrations/IntegrationsOverview.tsx` — the switch renders `row.applied`
(observed routing) rather than the user's setting, so the toggle can contradict what the user
chose. Target: `toggleOn = row.toggleOn ?? row.applied`. Also add `codexResource.refresh()`
after a successful toggle and the `"codex"` case in `blockedText`.

`gui/src/i18n/{en,ko,ja,zh,zh-TW,fr,de,ru,tr}.ts` — add `CODEX_DISABLE_COPY` and its 6 keys
across **all nine** locales, applied to current dev's files (the PR's versions are 121 commits
stale and i18n files are append-heavy).

**Explicitly dropped from the carry:** the tracked PNG, and the
`nativeSettled === undefined` backward-compatibility branch — update the callers directly
instead.

**Conflict resolution recipe:** do not rebase the PR. Reapply the four changes above by hand
onto current dev. The i18n files are the only high-friction part; add keys at the current end
of each locale object rather than replaying positional hunks.

**Regression tests.**

- `tests/codex-integration/native-codex-toggle.test.ts` — already exists on dev (164 lines,
  6 tests, V8 baseline 6 pass / exit 0) at the migrated path. Add a config-path assertion: the
  Codex row's `configPath` ends with the Codex home `config.toml`, not opencodex's config
  file. RED on dev (dev passes `getConfigPath()`), GREEN after.
  `rg -n "configPath" tests/codex-integration/native-codex-toggle.test.ts` returns nothing
  today, so this assertion is genuinely new rather than a rename of an existing one.
- `gui/tests/integrations-surfaces.test.tsx` and `gui/tests/integrations-overview-rows.test.ts`
  — toggle reflects `toggleOn`, refresh fires, `blockedText` covers `"codex"`. (GUI tests live
  outside `tests/`, so the layout guard does not apply to them.)

**Focused verifier:** V8 then V9. GUI: `bun run lint:gui` and the GUI runner for the two files
above.

**Accept criteria + activation scenarios.**

| Path | Scenario | Expected |
|---|---|---|
| `clientIntegrations.codex` unset | Default | Row `current`, toggle on, path = Codex `config.toml` |
| `clientIntegrations.codex === false` | User turned Codex off | Row `absent`, toggle **off** even if routing still observed |
| `row.toggleOn` undefined | Row from an older payload | Falls back to `row.applied` — no crash |
| Toggle succeeds | User flips it in the GUI | `codexResource.refresh()` runs; row updates without reload |
| Toggle blocked | Codex disable blocked by admission | `blockedText` returns the `"codex"` copy, not a blank |
| Locale coverage | App in each of 9 locales | Every new key resolves; no raw key text |

**Docs-site sync:** `docs-site/src/content/docs/guides/codex-integration.md` — describe what
the Codex row's config path now points at and that the toggle reflects the user's setting.

**PR skeleton.** Title: `fix(integrations): make the Codex dashboard toggle truthful`.
Body must include the **screenshot in the description** (not a tracked file) because the title
mentions `gui`; trailer `Co-authored-by: turin-dev <koomj5258@gmail.com>`. Close #3407
manually with a pointer.

### 3.8 B6 — #3348 PR A: combo failure classification only

**Why REIMPLEMENT and split.** 2165/196 across 35 files, only 5 checks ever ran (no shards, no
gates, no macOS) despite a `review-ready` label, and 10 of 16 test files moved into 6 domains.
The lane's 410/413 concern is resolved — re-verified at plan time: `comboFailureDecision`
(`src/combos/failover.ts:323`) has no 410/413 in its hop list (`[401, 403, 404, 408, 429]` plus
`>= 500`), and `isModelLifecycleGone` still requires `status === 410` **and** a structured
lifecycle code.

**PR A file change map (this layer).**

`src/combos/failover.ts:256` — widen the scope type:

```ts
export type ComboFailureCooldownScope = "target" | "provider";          // current
export type ComboFailureCooldownScope = "none" | "target" | "provider"; // target
```

`src/combos/failover.ts:280-286` — current body:

```ts
  return isProviderScopedQuotaCap(status, message, options?.code) ? "provider" : "target";
```

Target: return `"none"` for request-shape failures (413, `input_admission_refused`,
`context_length_exceeded`, `tool_catalog_too_large`, `cursor_root_envelope_limit`,
`target_incompatible`) — an oversized request must not cool a healthy target — and
`"provider"` for 401/402/403 and credential/billing codes, before the existing quota-cap check.

`src/combos/failover.ts:323` `comboFailureDecision` — recognize
`model_not_found`/`model_unavailable`/`unsupported_model` as target-local hops, and add 402 and
425 to the hop status list.

Move `free_rate_limited` out of provider-scoped quota into a request-local free-prompt cap.
Today `isProviderScopedQuotaCap` (`:275`) returns true for `free_rate_limited` /
`err_free_prompt_cap` / "free tier"+"single request", so a **per-request** cap cools an entire
provider. Introduce `isRequestLocalFreePromptCap` and remove those three needles from the
provider-scoped predicate.

`src/lib/errors.ts:365` `inferHttpStatusFromAdapterMessage` — `"malformed upstream"` currently
falls into the `invalid`/`not found`/`unsupported`/`malformed` group returning a 4xx. Map it to
**502**: upstream garbage is a provider failure, not a client error. Scope the match to
"malformed upstream" specifically so plain `"malformed"` keeps its current verdict.

`src/combos/resolve.ts` — the standalone bug. `pickComboTarget`'s `eligible` predicate (`:155`)
checks provider usability, cached quota exhaustion, and exclusion — but **not** cooldown, so a
target cooled a moment ago is picked anyway. `isComboTargetInCooldown` is already imported at
`resolve.ts:4` and already used in a *different* code path at `:299`. Add to the predicate:

```ts
    && !isComboTargetInCooldown(comboId, target, now)
```

**Field/enum chain for `key-401`** — see §4; it is four sites, not one.

**Conflict resolution recipe.** Do not rebase #3348. Reapply the six changes above by hand.
Tests: place each new/edited file at its resolved domain —
`tests/routing/router-combo-failover-classification.test.ts` (new; resolver `routing`,
migrated), `tests/routing/combo-management-api.test.ts` (exists),
`tests/codex-integration/combos.test.ts` (exists),
`tests/providers/cyber-policy-error-fidelity.test.ts` (exists),
`tests/server/error-fidelity.test.ts` (exists, drift-corrected). Rewrite specifiers by depth.

**Regression tests.**

- `tests/routing/router-combo-failover-classification.test.ts` (new). RED on dev for four
  claims: (a) `comboFailureCooldownScope(413, …) === "none"` — dev returns `"target"`;
  (b) `free_rate_limited` does not cool the provider — dev's `isProviderScopedQuotaCap` at
  `:275` returns true; (c) `comboFailureDecision(402|425, …) === "hop"` — dev's list is
  `[401, 403, 404, 408, 429]`; (d) a cooled target is not picked — dev's `eligible` omits the
  cooldown check. Must **also** assert the invariants that must not move:
  `comboFailureDecision(410, "resource is gone") === "stop"` and
  `comboFailureDecision(413, "request too large") === "stop"`, both green on dev and after.
- `tests/server/error-fidelity.test.ts` — `"malformed upstream"` → 502. RED on dev.

**Focused verifier:** `bun test tests/routing/router-combo-failover-classification.test.ts`,
V1, `bun test tests/codex-integration/combos.test.ts`, then V9 and V10.
**Not local gates:** `tests/server/server-combo-failover-e2e.test.ts` and
`tests/routing/combo-management-api.test.ts` — both are EADDRINUSE-red on unmodified dev in
this sandbox (45 and 3 failures). Read them on hosted CI only.

**Accept criteria + activation scenarios.**

| Path | Scenario | Expected |
|---|---|---|
| `"none"` scope | 413 oversized request against a healthy target | No cooldown recorded; target stays selectable |
| `"none"` via code | `input_admission_refused` / `context_length_exceeded` | No cooldown |
| `"provider"` scope | 401 invalid key / 402 billing | Whole provider cooled |
| `"target"` scope | Ordinary 500 from one target | Only that target cooled |
| Free-prompt cap | `free_rate_limited` on one request | Request-local; provider **not** cooled |
| Model-local hop | `model_not_found` | `hop` to next combo target |
| 402 / 425 | Payment required / too early | `hop` |
| Invariant: generic 410 | `"resource is gone"` | `stop` (unchanged) |
| Invariant: generic 413 | `"request too large"` | `stop` (unchanged) |
| Lifecycle 410 | Structured `model_end_of_life` | `hop` (unchanged) |
| Cooldown predicate | Target cooled 5 s ago, cooldown 60 s | Not picked |
| Cooldown expired | Cooled 5 s ago, cooldown 1 s | Picked; `isComboTargetInCooldown` self-evicts |
| `"malformed upstream"` | Upstream returns garbage | 502, not 4xx |
| `key-401` recovery kind | Key-pool 401 rotation | Recorded and round-trips through the usage log |

**Docs-site sync:** if the combos reference documents cooldown scope, update it and its
locales. Verify with `rg -n "cooldown" docs-site/src/content/docs/reference/` before writing —
if nothing describes scope, no docs change is required and the PR should say so.

**PR skeleton.** Title: `fix(combos): scope failover cooldowns to the failure's blast radius`.
Summary must state that generic 410/413 remain terminal (with the two assertions named), that
disk persistence and policy-fallback semantics are **separate** PRs, and carry
`Co-authored-by: RHODIZSECURITY <info.rhodiz@gmail.com>`.

**PRs B and C (cut here, not required to land in wp2).**

- **PR B — disk persistence.** `src/combos/cooldown-disk.ts` and
  `src/providers/key-cooldown-disk.ts` (~177 lines) plus `startServer` hydration and shutdown
  flush. **Both debounce timers must `unref()`** — the PR does
  `persistTimer = setTimeout(..., 250)` with none, and a pending 250 ms timer can hold the
  event loop open at exit. Copy the established shape from `src/responses/state.ts:1573`:
  `(persistTimer as { unref?: () => void }).unref?.();`. New test at
  `tests/storage/storage-cooldown-disk.test.ts` (**drift-corrected: `storage` became a
  migrated domain in `79e03643d`**). Hydration must stay synchronous and far above `Bun.serve`; the lane
  verified the PR's placement (~line 650 vs `Bun.serve` at 2367) does not violate the
  synchronous-activation invariant.
- **PR C — policy-fallback semantics.** Dev returns the last upstream response when candidates
  are exhausted (`src/server/responses/policy-fallback.ts:160`: `if (!next) return response;`).
  The PR replaces it with a synthesized 503 `policy_unavailable` (or 413
  `policy_input_too_large`), discarding the real upstream status and body, and converts two
  `return overload` paths into `response = overload` so a pacing overload continues the hop
  loop. Both are client-visible and unannounced in the PR title. Title them honestly; new test
  at `tests/routing/policy-fallback-exhaustion.test.ts` (resolver `routing`, migrated).
  **Explicitly excluded from wp2's stop condition.**

Also excluded from all three: `exhaustedQuotaRecoveryMs` deriving multi-day key cooldowns from
cached provider quota (a 31-day ceiling driven by cache), and the `cooldownKey` signature
change from `keyId` to raw `apiKey`. Privacy is fine (persisted rows carry 8-char SHA-256
prefixes, `isSafeCooldownRowKey` enforces `/^[0-9a-f]{8}$/`), but passing raw secrets through
more call sites is a widened surface needing deliberate sign-off.

## 4. Field/enum chains

**No new config field is introduced anywhere in wp2.** Two things look like fields and are not,
plus one real enum chain:

**`oauthAccountFailover.enabled` (B1) — N/A, existing field.** It already exists at
`src/types/config.ts:796` (global) and `src/types/provider.ts:435` (per provider), both
`{ enabled?: boolean }`. B1 changes only how the **existing** value is read
(`isProactivePreferenceEnabled`) and the doc comment. Creation (GUI/CLI/hand-edit),
serialization, and deserialization are untouched, so there is no new chain to trace. What does
change is consumer precedence, which is why §3.3's scenario table enumerates all four
global × per-provider combinations plus the malformed case.

**`_kiroAuthContext` (B2) — N/A, request-local.** It lives on the in-memory parsed request, is
never persisted, and is not a config field. The change is which object owns it during a retry.

**`key-401` on `AttemptRecoveryKind` (B6) — a real four-site chain.** The lane treats this as
one item; it is not. Verified locations:

| Stage | Site | Change |
|---|---|---|
| Type | `src/usage/log.ts:45` `AttemptRecoveryKind` union | Add `\| "key-401"` |
| Runtime validation | `src/usage/log.ts:256` `ATTEMPT_RECOVERY_KINDS` set | Add `"key-401"` — this set is the deserialization filter at `:394-395`, so a value missing here is silently dropped on read-back |
| Production | `src/server/responses/core.ts` rotation sites (pattern: `nextContinuationRecoveryKind = "oauth-account-429"` at ~`core.ts:6694`) | Emit `"key-401"` on the key-pool 401 rotation path |
| Consumer | `src/routing/analytics.ts:117` `COOLDOWN_RECOVERY_KINDS` | Add `"key-401"` so `:155` counts it as a cooldown recovery |

Serialization needs no change (`recoveryKinds: AttemptRecoveryKind[]` at `src/usage/log.ts:73`
writes the string as-is), but **deserialization does**: `:394` filters through
`ATTEMPT_RECOVERY_KINDS`, so adding the type without the set produces a value that writes fine
and vanishes on read. The regression must round-trip a persisted attempt, not merely typecheck.

**`ComboFailureCooldownScope` gaining `"none"` (B6) — type-only, no persistence.** Declared at
`src/combos/failover.ts:256`, consumed in-process via `src/combos/resolve.ts:4` and
`src/combos/index.ts:37`. Never serialized in PR A. If PR B lands, it becomes persisted state
and needs its own chain review — one more reason PR B is separate.

## 5. Risk, rollback, and security boundaries

| Layer | Primary risk | Rollback |
|---|---|---|
| carry-3489 | Widens a DNS/SSRF exception. Blast radius bounded to the registry's own fixed discovery URL | Single squash revert; `isCanonicalUrl` defaults to `() => false`, so reverting the seam alone restores dev behavior |
| carry-3469 | A too-broad matcher could reclassify unrelated 400s as permission errors | Squash revert. Mitigated by requiring an explicit location/region/country cue and the negative test |
| B1 | Changes who may fail over. A precedence bug could route to an account the operator refused | Revert B1; B2+ depend on its position, not its behavior |
| B2 | Touches the shared `core.ts` retry path | Revert; the default parameter means all other call sites are unchanged |
| B3 | Largest behavior change: an error becomes a native launch. Worst case is a credential reaching an unintended base URL | Revert. Guarded by `hasOwnedAdmission && targetsLocalClaudeProxy(baseUrl, config.port)` and the `localhost:8080` negative test |
| B4 | Boot path. A mistake here fails startup — exactly the defect being fixed | Revert. The new startup-survival regression is the standing guard |
| B5 | GUI + i18n across 9 locales | Revert. Contained to the integrations page and one route line |
| B6 | Changes when a target is cooled and when a failure hops | Revert. The invariant assertions (410/413 stay `stop`) are the tripwire |

**Security-boundary items requiring the MAINTAINERS.md exception.** The gate is code:
`.github/scripts/pr-sponsored-surface.cjs` defines
`RESTRICTED_PREFIXES = [".github/workflows/", "src/oauth/"]` plus a `RESTRICTED_FILES` set, and
`assessSponsoredSurface` returns `{ code: "unsponsored_surface" }` unless the author has push
permission **or** the PR carries the `maintainer-sponsored` label.

| Layer | Restricted paths | Requirement |
|---|---|---|
| B1 | `src/oauth/anthropic-routing.ts`, `src/oauth/generic-account-failover.ts` | `maintainer-sponsored` unless the author has push permission. This is what failed #3524's `hygiene` (`unsponsored_surface`, "Paths: src/oauth/index.ts") |
| B4 | `src/oauth/index.ts` | Same. `src/providers/model-rename-startup.ts` is **not** restricted, which is the fallback if sponsorship stalls |
| B2, B3, B5, B6 | none | `src/server/responses/core.ts`, `src/cli/claude.ts`, GUI, `src/combos/`, `src/lib/errors.ts` are all unrestricted |
| carry-3489 | none by path | But it **is** a security-relevant change (SSRF/DNS boundary). MAINTAINERS.md requires explicit security review regardless of the automated gate. #3489 already has Ingwannu's; a carry branch should reference it and request re-confirmation |

If a maintainer authors B1/B4 with push permission the gate is satisfied by their own review —
but MAINTAINERS.md's "authors do not approve their own pull requests" and
"security-sensitive changes should be reviewed by both maintainers when practical" still apply.

## 6. Out of scope / deferred

| Item | Reason (carried from the lane) |
|---|---|
| **#3388** — Grok sparse terminal repair | 327 new lines land on `src/server/responses/core.ts`, one of three files AGENTS.md names as carrying every user's request path, and the head has **never run a single test shard**; draft, 132 behind, no human review, CodeRabbit skipped. The gate is `logCtx.surface === "grok"`, a client marker rather than a provider opt-in, which needs an explicit maintainer ruling. A "not yet": the 481 lines of new tests are thorough and RED on dev. Unblock = onto current dev, out of draft, both tests to `tests/responses/`, maintainer ruling on the marker gate. |
| #3348 PR B — cooldown disk persistence | Two new on-disk state files in the config dir are their own design decision, and the debounce timers are not `unref()`'d, which can hold the event loop open at exit. |
| #3348 PR C — policy-fallback exhaustion/pacing | Discards the real upstream status and body for a synthesized 503, and lets a pacing overload continue the hop loop — both client-visible and unannounced in the PR title. |
| #3348 — `exhaustedQuotaRecoveryMs` multi-day key cooldowns | A 31-day cooldown ceiling driven by cached provider quota is a big lever needing separate review. |
| #3348 — `cooldownKey` raw `apiKey` signature | Privacy is fine (8-char SHA-256 prefixes, `isSafeCooldownRowKey` enforces the hex-8 shape), but passing raw secrets through more call sites is a widened surface needing deliberate sign-off. |
| #3407 — tracked 166 KB PNG | The `gui` gate asks for a screenshot in the PR description, not a binary in the repository. |
| #3407 — `nativeSettled === undefined` compat branch | Dead weight in a reimplementation that can update the callers directly. |
| #3484, #3480 (lane B); #3515, #3529, #3525, #3490 (lane A) | LAND_AS_IS — owned by wp1 / Stack A, doc `010`. #3484 is a **precondition** for B5. |
| `tests/server/server-combo-failover-e2e.test.ts` local failures | 45 failures on **unmodified** dev, all `EADDRINUSE` from `Bun.serve({ port: 0 })` in this sandbox. Environmental; do not investigate or "fix". |

## Verification notes for this doc

- `git fetch origin dev` run at plan time; `origin/dev` = `6580694c7`; drift scoped to this
  phase's files is empty.
- Verifiers V1-V8 executed on unmodified dev; baselines recorded in §1. V9/V10 named but not
  run (V10 needs a change set).
- Every `src/` line number re-read at plan time on the current tree.
- Test-path targets resolved with the repository's own resolver
  (`scripts/test-layout/schema.ts`), not by pattern-matching the lane docs.
- PR head/mergeable state and co-author emails re-read via `gh pr view` immediately before
  writing; `gh` reported `UNKNOWN` mergeable for #3502/#3519/#3524 while recomputing against the
  new dev tip, and `CONFLICTING/DIRTY` for #3489/#3469/#3407/#3348/#3388.
- No `src/`, `tests/`, or `gui/` file was modified; no repository-wide suite was run.
