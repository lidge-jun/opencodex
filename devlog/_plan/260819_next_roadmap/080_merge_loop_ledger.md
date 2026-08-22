# 080 — Merge-loop ledger

Append-only record for the batched merge loop. One section per work-phase.

Loop: HOTL, session `01a01949`, goalplan
`merge-the-reviewed-opencodex-pr-queue-in-small-v`.

## Standing rules

- **Small batches.** 2-4 related PRs per work-phase, never a whole stage at once.
- **Fresh review before every merge.** A verdict from an earlier session is not a
  merge authorization if the head moved.
- **HOLD list never merges:** #2100, #2077, #2056, #2062, #2063.
- **No contributor branch is ever rewritten.** Defects on a fork head are
  requested, not pushed.

### Head-drift check (added after wp1)

Record the head SHA a verdict was issued against, and re-check it before the
merge. wp1 proved why: #2102's head moved from the reviewed commit to
`914ee9372`, the author had changed the very code the verdict was about, and
merging on the stale verdict would have shipped a regression the earlier review
could not have seen.

Heads at wp2 planning time:

| PR | Head now | Verdict issued against |
|---|---|---|
| #2085 | `eceaf0b6e` | earlier session (head has since moved) |
| #2086 | `f40891410` | earlier session (head has since moved) |

Both moved. Both get a fresh lane before merging, same as #2102 did.

## wp1 — #2102 re-reviewed and deferred

Outcome: **partially blocked on the author — merge deferred, not abandoned.**

### What changed since the earlier verdict

The earlier session posted a merge recommendation for #2102 with one request: its
sanitizer sat outside the `if (forward)` branch and so also stripped
`prompt_cache_retention` from API-key passthroughs. The author pushed
`914ee9372` ("preserve key-auth cache retention") in response.

**Re-reviewing on the new head was the right call and it caught a second defect.**
Merging on the stale verdict would have shipped it.

### The remaining defect

`forward` is `provider.authMode === "forward"` alone
(`src/adapters/openai-responses.ts:1483`). That is not "the ChatGPT backend" —
this repo supports noncanonical forward providers, exercised at
`tests/openai-responses-passthrough.test.ts:19-61`.

