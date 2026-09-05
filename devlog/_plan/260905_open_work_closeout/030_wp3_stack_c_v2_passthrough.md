# 030 — wp3 / Stack C: #3444 direct encrypted V2 task passthrough

Unit: `devlog/_plan/260905_open_work_closeout`. Work-phase: **wp3**. Lane source:
[`003_lane_v2_and_quota.md`](./003_lane_v2_and_quota.md) (#3444 section).

Re-verified against `origin/dev` = `6580694c7911cfbf78da63b6258ec1c70bd8a0e3`
(`test(oauth): restore a deleted contract test, and fail when one disappears (#3530)`),
fetched at plan time. The lane doc was researched at `0f27bbeb3`.

**Drift check (executed, empty result):**

~~~
git log --oneline 0f27bbeb3..origin/dev -- src/config.ts src/types/provider.ts \
  src/server/auth-cors.ts src/server/responses/core.ts \
  tests/agent-task-recovery.test.ts \
  docs-site/src/content/docs/reference/configuration/providers.md
  -> (no output)
~~~

Zero commits in that range touch any of the six files #3444 changes. The single commit
`6580694c7` touches `tests/repo-hygiene.test.ts` and
`tests/routing/anthropic-quorum-cache.test.ts` only. **Every file:line citation in the lane
doc and in this plan is valid at the current `origin/dev`.**

---

## 1. Loop-spec header

| Field | Value |
|---|---|
| **Archetype** | spec-satisfaction repair |
| **Trigger** | PR #3444 is functionally complete and merges clean, but is held by two repository gates that no code change can clear: `hygiene / unsponsored_surface` (contributor touched `src/server/auth-cors.ts`) and `enforce-target` (contributor readiness checklist box 4 unticked, PR in draft). |
| **Goal** | Land the `allowEncryptedV2AgentTasks` opt-in on `dev` with author attribution to `cb8010d6` preserved, the security-boundary review recorded on the PR, and the regression coverage in `tests/agent-task-recovery.test.ts` green at the exact merged head. |
| **Non-goals** | (a) Changing the trust-boundary logic in `canPassThroughEncryptedV2AgentTask` — it was reviewed and is correct; (b) rebasing the contributor's fork branch on their behalf; (c) widening `RESTRICTED_FILES` or altering `.github/scripts/pr-sponsored-surface.cjs`; (d) any `main`/`preview` promotion; (e) landing #3447, #2783, #2973, #2956 (separate work-phases). |
| **Stop condition** | `git fetch origin dev && git merge-base --is-ancestor <squash-sha> FETCH_HEAD` exits 0, AND the merged PR's checks are green at the exact pre-merge head SHA, AND #3444 is closed with the merge recorded. |
| **Memory artifact** | This document + the merge ledger in `060_closeout.md`. |
| **Expected terminal outcomes** | `MERGED_AS_CARRY` (selected path) or `MERGED_AS_IS` (label path). Failure outcome: `BLOCKED_ON_MAINTAINER_LABEL` if neither the label nor a push-permission author is available. |
| **Escalation** | The `maintainer-sponsored` label and the admin squash bypass both require the maintainer. If the executing agent lacks label-write or merge permission, stop at "CI green on exact head" and hand off. Do **not** route around the sponsorship gate by splitting `auth-cors.ts` into a separate PR — that defeats the gate's stated purpose (`pr-sponsored-surface.cjs:14-18`). |

### Verifier commands (each proven to exist and to read the change target)

| # | Command | Proof it exists / reads the target | Observed exit |
|---|---|---|---|
| V1 | `bun test tests/agent-task-recovery.test.ts` | File present (`ls -la` -> 21050 bytes). Exercises `canPassThroughEncryptedV2AgentTask` through `post(config, "relay/gpt-5.6-luna", ...)`. | **0** on dev (19 pass / 0 fail); **1** on dev source + PR test file (22 pass / 1 fail); **0** on PR head (23 pass / 0 fail) |
| V2 | `bun test tests/agent-task-recovery-combo.test.ts tests/v2-agent-message-failfast.test.ts tests/agent-task-recovery-security.test.ts` | All three present. Cover the `options.comboAttempt` branch and the fail-closed guard this change must not widen. | **0** (40 pass / 0 fail) on dev |
| V3 | `bun run typecheck` (`bun x tsc --noEmit`, `package.json:43`) | Load-bearing: `PROVIDER_CONFIG_FIELD_POLICY` is `satisfies Record<keyof OcxProviderConfig, ProviderConfigFieldPolicy>` at `src/server/auth-cors.ts:870`. | **0** on dev. **Proven non-vacuous:** deleting the `auth-cors.ts` row from a PR-head tree yields `src/server/auth-cors.ts(870,12): error TS2741`. |
| V4 | `node --test .github/scripts/pr-sponsored-surface.test.cjs` | Directly covers `assessSponsoredSurface` — the function producing the block. | **0** (7 pass / 0 fail) |
| V5 | `gh pr checks <n>` filtered to the exact head SHA | Hosted CI: `test 1..4/4`, `gates`, `storage policy`, `api usage`, `hygiene`, `enforce-target`. | must be green pre-merge |
| V6 | `git fetch origin dev && git merge-base --is-ancestor <sha> FETCH_HEAD` | Landing proof. | must be 0 |
| V7 | `bun run privacy:scan` (`package.json:45`) | Security-boundary item: confirms no new body/credential logging on a ciphertext-forwarding path. | must be 0 |

**Do not run** `bun run test` or a bare `bun test`. The repository-wide suite is forbidden for
this campaign (000 plan), and the pre-push hook that would run it is bypassed with `--no-verify`.

---

## 2. Stack map (DEV-STACK-01..03)

**Stack C is a single-layer stack.** #3444 is the only lane-3 item that merges cleanly, is the
smallest diff (+111/-4 across 6 files), and every other lane-3 item benefits from it landing
first (they add distinct optional fields to the same schema objects). Under DEV-STACK-01 work is
stacked only when it splits into 2+ parts with a real dependency order **and** one PR would be
too large to review. Neither holds: one config field, one policy row, one guard function, two
call-site conditions, one docs row, one test block is a single cohesive thesis. Splitting it
would produce a lower layer (`auth-cors.ts` row alone) that **does not typecheck** — the
`satisfies Record<keyof OcxProviderConfig, ...>` constraint at `src/server/auth-cors.ts:870`
requires the field to exist on `OcxProviderConfig` first, and the field is inert without its
consumer. That is a slicing failure, and DEV-STACK-01's "do not stack when the change is one
cohesive thesis" applies directly.

| Layer | Branch | Targets | Item | Proves alone |
|---|---|---|---|---|
| C1 (bottom, only) | `codex/260905-v2-passthrough-3444` *(carry path only)* | `dev` | #3444 | A direct key-auth Responses provider that opts in with `allowEncryptedV2AgentTasks: true` forwards an opaque encrypted V2 sub-agent task byte-unchanged, while every other route (OAuth, Chat adapter, model-level Chat override, combo attempt) keeps the existing recovery or fail-closed behavior. |

### Ordering relative to the rest of lane 3

~~~
#3444  (Stack C — this doc)          <- lands FIRST
   |
   +-- #3447  (wp4, owns src/providers/quota.ts)
   |      |
   |      +-- #2783  (rebase onto #3447)
   |
   +-- #2973  (independent after #3444; 4 mechanical conflicts)

#2956  (DEFER — no ordering impact)
~~~

Rationale carried from the lane doc: #3444, #2783 and #2973 all add **distinct optional fields**
to `src/config.ts` / `src/types/provider.ts`. The overlap is additive, so the only real cost is
conflict-resolution surface; landing the smallest clean one first keeps every later resolution
single-file-at-a-time.

### Direct-merge candidates (not restacked)

#3444 is **already an open PR that merges clean** — the lane's local
`git merge-tree --write-tree origin/dev refs/pull/3444/head` returned exit 0 (tree `ed79a40e8`).
Under the campaign rule such an item is merged directly rather than restacked, **provided the
label path is viable**. §3.2 shows it is not, for a reason unrelated to sponsorship.

### Carried contributor work

The carry branch is created from the PR head, not retyped:

~~~
git fetch origin dev
git fetch origin +refs/pull/3444/head:refs/tmp/pr3444
git switch -c codex/260905-v2-passthrough-3444 origin/dev
git cherry-pick b487dc794ce72fffd1a5d2295ffbcd6a8ed10a81 baefb1334b69e1f37ae1446b6326ae09cb0021ac
~~~

Attribution trailer — the author's commit email was read from
`gh pr view 3444 --json commits` (`commits[].authors[].email`):

~~~
Co-authored-by: cb8010d6 <53855466+cb8010d6@users.noreply.github.com>
~~~

Both PR commits (`b487dc794`, `baefb1334`) carry that identical author identity, so one trailer
covers the carry. It must be in the **squash body or a branch commit**, per `AGENTS.md`
("Landing another author's work") and `.github/scripts/pr-carry-attribution.cjs`. Note that
`assessCarryAttribution` reads the PR *text*, not its diff (`pr-carry-attribution.cjs:20-22`):
a carry PR whose body says "carries #3444" without the trailer fails `hygiene` with
`missing_coauthor_credit`.

---

## 3. The item: #3444

### 3.0 State at plan time

| Field | Value |
|---|---|
| Head | `baefb1334b69e1f37ae1446b6326ae09cb0021ac` |
| Branch | `feat/direct-encrypted-v2-provider-passthrough` on fork `cb8010d6/opencodex` |
| `maintainerCanModify` | `true` |
| Author | `cb8010d6` (no push permission) |
| Base | `dev` |
| Labels | `enhancement`, `intake: hygiene-blocked` |
| Draft | yes |
| Merge-base | `2421e44ceb24b12666fad668923c6705d4a19ee1` — **42 behind / 2 ahead** of `6580694c7` |
| Blocking checks | `hygiene` (`unsponsored_surface`), `enforce-target` (readiness box 4) |

**42 behind is the number that decides the path.** See §3.2.

### 3.1 File change map

Six files. Current `origin/dev` lines quoted, then the target state.

#### (a) `src/types/provider.ts` — declare the field

Current, `src/types/provider.ts:268-278`:

~~~ts
  /**
   * Explicit opt-in for a relay that genuinely fronts OpenAI and can decode native
   * compaction blobs. Absent or false degrades foreign blobs to an opaque note.
   */
  decodesNativeCompactionBlobs?: boolean;
  /**
   * Explicit opt-in for non-registry private-network destinations such as localhost, RFC1918,
   * link-local, or unique-local upstreams. Metadata endpoints remain blocked.
   */
  allowPrivateNetwork?: boolean;
~~~

Target — insert between the two:

~~~ts
  decodesNativeCompactionBlobs?: boolean;
  /**
   * Trust this direct key-auth Responses provider to consume or relay opaque encrypted
   * V2 agent tasks. OpenCodex does not decrypt, translate, or recover an eligible task.
   * Absent or false keeps the existing recovery/fail-closed behavior.
   */
  allowEncryptedV2AgentTasks?: boolean;
  /**
   * Explicit opt-in for non-registry private-network destinations ...
   */
  allowPrivateNetwork?: boolean;
~~~

#### (b) `src/config.ts` — Zod schema row

Current, `src/config.ts:538-540`:

~~~ts
  preserveResponsesReasoningContent: z.boolean().optional(),
  decodesNativeCompactionBlobs: z.boolean().optional(),
  allowPrivateNetwork: z.boolean().optional(),
~~~

Target:

~~~ts
  decodesNativeCompactionBlobs: z.boolean().optional(),
  allowEncryptedV2AgentTasks: z.boolean().optional(),
  allowPrivateNetwork: z.boolean().optional(),
~~~

`.optional()` with no `.default()` is what makes the feature default-off at the
deserialization boundary.

#### (c) `src/server/auth-cors.ts` — field-policy row **(SECURITY BOUNDARY / the gate trigger)**

Current, `src/server/auth-cors.ts:785-787`:

~~~ts
  preserveResponsesReasoningContent: "editor",
  decodesNativeCompactionBlobs: "editor",
  allowPrivateNetwork: "editor",
~~~

Target — one line inserted after `decodesNativeCompactionBlobs`:

~~~ts
  allowEncryptedV2AgentTasks: "editor",
~~~

This row is **compiler-forced, not discretionary**: the map closes with
`} as const satisfies Record<keyof OcxProviderConfig, ProviderConfigFieldPolicy>;` at
`src/server/auth-cors.ts:870`. Verified by deleting the row from a PR-head scratch tree and
running `bun x tsc --noEmit`:

~~~
src/server/auth-cors.ts(870,12): error TS2741: Property 'allowEncryptedV2AgentTasks'
  is missing in type '{ ... }' but required in type
  'Record<keyof OcxProviderConfig, ProviderConfigFieldPolicy>'.
~~~

There is therefore **no version of this change that avoids touching `auth-cors.ts`**, which is
why the sponsorship gate cannot be engineered around and must be cleared by §3.2.

#### (d) `src/server/responses/core.ts` — the guard and its two call sites

**(d1) New predicate**, inserted after `unreadableEncryptedAgentTaskResponse()`, which currently
ends at `src/server/responses/core.ts:1759`:

~~~ts
/**
 * Keep this trust boundary deliberately narrow: only a key-auth Responses route may consume
 * opaque child-task ciphertext, and the model's final wire override must still be Responses.
 * Callers keep combo attempts on their existing native-only recovery/fail-closed behavior.
 */
function canPassThroughEncryptedV2AgentTask(
  route: RouteResult,
  inboundWire: InboundWire,
): boolean {
  const provider = route.provider;
  if (
    inboundWire !== "responses"
    || provider.allowEncryptedV2AgentTasks !== true
    || (provider.authMode ?? "key") !== "key"
  ) return false;

  return resolveWireProtocolOverride(
    route.providerName,
    route.modelId,
    provider,
    inboundWire,
  ).adapter === "openai-responses";
}
~~~

All four conjuncts are load-bearing. `authMode ?? "key"` matches the documented default at
`src/types/provider.ts:425`. `resolveWireProtocolOverride` (`src/server/adapter-resolve.ts:20`)
is what makes a **model-level** `modelAdapters` Chat override defeat a provider-level
`openai-responses` declaration — scenario A5 in §3.5.

**(d2) Recovery-skip call site.** Current, `src/server/responses/core.ts:3089-3097`:

~~~ts
  // Native fallback can consume ciphertext, so recover only after final route selection.
  if (
    inboundWire === "responses"
    &&
    threadSpawn
    && unreadableEncryptedAgentTask
    && agentTaskRecovery
    && !isCanonicalOpenAiForwardProvider(route.provider)
    && !options.comboAttempt
  ) {
~~~

Target — comment updated, one conjunct appended:

~~~ts
  // Native fallback and explicitly trusted direct Responses routes can consume ciphertext,
  // so recover only after final route selection.
  if (
    inboundWire === "responses"
    &&
    threadSpawn
    && unreadableEncryptedAgentTask
    && agentTaskRecovery
    && !isCanonicalOpenAiForwardProvider(route.provider)
    && !options.comboAttempt
    && !canPassThroughEncryptedV2AgentTask(route, inboundWire)
  ) {
~~~

**(d3) Fail-closed call site.** Current, `src/server/responses/core.ts:3221-3225`:

~~~ts
  // Encrypted child tasks may only reach the canonical native backend. This check
  // runs against the FINAL route so native-only fallback can rescue a routed primary.
  if (!isCanonicalOpenAiForwardProvider(route.provider) && unreadableEncryptedAgentTask) {
    return unreadableEncryptedAgentTaskResponse();
  }
~~~

Target:

~~~ts
  // Encrypted child tasks may reach the canonical native backend or an explicitly trusted
  // direct Responses route. This runs against the FINAL route so native-only fallback can
  // rescue an incompatible primary without weakening combo behavior.
  const finalRouteCanPassThroughEncryptedTask = !options.comboAttempt
    && canPassThroughEncryptedV2AgentTask(route, inboundWire);
  if (
    !isCanonicalOpenAiForwardProvider(route.provider)
    && !finalRouteCanPassThroughEncryptedTask
    && unreadableEncryptedAgentTask
  ) {
    return unreadableEncryptedAgentTaskResponse();
  }
~~~

The `!options.comboAttempt` conjunct is what keeps the combo path
(`src/server/responses/core.ts:2299-2313`, which returns `unreadableEncryptedAgentTaskResponse()`
when no target `canDecryptUnreadableAgentTask`) on its existing native-only behavior.
**Do not drop it during conflict resolution** — it is the difference between an opt-in on a
single named route and one that silently widens combo dispatch.

#### (e) `docs-site/src/content/docs/reference/configuration/providers.md` — one table row

Insert after the `responsesPath?` row (line 72 on dev; the PR adds at line 73):

| `allowEncryptedV2AgentTasks?` | `boolean` | Disabled by default. Trust a direct key-auth `openai-responses` provider to consume or relay opaque encrypted V2 sub-agent tasks unchanged. Eligible routes skip `agentTaskRecovery`; all other routes keep the existing recovery or fail-closed behavior. OpenCodex does not decrypt, translate, or recover tasks sent through this opt-in. |

#### (f) `tests/agent-task-recovery.test.ts` — +65 lines, two blocks

Inserted after the existing block ending at line 147. Content unchanged from the PR head;
RED/GREEN ledger in §3.4.

---

### 3.2 Conflict resolution recipe / path selection

There is **no merge conflict**. `git merge-tree --write-tree origin/dev refs/pull/3444/head`
returned exit 0 (lane doc, tree `ed79a40e8`), and the drift query at the top of this document
confirms none of the six files moved since. The 42-commit lag touches `src/config.ts`,
`src/types/provider.ts`, `src/server/responses/core.ts` and the docs file, but every hunk is
additive and lands in a different region. The conflict to resolve is **procedural**, and the two
candidate paths were evaluated against `.github/scripts/pr-sponsored-surface.cjs`:

~~~js
function assessSponsoredSurface({ authorHasPushPermission = false, changedFiles = [], labels = [] }) {
  if (authorHasPushPermission) return [];            // :75
  const restricted = changedFiles.filter(isRestrictedPath);
  if (restricted.length === 0) return [];            // :77
  if (hasSponsorship(labels)) return [];             // :78
  return [{ code: "unsponsored_surface", paths: restricted }];
}
~~~

`src/server/auth-cors.ts` is in `RESTRICTED_FILES` (`pr-sponsored-surface.cjs:44`), so exactly
three exits clear the gate. Removing the file from the diff is impossible (§3.1c), leaving:

| Path | Mechanism | Evidence | Cost |
|---|---|---|---|
| **P1 — label** | Maintainer applies `maintainer-sponsored`. `hasSponsorship` (`:60-64`) accepts a string or `{name}`; the label is in `HYGIENE_GATE_LABELS` (`pr-hygiene.cjs:259`) so `pr-hygiene.yml` wakes on `labeled`, and `enforce-pr-target.yml:43` wakes on it too. The label is auto-created if absent (`pr-hygiene.yml:89`). | `node --test .github/scripts/pr-sponsored-surface.test.cjs` → "passes once a maintainer sponsors it", exit 0 | Contributor keeps native authorship; **but** `enforce-target` still needs box 4, which only the author can tick (`enforce-pr-target.yml:912-914`: "The tickable checklist lives in the PR body, because only the PR author can edit it"). |
| **P2 — maintainer carry** | Maintainer opens a branch from the PR head. `authorHasPushPermission` is true (`pr-quality.cjs:88-90`: `admin`/`maintain`/`write`), so `assessSponsoredSurface` returns `[]` at `:75` and `checklistRequired` is false (`enforce-pr-target.yml:766-768`). | `node --test` → "exempts an author who can already push", exit 0 | Requires the `Co-authored-by` trailer; adds one PR to close out. |

**Selected: P2 (maintainer carry). P1 is the preferred fallback only if the contributor is
actively responding.**

The deciding evidence is not the sponsorship gate — both paths clear it — it is the **readiness
claim verifier**, which P1 cannot satisfy without contributor action:

- `readinessClaimViolations` (`.github/scripts/pr-quality-state.cjs:213-223`) pushes
  `"latest_dev"` when `behindBase > READINESS_LATEST_DEV_BEHIND_MAX`.
- `READINESS_LATEST_DEV_BEHIND_MAX = 10` (`pr-quality-state.cjs:26`).
- `behindBase` comes from `compareCommitsWithBasehead` (`enforce-pr-target.yml:580-587`).
- Measured: `git rev-list --count refs/tmp/pr3444..origin/dev` → **42**.

So even if the author ticks box 4 today, the gate unticks the "latest dev" box and holds the PR
in draft. **P1 requires the contributor to rebase onto `dev` *and* re-tick all four boxes**, and
every push resets the checklist again. P2 removes the checklist entirely
(`checklistRequired = !authorIsMaintainer`), and the maintainer's own review *is* the
sponsorship — the documented intent at `pr-sponsored-surface.cjs:20-22` ("A maintainer with push
permission is exempt because their own review is the sponsorship").

P2 is also what `AGENTS.md` anticipates here: `maintainerCanModify: true` makes the carry
mechanical, and the lane doc already flags the trailer as mandatory.

**P2 recipe — mechanical, no semantic resolution.** Branch creation is in §2. If either
cherry-pick reports a conflict (it should not — merge-tree is clean), the resolution for every
one of the six files is **take both sides**: all six hunks are pure insertions into lists or
tables. The single exception is `src/server/responses/core.ts` (d2)/(d3), where the rule is:
keep every conjunct `dev` has, and add the new one. Losing `!options.comboAttempt` at (d3) is
the only resolution error that would be semantically dangerous rather than merely wrong.

Then:

~~~
git commit --amend --no-edit --trailer "Co-authored-by: cb8010d6 <53855466+cb8010d6@users.noreply.github.com>"
git push --no-verify -u origin codex/260905-v2-passthrough-3444
~~~

`--no-verify` per the campaign constraint: the pre-push hook runs the forbidden suite.

### 3.3 Pre-merge checks (exact sequence)

Applies to whichever PR is merged — the carry PR under P2, or #3444 itself under P1.

1. **Refresh state immediately before acting.** `gh pr view <n> --json headRefOid,mergeable,mergeStateStatus,labels,isDraft,reviewDecision`. Record the head SHA; every later check is bound to it.
2. **Dismiss stale reviews.** #3444 carries `REVIEW_REQUIRED` and CodeRabbit was skipped as draft. Under P2 the carry PR is new, so nothing is stale; under P1 any `CHANGES_REQUESTED` predating the sponsorship label must be dismissed with a reason, not silently overridden.
3. **Mark ready.** P2: the maintainer PR opens ready (`checklistRequired` false). P1: the *author* ticks box 4 and the gate calls `markPullRequestReadyForReview` itself (`enforce-pr-target.yml:495`).
4. **Apply `maintainer-sponsored` if P1.** Not required under P2, but applying it anyway is harmless and makes the security review visible on the PR — the stated point of the gate (`pr-sponsored-surface.cjs:16-18`).
5. **Exact-head CI.** `gh pr checks <n>`, confirming each conclusion belongs to the recorded head SHA. Required green: `test 1/4`–`4/4`, `gates`, `storage policy`, `api usage`, `hygiene`, `enforce-target`. An **empty** `gh pr checks --required` output is not green evidence.
6. **Security-boundary review recorded.** Post the note in §5 as a PR comment.
7. **Admin squash merge**, bottom-up (single layer here). The `Protect dev` ruleset (id 20763889) permits merge and squash only; rebase merges are off (`MAINTAINERS.md`). The `maintain`/`admin` `pull_request` bypass is what allows merging without the second approval, and `MAINTAINERS.md` requires that use of the bypass be **recorded on the pull request**, not inferred from a merge timestamp. Confirm the squash body carries the `Co-authored-by` trailer *in the confirm dialog*, before merging.
8. **Landing proof.** `git fetch origin dev && git merge-base --is-ancestor <squash-sha> FETCH_HEAD` → exit 0.
9. **Close #3444** (P2) with a comment naming the carry PR and the squash SHA. PRs here target `dev`, so GitHub will not auto-close it (`AGENTS.md`, branch policy).

### 3.4 Regression tests

**File:** `tests/agent-task-recovery.test.ts`

| Test name | RED on dev? | Why |
|---|---|---|
| `trusted direct Responses routes bypass recovery and preserve encrypted tasks` | **YES — verified** | Dev has no `allowEncryptedV2AgentTasks` path, so the fail-closed check at `core.ts:3223` fires for the routed `relay` provider. Observed: `tests/agent-task-recovery.test.ts:177:31 — expect(response.status).toBe(200), Received: 400`. |
| `trusted passthrough stays fail closed for OAuth authentication` | no (passes on dev) | Guard test — dev fails closed everywhere, so it passes before and after. Protects the new opt-in from widening. |
| `trusted passthrough stays fail closed for a Chat Completions adapter` | no (passes on dev) | Same. |
| `trusted passthrough stays fail closed for a model-level Chat override` | no (passes on dev) | Same. |

**Ledger (executed in scratch trees outside the worktree, `node_modules` symlinked):**

| Tree | Result |
|---|---|
| dev source, dev tests | 19 pass / 0 fail |
| **dev source + PR test file** | **22 pass / 1 fail** ← RED proof |
| PR head (source + tests) | 23 pass / 0 fail ← GREEN proof |

The three `test.each` guard cases passing on dev is the **correct** shape for a trust-boundary
change and must not be mistaken for missing coverage: the RED test proves the feature works, and
the three GREEN-on-both tests prove the boundary did not move for anything else.

**Focused verifier commands:**

~~~
bun test tests/agent-task-recovery.test.ts
bun test tests/agent-task-recovery-combo.test.ts tests/v2-agent-message-failfast.test.ts tests/agent-task-recovery-security.test.ts
bun run typecheck
bun run privacy:scan
~~~

The second command covers the combo and fail-closed neighbours the change must not disturb; it
was run on dev and returned 40 pass / 0 fail, exit 0. `bun run test:changed` alone is
insufficient here — name the combo/failfast files explicitly rather than relying on the module
graph to select them.

### 3.5 Accept criteria — activation scenario per conditional path (C-ACTIVATION-GROUNDING-01)

| # | Condition | Activating scenario | Expected | Covered by |
|---|---|---|---|---|
| A1 | `inboundWire !== "responses"` | A Chat-wire inbound request to an opted-in provider. | predicate false → existing behavior | **No activating test.** Structurally unreachable at the (d2) site, which is already gated on `inboundWire === "responses"` (`core.ts:3091`); the conjunct is defence-in-depth for (d3). Accept as unverified-by-test **with this reason carried into the PR body**. |
| A2 | `allowEncryptedV2AgentTasks !== true` | Any provider without the opt-in — i.e. every existing config. | fail closed, HTTP 400 `unreadable_encrypted_agent_task` | The whole 19-test dev baseline, e.g. `leaves native encrypted passthrough unchanged`. |
| A3 | `(authMode ?? "key") !== "key"` | `providers.relay = { adapter: "openai-responses", authMode: "oauth", allowEncryptedV2AgentTasks: true }` | 400, `fetchCalls === 0` | `trusted passthrough stays fail closed for OAuth authentication` |
| A4 | resolved adapter !== `openai-responses` (provider-level) | `{ adapter: "openai-chat", allowEncryptedV2AgentTasks: true }` | 400, `fetchCalls === 0` | `... for a Chat Completions adapter` |
| A5 | resolved adapter !== `openai-responses` (**model override defeats provider level**) | `{ adapter: "openai-responses", modelAdapters: { "gpt-5.6-luna": "openai-chat" }, allowEncryptedV2AgentTasks: true }` | 400, `fetchCalls === 0` | `... for a model-level Chat override` — the case `resolveWireProtocolOverride` exists to catch |
| A6 | predicate **true**, provider-level Responses | `{ adapter: "openai-responses", authMode: "key", apiKey, allowEncryptedV2AgentTasks: true }` | 200; exactly 1 fetch; URL contains `relay.example.test` and not `chatgpt.com`; `forwardedInput` deep-equals the original ciphertext | `trusted direct Responses routes ...` (loop iteration 1) |
| A7 | predicate **true**, reached via a model override *up* to Responses | `{ adapter: "openai-chat", modelAdapters: { "gpt-5.6-luna": "openai-responses" }, ... }` | same as A6 | same test (loop iteration 2) |
| A8 | `options.comboAttempt === true` at (d3) | A combo target resolving to an opted-in provider. | `finalRouteCanPassThroughEncryptedTask` false → combo keeps native-only fail-closed | `fails closed after a single failed combo recovery pass` + `tests/agent-task-recovery-combo.test.ts` |
| A9 | `isCanonicalOpenAiForwardProvider(route.provider)` | The canonical ChatGPT backend route. | unchanged native passthrough; opt-in never consulted | `allows the canonical ChatGPT route to forward the encrypted task` (`tests/v2-agent-message-failfast.test.ts`) |
| A10 | `agentTaskRecovery` configured **and** opt-in set | `routedConfig()` (recovery enabled) + opted-in relay | recovery **skipped**, ciphertext forwarded unchanged — this is (d2) | `trusted direct Responses routes ...` uses `routedConfig()` with recovery **on**, which is precisely what makes it exercise (d2) and not only (d3) |

### 3.6 docs-site sync

- **English source — required, already in the diff:** `docs-site/src/content/docs/reference/configuration/providers.md:73`.
- **Locales — not required, do not add.** Seven locale copies exist (`fr`, `ja`, `ko`, `ru`, `tr`, `zh-cn`, `zh-tw`) and each already lags the English table. `AGENTS.md` requires only that translated locales not *contradict* the English source; an absent row does not contradict. Machine-translated rows would exceed scope.
- **`agents.md` cross-reference — optional.** `docs-site/src/content/docs/reference/configuration/agents.md:125-137` presents `agentTaskRecovery` as *the* compatibility path for encrypted v2 tasks. One sentence noting that `allowEncryptedV2AgentTasks` is the opposite disposition (forward rather than recover) would stop an operator reading them as alternatives to the same problem. Safe as a follow-up: docs are not a `BEHAVIOR_PREFIX` (`pr-hygiene.cjs:73-75`), so a docs-only PR does not owe a regression test.
- **`structure/` — no change.** `structure/04_transports-and-sidecars.md:245` documents `decodesNativeCompactionBlobs` because that flag participates in the compaction-blob decision; this field touches no transport invariant.

---

### 3.7 PR title / body skeleton

**Title (P2 carry)** — keep the contributor's original verbatim:

~~~
feat(providers): allow direct encrypted V2 task passthrough
~~~

Do not put a carry verb in the title; `CARRY_VERB_RE` (`pr-carry-attribution.cjs:24-25`) scans
title and body, and while the trailer satisfies it either way, keeping the declaration in the
body alone is tidier.

**Body:**

~~~md
## Summary

- Add a default-off `allowEncryptedV2AgentTasks` provider option for direct key-auth
  `openai-responses` routes.
- Skip `agentTaskRecovery` only when the selected model's final wire override is still
  Responses, then forward the opaque encrypted task byte-unchanged.
- Keep canonical ChatGPT forwarding, combo attempts, OAuth/forward/local providers, and every
  non-opted route on the existing recovery or fail-closed path.

Carries #3444 by @cb8010d6 onto current `dev`. The fork branch was 42 commits behind, so the
contributor readiness checklist could not be completed against a current head.

The one-line `src/server/auth-cors.ts` change adds the new non-secret boolean to the
exhaustive `PROVIDER_CONFIG_FIELD_POLICY` table as editor-editable. It is compiler-forced by
the `satisfies Record<keyof OcxProviderConfig, ...>` constraint at auth-cors.ts:870 and
changes no authentication or CORS behavior. No GUI change.

### Stack

| Layer | PR | Base | Status |
|---|---|---|---|
| C1 (bottom, only) | this PR | `dev` | ready |

Lane 3 ordering: this lands before #3447, #2783 and #2973, which add distinct optional fields
to the same schema objects.

## Verification

- `bun test tests/agent-task-recovery.test.ts` — 23 pass / 0 fail
  (RED on dev without the source change: 22 pass / 1 fail at line 177)
- `bun test tests/agent-task-recovery-combo.test.ts tests/v2-agent-message-failfast.test.ts
  tests/agent-task-recovery-security.test.ts` — 40 pass / 0 fail
- `bun run typecheck`
- `bun run privacy:scan`
- `cd docs-site && bun run build`

The `inboundWire !== "responses"` conjunct in `canPassThroughEncryptedV2AgentTask` has no
activating test: the recovery call site is already gated on `inboundWire === "responses"`, so
the conjunct is defence-in-depth for the second call site.

## Checklist

- [x] Scope stays focused and avoids unrelated cleanup.
- [x] Docs or release notes were updated when needed.
- [x] Security-sensitive changes were reviewed for secrets, auth, and unsafe defaults.

Closes #3444

Co-authored-by: cb8010d6 <53855466+cb8010d6@users.noreply.github.com>
~~~

`Closes #3444` will not auto-close: this PR targets `dev`, and GitHub auto-closes only on the
default branch (`main`). Close #3444 manually after the squash lands.

---

## 4. Field / enum chain

One new config field: `allowEncryptedV2AgentTasks: boolean | undefined`. No new enum, no GUI
surface (the dashboard renders editor fields generically).

| Stage | Location | Behavior |
|---|---|---|
| **Type declaration** | `src/types/provider.ts`, new, after `decodesNativeCompactionBlobs` (:272) | `allowEncryptedV2AgentTasks?: boolean` on `OcxProviderConfig`. Optional — absence *is* the default-off state. |
| **Creation (operator, file)** | `providers.<name>.allowEncryptedV2AgentTasks` in the config file | Hand-written, or written by the dashboard. |
| **Creation (operator, API)** | `POST`/`PATCH /api/providers` | Accepted **because** of the policy row: `PROVIDER_CONFIG_FIELD_SET` (`auth-cors.ts:913`) is built from the policy map's keys, and `parseProviderEditorConfig` (`auth-cors.ts:974-982`) rejects any field outside that set as `invalid_provider_editor_field`. |
| **Deserialization** | `src/config.ts` `providerConfigSchema`, new row after :539 | `z.boolean().optional()`. No `.default()`, no `.nullish()` — unlike `upstreamHttpVersion` (:544-546) this field has no "clear to null" API contract, so a literal `null` on disk is a schema error. Matches `decodesNativeCompactionBlobs` and `allowPrivateNetwork` immediately around it. |
| **Serialization / redaction** | `src/server/auth-cors.ts:787`, policy `"editor"` | `"editor"` means: not in `REDACTED_PROVIDER_FIELDS` (:879-881), not in `RUNTIME_PROVIDER_FIELDS` (:882-884), therefore not in `PROVIDER_EDITOR_DENIED_FIELDS` (:895-898) — so `providerEditorProviderDTO` (:926-929) emits it to the dashboard unredacted. Correct: a non-secret boolean. |
| **Consumer** | `src/server/responses/core.ts`, `canPassThroughEncryptedV2AgentTask` (new, after :1759) | Read as `provider.allowEncryptedV2AgentTasks !== true`. **Strict `!== true`, not a falsy check** — a hand-edited `"true"` string does not activate the trust boundary. |
| **Registry default** | **none — deliberately** | Contrast `preserveResponsesReasoningContent`, which carries a registry seed (`src/providers/registry.ts:257,1978`) merged in `src/router.ts:403-404` and `src/providers/derive.ts:538`. This field has **no registry path**, so no built-in preset can turn it on; only an explicit operator opt-in can. That is the right default for a trust boundary and must be preserved if the field is ever extended. |

---

## 5. Risk, rollback, and the security boundary

### Security-boundary classification — REQUIRED REVIEW

`src/server/auth-cors.ts` is:

- in `RESTRICTED_FILES` (`.github/scripts/pr-sponsored-surface.cjs:44`);
- owned by both maintainers in `.github/CODEOWNERS` under "Authentication, credentials, and management API" (`/src/server/auth-cors.ts @lidge-jun @Ingwannu`);
- covered by `MAINTAINERS.md`: "Authentication, credential handling, GitHub Actions, release automation, dependency installation, and other security-boundary changes require explicit security review", plus "Security-sensitive and release-related changes should be reviewed by both maintainers when practical."

**MAINTAINERS.md exception needed:** the `maintain`/`admin` `pull_request` bypass on the
`Protect dev` ruleset, used to squash-merge without the second approving review. `MAINTAINERS.md`
is explicit that this is "a bypass, not an exemption" and that "an owner who uses the bypass
should record it on the pull request rather than leave it to be inferred from a merge timestamp."
**Post that record as a PR comment before merging**, naming the reviewed surface. Under P1 the
`maintainer-sponsored` label is a second, separate requirement; under P2 it is optional but
recommended as a visible marker.

### Security review note to record on the PR

> Security-boundary review — `src/server/auth-cors.ts`. The change is a single row in
> `PROVIDER_CONFIG_FIELD_POLICY` classifying a new non-secret boolean as `"editor"`. It is
> compiler-forced: the map closes with
> `satisfies Record<keyof OcxProviderConfig, ProviderConfigFieldPolicy>` (auth-cors.ts:870), and
> omitting the row fails `bun run typecheck` with TS2741. It adds nothing to
> `REDACTED_PROVIDER_FIELDS` and removes nothing; no credential, token, or secret becomes
> readable or writable through the management API that was not already. No CORS origin, no auth
> mode, and no session check is touched.
>
> The runtime trust boundary lives in `src/server/responses/core.ts` and is narrow by
> construction: passthrough requires the inbound wire to be Responses, an explicit provider
> opt-in (strict `!== true`), `authMode` resolving to `key`, and the model's **final** resolved
> wire override still being `openai-responses`. Default is off, with no registry seed, so no
> built-in preset can enable it. OpenCodex neither decrypts nor translates the task — the
> ciphertext is forwarded byte-unchanged, asserted by `expect(forwardedInput).toEqual(input)`.
> Nothing logs the task; `bun run privacy:scan` is green.
>
> Combo dispatch is explicitly excluded via `!options.comboAttempt`, so the native-only
> fail-closed path at core.ts:2299-2313 is unchanged.

### Risk register

| Risk | Likelihood | Impact | Mitigation / rollback |
|---|---|---|---|
| Conflict resolution silently drops `!options.comboAttempt` at (d3) | low | **high** — would widen the opt-in into combo dispatch | `tests/agent-task-recovery-combo.test.ts` and `fails closed after a single failed combo recovery pass` are the tripwire; both are in verifier V2. |
| Operator enables the flag on a relay that cannot actually consume V2 ciphertext | medium | medium — the child task fails upstream instead of being recovered locally | Documented default-off with an explicit caveat in the docs row. No code mitigation is possible or desirable: this is the operator's declared trust. |
| The field is later given a registry default | low | high — would silently enable a trust boundary for preset users | Recorded in §4 as a deliberate absence; any future registry seed is a security-boundary change in its own right. |
| `maintainer-sponsored` applied without an actual review | low | high — defeats the gate's purpose | The review note above is the artifact; §3.3 step 6 makes posting it a merge precondition. |
| Carry lands without the `Co-authored-by` trailer | medium | medium — contributor becomes invisible and `CREDITS.md` grows | `hygiene` fails with `missing_coauthor_credit` before merge; §3.3 step 7 re-checks the squash body at the confirm dialog. |

### Rollback

Single squash commit, one layer, no migration and no persisted-state change. Rollback is
`git revert <squash-sha>` via a PR into `dev`. The one non-inert consequence: an operator who
had set the flag would see the key rejected by `providerConfigSchema` after the revert — call
that out in any revert PR.

---

## 6. Out of scope / deferred (this family)

- **#3447 (Antigravity weekly + Ollama Cloud quota)** — deferred to **wp4**: merges clean under rename detection, but `fetchAntigravityQuota` still adds a direct `fetch` of `${config.baseUrl}/v1internal:retrieveUserQuotaSummary` carrying `Authorization: Bearer` with no `providerRedirectError` check, while the neighbouring `fetchAntigravityUsageQuota` pins `ANTIGRAVITY_ACCOUNT_QUOTA_BASE` correctly; the config-route regression test is missing.
- **#2783 (author's own PR)** — deferred to **wp4** and must land after #3447: all three maintainer blockers are still literally present at head, and it conflicts with #3447 on `src/providers/quota.ts`.
- **#2973** — deferred to **wp5**: every substantive blocker is verified fixed at head, leaving only 152-commit staleness and four mechanical conflicts; independent of #3444 apart from additive `src/config.ts` overlap.
- **#2956 (usage stats)** — **DEFER, no landing planned**: 474 commits behind, zero human review, no test/typecheck matrix evidence on any head, and four real conflicts including two semantic ones in `src/usage/summary.ts` and `src/server/management/logs-usage-routes.ts`.
- **Locale docs rows for `allowEncryptedV2AgentTasks`** — out of scope: the seven locale provider tables already lag the English source, and an absent row does not contradict it.
- **Hardening the pre-existing dev-side `fetchAvailableModels` bearer path** (`src/providers/quota.ts:2371-2382`) — out of scope for lane 3: it predates every PR here and is a separate security-boundary change.
- **Widening `RESTRICTED_FILES` or adjusting the sponsorship gate** — out of scope: the gate behaved exactly as designed on #3444, and the conservatism that cannot distinguish a policy-table row from a real auth change is the intended trade (`pr-sponsored-surface.cjs:14-22`).

---

## 7. Method notes

- `origin/dev` re-fetched at plan time: `6580694c7`. The drift query over all six changed files returned empty.
- PR head fetched locally as `refs/tmp/pr3444` = `baefb1334b69e1f37ae1446b6326ae09cb0021ac`; `git rev-list --count` confirms 2 ahead / 42 behind, merge-base `2421e44ce`.
- RED/GREEN established by running the suite in three scratch trees under `/private/tmp` (`git archive` plus a symlinked `node_modules`), not by trusting the PR body. Exact failure line captured: `tests/agent-task-recovery.test.ts:177:31`.
- The `auth-cors.ts` row's compiler-forced status was proven by deleting it from a scratch PR-head tree and observing TS2741 at line 870.
- `node --test .github/scripts/pr-sponsored-surface.test.cjs` was run to confirm both gate exits (label, push-permission) behave as read.
- No files under `src/`, `tests/`, or `gui/` in the worktree were modified; all scratch trees live outside it.
- `git merge-tree --write-tree` could not be re-run in this sandbox (`unable to create temporary file: Operation not permitted` — the shared git dir is not writable here). The clean-merge result is carried from the lane doc and cross-checked by the empty drift query, which is the stronger evidence for these six files.