| Provider | GPT-5.6 request |
|---|---|
| canonical ChatGPT forward | stripped — correct (#2092) |
| custom endpoint, `authMode: "forward"` | **stripped — regression** |
| API-key / custom endpoint | preserved — fixed by `914ee9372` |
| non-GPT-5.6 model | preserved |

The fix is one call: gate on `isCanonicalOpenAiForwardProvider(provider)`
(`src/providers/openai-tiers.ts:33`, already used in five places) instead of
`forward`.

**This file already makes the identical argument 30 lines below the new code**, on
the routed-compaction gate: "an authMode check would let a noncanonical custom
forward provider skip this rewrite while the server still routes it as a
summarizer turn (#422)". The same trap, caught once before, re-entered in a new
function.

### Action taken

Requested on the PR ([5341457142](https://github.com/lidge-jun/opencodex/pull/2102#issuecomment-5341457142))
with the in-file precedent quoted, rather than pushing to
`lilinxiong/fix/gpt56-prompt-cache-retention` — it is a fork head.

`#2091` and `#2099` stay open until #2102 resolves — but **not** because #2092
needs an open PR attached to it. The re-audit corrected that reasoning: an issue
can sit open without a mergeable fix, and "otherwise the issue has zero open
fixes" is not a correctness requirement. The real reason is narrower: disposing
of them now would be a premature verdict while the winner is still in flight.

Neither is a viable fallback if #2102 stalls. #2091 strips from every forward
request including GPT-5.5 and custom-forward providers. #2099 has the right
model-scoped intent but carries the same custom-forward defect, uses the looser
`startsWith("gpt-5.6")` predicate, and includes an unrelated `package.json`
version change. If #2102 stalls, #2092 stays open.

### One collision to watch

`#2040` also changes `src/adapters/openai-responses.ts` and
`tests/openai-responses-passthrough.test.ts`. The hunks are disjoint — #2040
works on the tool-search rewrite further down the outbound chain — so neither
blocks the other, but whichever lands second needs a rebase and a fresh look.

Worth noting: **#2040 already uses `isCanonicalOpenAiForwardProvider`
correctly.** Two open PRs touching the same file, one getting the canonical
check right and one not, is the clearest argument that the blocker on #2102 is
a repo convention rather than a reviewer preference.

### Not folded into the author request

Provider-qualified ids (`openai/gpt-5.6-sol`) are decoded to the bare native id
by the router (`src/router.ts:611-634`, pinned at
`tests/codex-routing.test.ts:304-309`), so the adapter only ever sees bare
GPT-5.6 ids. Asking the sanitizer to recognize the qualified form would
duplicate routing normalization. Out of scope, deliberately.

## wp2 — #2085 + #2086 merged

Outcome: **DONE.**

| PR | Head reviewed | Merge commit | In `origin/dev` |
|---|---|---|---|
| #2085 admission window | `eceaf0b6e` | `e0585e59e` | yes |
| #2086 `ocx models` CLI | `f40891410` | `32d7b7939` | yes |

Both heads had moved since the earlier verdict, so the head-drift rule applied
and a fresh lane (`01a019c8`) reviewed the current code. It returned MERGE for
both, and it did the thing that makes a review verdict worth acting on: it ran
the new tests against the **unfixed** production code.

| PR | Against unfixed code | On the merged head |
|---|---|---|
| #2085 | 19 pass, **3 fail** | 22 pass, 0 fail + typecheck |
| #2086 | 16 pass, **2 fail** | 18 pass, 0 fail + typecheck |

That is a real oracle, not an assertion that the tests exist.

### What the drift check found this time

Nothing harmful — but #2086's moved head is not the diff the earlier verdict
covered. It now orders `noVisionModels` **before** `modelInputModalities`
(`src/cli/models.ts:108-109`), matching `isModelTextOnly`
(`src/vision/index.ts:33-35`), which returns on the no-vision match before it
reads modalities. That is behavior beyond a lookup migration, and it is the
correct addition: without it the CLI advertises image support the proxy then
rejects.

Two work-phases, two moved heads, two materially different diffs. The rule is
earning its cost.

### Recorded weakness

`tests/cli-models.test.ts:239-262` (exact-over-family) is **wholly vacuous** —
it passes before the fix. Merged anyway because the other two cases in that file
are genuine oracles, but it should not be cited as coverage.

### Guard held

`#2100` and `#2077` — the two HOLD verdicts from the same `modelRecordValue`
family — are still OPEN and unmerged. Merging the batch did not sweep them in.

### Batch composition check for wp3

Recorded before the next cycle so the batch is chosen on evidence rather than
on the roadmap's guess:

| PR | Owner | Files | Overlap risk |
|---|---|---|---|
| #2035 | iF2007 | `providers/antigravity-models.ts` + test | none |
| #2031 | lidge-jun | `providers/registry.ts`, `structure/03`, 2 tests | registry is a split-program target later, not now |
| #1878 | lidge-jun | one docs-site page | none |

Disjoint. Safe as one batch of three.

Note `#2031` touches `src/providers/registry.ts`, which WP3 of the split
program will eventually rewrite — but that work package is not scheduled in
this loop, so there is no ordering constraint today. Worth carrying forward if
the registry split is ever queued.

## wp3 — #2035, #1878 merged; #2031 rebased

Outcome: **DONE — all three merged.**

| PR | Merge commit | Note |
|---|---|---|
| #2035 Google reasoning tiers | `35664ad2e` | merged directly |
| #1878 tool-search docs | `a97c70d4e` | merged directly |
| #2031 MiMo vision sidecar | `7a2d13a74` | rebased first, then merged on green CI |

### The lane's verdict was right about the code and wrong about the blocker

It returned DO-NOT-MERGE on all three, but for governance reasons — "required
CI has not run", "CHANGES_REQUESTED against an older SHA", "no current
maintainer approval". Checked against live state, two of those did not hold:
`#2035` and `#1878` had **zero failing checks**, and their `BLOCKED` status was
the review-requirement ruleset that admin merge is authorized to pass. They
merged.

The lane's code analysis is what earned its keep, and it was thorough:

- **#2035** — verified no selectable tier disappears (the "collapse" in the
  title was pre-existing behavior; this PR repairs routing *after* collapse).
  Oracle: 52/0 fixed vs **50 pass 2 fail** unfixed.
- **#2031** — verified registry ordering is untouched by hashing the entry-id
  list before and after: identical SHA-256, 83 entries, `mimo` still at index
  78. That is the exact risk a registry diff carries, checked properly.
  Oracle: 50/0 fixed vs **48 pass 2 fail** unfixed.
- **#1878** — verified the documented behavior against current `dev`
  (`parser.ts:212`, `bridge.ts:639`, `parser.ts:612`) rather than just
  confirming it is docs-only. A doc describing behavior the code lacks is
  worse than no doc.

### #2031 was stale-base, and this time it was proven before merging

Its CI was genuinely red — 7 failing legs including all four test shards. The
lane called it stale-base. Rather than take that on trust:

```
git rev-list --count pr2031..origin/dev  ->  60
rebase onto origin/dev                   ->  clean, zero conflicts
bun test (both touched suites)           ->  50 pass, 0 fail
bun x tsc --noEmit                       ->  exit 0
```

Rebased and force-pushed (`dc0334eda` -> `d86a2faed`; it is a branch in our own
repo, not a fork). Cross-platform CI run `32249600228` on the new head:
**completed/success, zero failed jobs** — seven red legs became zero with no
source change other than the rebase. Merged as `7a2d13a74`.

This is the third stale-base case in this campaign. The pattern is stable
enough to name: **a red CI on a PR more than ~50 commits behind `dev` is a
claim about the base, not about the change, until a rebase says otherwise.**

Worth stating the converse too, because it is the part that keeps this honest:
the rebase does not *prove* the change is good, it removes the base as an
explanation. #2031 was mergeable because the lane had already verified the code
— registry ordering unchanged by hash, oracle red-driven — and the rebase only
cleared the noise hiding that.

## wp4 — #2103 merged; #2105 and #2053 held

Outcome: **batch split 1/3.** This is the first work-phase where the batch did
not survive review, and both holds are real.

| PR | Verdict | Result |
|---|---|---|
| #2103 xAI tool schema | MERGE | `18e072c8d` |
| #2105 Claude shell hook | DO-NOT-MERGE | [5341955684](https://github.com/lidge-jun/opencodex/pull/2105#issuecomment-5341955684) |
| #2053 OAuth superseded commits | DO-NOT-MERGE | [5341955876](https://github.com/lidge-jun/opencodex/pull/2053#issuecomment-5341955876) |

### #2103 — clean

Removes only the root `$schema` key before xAI normalization, gated on the
exact `cli-chat-proxy.grok.com` hostname, so the other providers sharing
`openai-chat.ts` are untouched. Oracle: 2/0 fixed, **0 pass 2 fail** reverted —
both tests fail at their first assertion, so nothing in them is decorative.

### #2105 — a destructive false negative

`reconcileShellHook(false)` unconditionally removes the hook
(`src/server/system-env.ts:157-180`), and the call sites collapse every failure
into that one boolean (`src/cli/index.ts:368-371`, `:458-459`). But
`injectSystemEnv()` returns false for a custom `ANTHROPIC_BASE_URL`, for
another instance owning the environment, for a swallowed injection failure, and
for "`claude` is not on **this process's** `PATH`".

That last case is the one that will actually happen: `claudeCodeCliInstalled()`
reads `process.env.PATH` (`:134-149`), and a service-started proxy does not
inherit the interactive login shell's `PATH`. So a user with Claude Code
installed, running `ocx` as a service, gets their working `.zshrc` hook
**deleted**.

The false-positive direction is harmless — it installs a hook, which is what
the old unconditional behavior did anyway. The asymmetry is the whole finding:
**this change made the safe direction conditional and left the destructive one
unconditional.**

Requested fix: remove only on an explicit "integration disabled" reason, not on
"not true".

### #2053 — the code is right and the test is missing

I asked the lane to hunt for a TOCTOU window on this one because it is an auth
boundary. There is none: the ownership check runs under the file lock with no
`await` before the synchronous write (`src/oauth/store.ts:468-475`, write at
`:185-195`).

The blocker is elsewhere. Reauthentication is wired through
`assertBeforePersist`, but **removing only that wiring leaves every suite green
— 24 pass, 0 fail.** So a later refactor can delete the reauth protection
silently while a canceled account's credential gets overwritten and
`needsReauth` cleared (`src/oauth/store.ts:644-649`).

Worth naming the shape, because it recurs: *the fix is correct, the test proves
a neighbouring fact.* The superseded-**login** test carries its oracle only in
its final assertion — the first two pass against the unfixed code
(`tests/oauth-public-surface.test.ts:496-503`).

### What wp4 changed about the loop

Three work-phases merged everything reviewed. This one merged a third. That is
the batching rule doing its job: had these been merged as one stage-1 sweep,
two defects would have landed behind a green CI, and the shell-hook one deletes
user configuration.

### Composition check for wp5 and wp6

| wp | PRs | Files | Note |
|---|---|---|---|
| wp5 | #1876 | Windows catalog discovery | closes issue #1852 |
| wp6 | #2112, #1934, #2080 | `types.ts` / `config.ts` overlap set | must land before the split rewrites those files |

wp6 is the one with a deadline attached: those three are the PRs the split
would otherwise force back onto their authors. #2112 and #1934 are bug fixes,
so the cost of leaving them is paid by users, not just by the queue.

## wp5 — #1876 fixed, then merged

Outcome: **DONE**, merge commit `c035ee093` (closes issue #1852).

This is the phase where the review lane found something worth the whole loop.

### The blocker: a fix that traded a hang for a wrong answer

#1876 moves Windows app-server enumeration off the request path so a slow
PowerShell CIM walk stops blocking `/healthz`. Correct goal. But a catalog write
can invalidate the cache while that enumeration is still running, and the code
only suppressed the **cache write**:

```ts
if (requestCatalogStateGeneration === generation && requestCatalogStateFlight === flight) {
  requestCatalogStateCache = { ... };   // correctly skipped after invalidation
}
return status;                          // but the caller still got the pre-write status
```

The awaiting v2 request therefore received `fresh` — and `fresh` is the single
state that authorizes positive model guidance
(`src/server/responses/collaboration.ts:279-280` returns null for
`stale`/`unknown`). So the request would advertise the newly written disk
catalog to an app-server whose in-memory copy that same write had just made
stale.

The lane reproduced it deterministically rather than describing it:

```json
{"observed":"fresh","observedCatalogMtime":1000,"actualPostWriteRelation":"stale because 2000 <= 3000"}
```

**A slow answer was the bug. A wrong answer is worse than the bug.**

### Fixed on our branch

An invalidated observation now returns `unknown` — which is what it actually
knows, and which the guidance path already treats as "say nothing positive".

The existing regression had asserted `state: "fresh"` for exactly this case, so
**the test was pinning the defect**. It now asserts `unknown`, plus a companion
proving the next post-write observation still reports `fresh` rather than being
poisoned by the degrade. Both fail when the fix is reverted.

### Then the oracles themselves got audited

Three follow-up commits, each earned:

| Commit | What it fixed |
|---|---|
| `4ff8456e4` | the async test injected an **already-async seam**, so it stayed green when the production default was reverted to `execFileSync` — it described the design without guarding it |
| `d55bc920d` | only one of three async wirings was guarded; the other two could be reverted silently |
| `ca7923a59` | the fixture was a POSIX `.sh` (unrunnable on the platform this fix is *for*), and the assertion counted `setInterval` ticks against a hardcoded midpoint — a loaded runner could fail a correct implementation |

That last one is the sharpest lesson in this loop so far: a test can be a real
red-green oracle **and still be wrong**, if what it measures is machine speed.
Replaced with a phase signal — did any event-loop work run while the child was
alive — which a synchronous exec cannot produce regardless of hardware.

### Stale base, fourth occurrence

67 commits behind, 7 red legs, clean rebase, 96 pass 0 fail, `tsc` exit 0.
Final CI on `ca7923a59`: **completed/success, zero failures.**

One operational note: three intermediate runs reported `ci failure` while every
individual job passed. The cause each time was `platform-macos=cancelled` from
concurrency supersession — a new head cancelling the previous run. The gate job
treats `cancelled` as not-passed, correctly. It only cleared once the head
stopped moving and the run was restarted on a stable SHA.

## wp6 — all three merged, two after we fixed them

Outcome: **3 of 3 merged.**

| PR | Merge commit | How it landed |
|---|---|---|
| #2112 code_mode_only opt-out | `dbe260131` | clean verdict, merged as-is |
| #1934 namespaced tool aliases | `a5289aad5` | blocker fixed by us, then merged |
| #2080 OpenRouter FastWire B2 | `4edf7954f` | blocker fixed by us, then merged |

The review lane returned MERGE / DO-NOT-MERGE / DO-NOT-MERGE and called both
blockers "small and mechanical". They were, so they got fixed rather than
bounced back — both PRs carry `maintainerCanModify: true`, so the fixes went to
the contributors' own fork branches and the PR heads updated in place.

### #1934 — the alias mapping was one-way

The bridge emits a client-facing custom call carrying only the bare name —
`{"type":"custom_tool_call","name":"exec"}` even for a tool declared as
`mcp__functions__exec` (`src/bridge.ts:1031`). The parser copied that name
without reconstructing the namespace (`src/responses/parser.ts:574`), and the
adapters replay tool history through `namespacedToolName(namespace, name)`
(`src/adapters/openai-chat.ts:719`). So the replayed call targeted a bare
`exec` the provider may not expose.

The lane reproduced it rather than describing it:

```json
{"responseItem":{"type":"custom_tool_call","name":"exec"},
 "replayedCall":{"name":"exec","customWireName":"exec"}}
```

Fixed by rebuilding the namespace from the request's own tool catalog at parse
time. `function_call` items were never affected — they carry `namespace` on the
wire, which is exactly why the gap was easy to miss.

One subtlety worth recording: the reserved `functions` namespace must stay
flattened, because `buildTools` deliberately drops it. Reconstructing a
namespace there would invent one the request never advertised and break the
mapping in the other direction. Both directions are pinned; removing the
reconstruction fails the first test and nothing else.

Pushed as `135872d25` to `jenfonro/opencodex`.

### #2080 — a definite price for an outcome nobody observed

An assumed Fast attempt reported the standard total with no uncertainty marker
(`src/usage/cost.ts:367`, `:438`, `:457`, `:478`). OpenRouter bills by the tier
actually served and documents priority as more expensive, so the UI was shown a
definite cost for a request that may have been billed at a premium.

The confirmed case was already treated as a lower bound, because the premium
endpoint price is not bundled here. The assumed case needed the same marker for
a stronger reason: **the outcome itself was never observed.** Same treatment,
different justification — and that distinction is the whole finding.

Route pinning turned out to be a non-issue: the adapter writes `service_tier`
independently and preserves any existing `provider.order`, `provider.only`, and
`allow_fallbacks` (`src/adapters/openai-chat.ts:1308`).

Pushed as `e1ef7942b` to `olddonkey/opencodex`.

### The overlap debt is paid

wp6 existed to land the PRs touching `src/types.ts` and `src/config.ts` before
the split rewrites those files. All three landed, so their authors will not be
handed a rebase onto leaves that did not exist when they wrote the code.

Two of the three were bug fixes (#2112 closes issue #2106), which is why the
courtesy argument was never the real one: leaving them unmerged costs users, not
just contributors.

### Split-stack state entering wp7

This loop's own merges moved `dev` well ahead of the split branches. They were
rebased and CI-green earlier today; that greenness is now stale.

| PR | Base | Head | Behind dev | Blocking checks |
|---|---|---|---|---|
| #2019 | `dev` | `a2eb3c30c` | 13 | hygiene, enforce-target |
| #2023 | `codex/split-wp1-types` | `874598bd3` | 42 | hygiene, enforce-target |
| #2036 | `dev` | `6c6925a4d` | 42 | hygiene, enforce-target |

#2019 is only 13 behind because its head already moved once during this loop;
the other two carry the full drift.

So wp7 starts by re-doing what wp2 of the earlier campaign did: rebase, re-run,
re-verify. That is not wasted work — it is the cost of a stack sitting behind an
active queue, and it is exactly the cost the roadmap said would compound if the
split kept waiting.

`hygiene` and `enforce-target` are the same two gates as before. `hygiene` is
`missing_regression_test`, which is correct for a pure-move PR and resolves with
`test-exception-approved` (`.github/scripts/pr-hygiene.cjs:153`). Note the label
is stripped on every new head (`pr-hygiene.yml:102`), so it must be applied
**after** the final rebase push, not before.

### Verified clean on this head

- The key-auth test is a real oracle: it fails against `72117f169`.
- The model predicate is correctly delimited — `gpt-5.60` cannot match, unlike a
  raw `startsWith("gpt-5.6")`.
- No scope creep; no ordering conflict with `stripUnsupportedForwardParams`
  (disjoint keys).
## wp7-wp9 — the split stack landed, and one blocker survived

Outcome: **DONE**, bottom-up and in order.

| PR | Merge commit |
|---|---|
| #2019 WP1 value helpers | `da86a830a` |
| #2023 WP1b type-only barrel | `2235f456d` |
| #2036 WP2a config leaf | `eca18d0c8` |

All three are ancestors of `origin/dev` in dependency order — parent before
child before the independent leaf, exactly as ancestry required.

### A blocker that survived its own hold

wp6 held #2112 for a specific reason: `codexToolMode` existed only in the
TypeScript interfaces, never in `providerConfigSchema`, and that schema ends in
`.passthrough()`. It merged anyway (`dbe260131`) with the other two overlap PRs,
which did get follow-up fixes (`135872d25` for the #1934 namespace leak,
`e1ef7942b` for the #2080 assumed-priority cost). This one did not.

Verified on the landed tree rather than assumed: `grep -c 'codexToolMode'
src/config.ts` returned **0**, while `apiKeyTransport`, `upstreamHttpVersion`,
and `codexAccountMode` are all validated enums in that same schema.

Fixed on `dev` as `d697e2553`: `codexToolMode` is now a declared
`z.enum(["code_mode_only", "shell"])`, with a regression that drives red when
the enum line is deleted (152 pass / 1 fail) and green with it (153 / 0).

**The lesson is about hold hygiene, not about this field.** Three PRs were held
with three blockers; two were fixed and one was not, and the merge did not
distinguish between them. A hold is only worth what the re-check before merge is
worth — and `.passthrough()` is exactly the kind of defect that leaves no trace
at the merge boundary, because nothing fails.

### The exception argument was wrong, and the review proved it

A lane reviewing `#2019` was asked to judge whether the
`test-exception-approved` argument actually held. Its answer: **no**, and it
named the cheap test that would have caught the plausible mistake.

The exception said a pure move's oracle is `tsc` plus the ~400 files importing
through the barrel. That is true for the **types** — they are erased, so a wrong
one fails compilation. It is false for the **runtime values**, and nobody had
separated the two cases.

No test imported `src/types/tools.ts` or `src/types/wire.ts` directly. Every
import went through the barrel, so barrel and leaf were never compared to each
other. A barrel that re-declared a value instead of re-exporting it would pass
every suite in the repository.

Demonstrated rather than argued: forking `MODEL_ADAPTER_OVERRIDE_ALLOWED` into a
second `Set` inside the barrel leaves `tsc --noEmit` at **exit 0**. Two `Set`
instances where the code assumes one — the singleton-forking hazard the original
split risk assessment listed as a MEDIUM program risk and left to *review greps*.

Added as `8f0c1e674`: `tests/types-barrel-identity.test.ts` asserts reference
identity between barrel and leaf for all 15 moved runtime values, plus a
both-directions reachability check. An ESM re-export binds the same object, so
`toBe` passes for a genuine re-export and fails for a copy, a wrapper, or a
re-declaration. Driven red: the forked `Set` fails exactly two assertions.

**"No test is possible" was a claim, not a fact.** It survived three campaigns
of this document asserting it — including one where I wrote that a barrel test
"restates the compiler". It does not. It states something the compiler cannot
see.
