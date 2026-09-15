# wp3 — regression audit of v2.55.0..dev

## Method

Seven `gpt-5.6-sol` subagents at medium reasoning effort, dispatched in parallel, one per slice.
Each reads committed objects (`git show <sha>:<path>`, `git diff <sha>^ <sha>`) rather than the
working tree, because the tree was being rebased concurrently for wp2. None runs tests: the local
suite is forbidden for this unit, so the instrument is source reading and the verdict is stated as
CLEAN / RISK / REGRESSION with file and line.

## Slices

| Slice | Target |
| --- | --- |
| core.ts facade split | `485a525aa9` — export surface, moved guards, duplicated module state, import cycles, the synchronous activation window. |
| server/index.ts facade split | `a63a47363f` — `labActivationRequired` gate, synchronous `startServer`, slot registration order. |
| bridge.ts facade split | `11f1119718` — export surface, SSE assembly, usage accounting, shared watchdog state. |
| reasoning summary fix | `369be813c4` — in-place mutation of stored/replayed items, scope, coverage. |
| test-side changes | `3ea88f3db8`, `89bc67353c` — is the new guard vacuous; is the destructive-home path fully closed. |
| #4683 itself | the gate allowlist and the 24h retention, attacked rather than confirmed. |
| release readiness | version agreement, stale doc references, `scripts/release.ts` and `release.yml` expectations, unowned `src/` areas. |

## Findings

Recorded as they return; a REGRESSION blocks wp4, a RISK is either fixed or accepted with a reason
written here.

- bridge.ts facade split (`11f1119718`): **CLEAN**. Facade re-exports all six symbols; SSE, JSON
  builders and the error formatter are byte-identical; the watchdog state remains a single live
  module binding consumed by `src/bridge/sse.ts`; error, incomplete, EOF, stall and cancellation
  paths unchanged.

- core.ts facade split (`485a525aa9`): **CLEAN**. All prior exports present; 23 runtime helpers and
  two interfaces AST-identical; combo execution differs only by injected dispatcher wiring; replay
  gates intact in `request-prepare.ts`; mutable adapter/retry/continuation state still shared
  through accessors; no reverse cycle, no duplicated module state.
- server/index.ts facade split (`a63a47363f`): **CLEAN**. `startServer` still synchronous, Lab
  still behind `labActivationRequired` and activated before return, slot registration synchronous,
  startup side-effect order and facade exports preserved.
- reasoning summary fix (`369be813c4`): **CLEAN**. Builds a new input array and clones changed
  items before adding `summary`, so cached and replayed objects are not mutated; existing
  summaries and opaque blobs untouched; scope limited to Responses serialization and native
  compact forwarding; regression coverage exists.
- test-side changes (`3ea88f3db8`, `89bc67353c`): **RISK, accepted**. The #4681 fix itself is
  sound — the quota test now pins and deletes only its own temporary home. Two guards have
  false-negative gaps: the lab synchrony scan stops at direct `startServer` callees, so an async
  `installLabAutomationRuntime` would pass, and the destructive-home guard matches only same-line
  `rmSync(getConfigDir())` forms. Neither is a runtime regression and neither is new in this
  range, so they do not block 2.56.0; they are follow-up hardening.
- #4683 (`4e548b693c`): **RISK, fixed**. The original allowlist let kiro, cursor and devin accept
  a delta after a replay miss. Verified in source that all three rebuild the conversation from the
  request they are handed — devin sends `mapOcxMessagesToDevin(parsed)` every turn, cursor's
  `checkpointRef` is read from the store that just expired and otherwise falls back to
  `full-replay`, kiro rebuilds `conversationState.history` from the parsed turns. The allowlist is
  now empty and the four-wire refusal is pinned by test. The 24h retention adds no unbounded path:
  the 1000-entry, 64 MiB resident and 1 GiB spill ceilings still bind, oldest-first.
- release readiness: **RISK, folded into the plan**. `release.yml` refuses to publish while
  `dev` does not outrank the release version, so the `dev-version-bump` pre-move is a required
  step and is now written into `030_release.md`. Separately, `docs-site` architecture pages and
  `structure/runtime.md` still describe the pre-split ownership; that is documentation drift
  across locales, not a runtime regression, and is tracked as follow-up rather than a release
  blocker.

## WebSocket idle timeout — why the TTL does the work

A codex-rs client caches its `WebsocketSession` across turns and chains `previous_response_id`
onto it, clearing that chain only when it finds the socket closed. This proxy sets
`WEBSOCKET_IDLE_TIMEOUT_SECONDS = 0`, so the socket never closes on its own and the client's own
recovery never fires. Closing the socket instead of refusing the turn was considered and rejected:
Bun refuses a websocket `idleTimeout` above 960 seconds (measured, not inferred), so "close after
an hour" is not expressible as a serve option; one value covers every socket kind including the
live sideband relay; and it would not help HTTP clients, a restarted proxy, or an entry evicted
early by the byte caps. The refusal path covers all of those uniformly, so the timeout stays 0 and
the coupling is recorded where the constant lives, with
`tests/responses/ws-endpoint.test.ts` holding the pair together.

## Round 2 — the frozen range, audited from this worktree

Round 1 ran before #4683 landed and against a range that had no frozen endpoint. Round 2 audits
the nine commits enumerated in `000_roadmap.md` against the candidate `2702911708`, from a managed
worktree so the auditors read a tree nobody is editing underneath them. Same instrument as round 1:
parallel `gpt-5.6-sol` subagents at medium reasoning effort, reading committed objects, running no
tests.

The weight is deliberately on the three facade splits and on the final tree they produce together.
Each split was landed as behaviour-preserving, and each was reviewed alone; what no single review
covered is the tree that results from all three plus the new module #4683 added. That is the slice
that exists because a per-commit-clean range can still end in a broken tree.

### Round 2 findings

#### Round 2 slices

| Slice | Target | Why it exists |
| --- | --- | --- |
| S1 | `11f1119718` bridge split | SSE assembly, usage accounting, shared watchdog state, export surface. |
| S2 | `a63a47363f` server/index split | Synchronous `startServer`, `labActivationRequired` gate, slot registration order. |
| S3 | `485a525aa9` core.ts split | The largest split, on the hottest request path; moved guards and module state. |
| S4 | `369be813c4`, `3ea88f3db8`, `89bc67353c` | The three small commits: in-place mutation, a possibly vacuous guard, a destructive test path. |
| S5 | `4bef58bf82`, `2046e684ed` | Devlog-only claim, checked against the packaging and CI path filters. |
| S6 | `2702911708` as landed | The squash equals the reviewed head, and the change re-attacked on the landed tree. |
| S7 | final tree | The invariants all three splits could break TOGETHER: lab-boundary import graph, the synchronous activation window, cycles, duplicated module state. |
| S8 | release surface | Packaging allowlist, workflow permissions, action refs, and test integrity — deleted, skipped or weakened tests and regenerated baselines across the range. |

S7 is the slice this round exists for. Each split was reviewed alone and each looked clean alone;
nothing has yet read the tree they produce together, which is the tree being released.

#### The range was wrong, and why that matters

Round 2 opened against a nine-commit range. A reviewer round on the audit plan rejected it: the
merge-base between `main` and the candidate did not exist and `369be813c4` appeared to be a
parentless root commit. Both were artifacts of a **shallow clone** — `git rev-parse
--is-shallow-repository` returned `true` and `.git/shallow` held the graft list. The nine commits
were simply the ones that survived the graft.

After `git fetch --unshallow`, the real release delta is **59 commits, 290 files, +66,064 /
-43,948**, with merge-base `62f02223a0`. The nine-commit table in `000_roadmap.md` described the
tail of the range, not the range.

This is worth recording beyond this release. Every claim of the form "we audited every commit from
main" is only as good as the clone it was computed in, and a shallow clone answers that question
wrongly without erroring. The check is one command and it now belongs at the front of any release
audit.

The corrected range is dominated by god-file decompositions across three rounds — `config.ts`,
`openai-responses.ts`, the `openai-chat` adapter, `provider-fetch`, the codex auth management API,
the provider registry table, state and shim, routing and quota, inject and catalog sync, then
`bridge.ts`, `server/index.ts` and `responses/core.ts` — plus the #4546 send-budget, spend-ledger
and identity/lineage work. Several splits are followed by their own repair commits
(`ce51b3eb07`, `48abcfbff5`, `e874436065`, `e443f58e8a`), which is the pattern a release audit
should be least willing to take on trust: a repair that silenced the symptom is not evidence that
the split dropped nothing else.

#### Round 2, wave 2 slices

| Slice | Target |
| --- | --- |
| W1 | `9b711073ab` openai-responses.ts split |
| W2 | `90aeffa702` openai-chat split, `47b1879af9` provider-fetch split |
| W3 | `0c745bd825` codex auth API split, `ee9f4df7b1` provider registry table split |
| W4 | `d2d35e02e2` config.ts split and its import-depth repair |
| W5 | `913e0d071f`, `ce51b3eb07`, `c63e9ea676`, `e874436065` state/shim/inject/catalog-sync and repairs |
| W6 | `35969857f2`, `48abcfbff5` routing/quota split and repair |
| W7 | #4546 send-budget and spend-ledger family, eight commits |
| W8 | #4546 identity, lineage and continuation-ownership family, four commits |
| W9 | the guards themselves: ratchet, import-resolution, version line |
| W10 | release surface over the true range, including the packaging allowlist for every new leaf |
| W11 | cross-facade behavioural wiring at the final tree, four traced end-to-end paths |

W10 carries a failure mode nothing else would catch: a facade that imports a leaf which the
published package does not ship passes every test in CI and breaks every install.

### Round 2 verdicts

Nineteen slices returned, run on `gpt-5.6-sol` and, after sol began refusing parallel fan-out with
429s, paired 1:1 onto `xai/grok-4.6`. Coverage is every commit in the frozen range plus four
whole-tree slices.

**The twelve god-file decompositions are clean.** That is the headline, and it is the claim this
round existed to disprove.

| Slice | Target | Verdict |
| --- | --- | --- |
| S1 | `bridge.ts` split | CLEAN — six exports preserved, SSE/JSON/error bodies byte-identical, watchdog timeout a single live binding. |
| S2 | `server/index.ts` split | CLEAN — `startServer` still synchronous, Lab still behind `labActivationRequired`, 55 exports identical, registration in the same turn as `Bun.serve`. |
| S3 | `responses/core.ts` split | CLEAN — 31 exports identical, all 13 module-level state declarations have exactly one owner, 1,246 modules walked with no new cycle touching the split. |
| C1 | `openai-responses.ts`, `openai-chat`, `provider-fetch` splits | CLEAN — declaration parity 83/83, 73/73, 104/104; catalog timeout, abort and retry preserved; dedupe and memo maps single-owned. |
| G-W3 | codex auth API, provider registry table | CLEAN — 39 facade exports and all 24 route pairs survive; tokens stay inside `withResetCreditAuth`; 93 registry rows with matching flag checksums. |
| G-W4 | `config.ts` split | CLEAN — export surface, lock and atomic-write semantics, and all five schema defaults unchanged; the one wrong import depth was `routing/active-account` and nothing else in `src/`. |
| G-W5 | state, shim, inject, catalog-sync and their repairs | CLEAN — the splits did drop bindings; the repairs restored the complete set. Eight wrong-module or missing symbols enumerated and confirmed restored. |
| G-W6 | routing and quota split and its repair | CLEAN — 118/134 and 136/139 function bodies byte-identical, the rest accessor-wrapped; every cooldown, affinity and quota table has one owner. |
| G-S7 | final-tree state duplication | CLEAN — full owner/mutator inventory across every facade in the range; no binding with two declaration sites, no re-export copying a value instead of the live binding. |
| S5 | the two devlog commits | CLEAN — devlog only, excluded from the package allowlist and the CI path filters. |
| S6 | #4683 as landed | CLEAN — the interdiff against the reviewed head is only this plan unit. |

**Two real regressions, both in the #4546 work rather than in any split.**

1. `ce0ac617da` leaks a charged send permit on a pre-dispatch failure. `reserveCredentialHop()`
   charges immediately; the generic-OAuth 429 ladder releases it on its two explicit early-outs but
   its `catch` does not, so a throw from `failoverAccountSnapshot()` or snapshot application
   consumes an allowance for a send that never happened, and a later recovery in the same request
   can be refused because of it. Both loops have it:
   `src/server/responses/adapter-dispatch.ts` and `src/server/responses/adapter-continuation.ts`.
   The fix is not a blanket release in the `catch`: the dispatch loop's `try` also wraps
   `rebuildAndRefetch`, which really does send, so the pre-dispatch part has to be separated.
2. `c3106e3eed` lets a successful reauthentication inherit the failed credential's cooldown.
   `src/codex/pool-refresh-backoff.ts` keys cooldowns by account id with no credential generation,
   and `login-flow.ts` clears quota and reauth state but not the refresh-failure record, so a
   freshly authenticated account stays excluded from selection for 15-60 seconds. With a healthy
   sibling the thread detours and loses its warm cache and continuation. This worked immediately
   before that commit.

**Risks recorded and accepted, none of them a runtime regression.**

- The file-size ratchet dropped six former god-files from its cap list when they fell under the
  2,000-line threshold, so `src/codex/routing.ts` can grow 373 lines and `src/responses/state.ts`
  628 before the gate says anything — while facades that were lowered in place cannot. The same
  baseline also raised caps for three test files that grew, and eleven of the twelve
  `GENERATED_PATHS` exemptions are hand-written files, including the `en.ts` i18n catalogue that
  calls itself the source of truth.
- The lab synchrony guard stops one hop after `startServer`, and the destructive-home guard matches
  only single-line `rmSync(getConfigDir())` forms. Both would stay green on a future reintroduction.
- The durable spend ledger has no production caller: `admitWorkflowTurn()` is invoked without the
  `spend` argument, so no reservation reaches the journal and the ceilings remain process-local.
  The feature is incomplete rather than broken.
- Adapter and runTurn paths report send-budget exhaustion as `502 upstream_error` while the
  passthrough path returns `429 request_send_budget_exhausted`, and the continuation 429 loop does
  not consult `sendBudgetExhausted()`. Both predate this range.
- An account change scrubs `previous_response_id` and `conversation` but not uploaded `file_id`
  references, although the same module classifies those as non-portable. Also pre-existing.

**What this audit cannot discharge.** Source reading cannot prove the candidate typechecks, builds,
or behaves under real streaming, cancellation, replay and concurrency. That residual is carried by
hosted CI at the exact release SHA, and by the focused guard files run locally on the candidate:
the lab-boundary import graph, every relative import under `src` and `gui/src` resolving, the
responses core-module inventory, the test layout, structure SSOT and the ratchet — 138 assertions,
all passing.

### Coverage: every commit in the frozen range, and the slice that read it

Criterion 2 says each commit in `1cc89cf88c..2702911708` carries a recorded verdict. This is that
mapping, so the claim can be checked rather than believed. Merge commits are covered by the slice
that owns the lane they merged; devlog and plan commits are covered by S5's rule that a devlog-only
diff touches nothing in the build, test, packaging or workflow path, which was verified against the
package allowlist and the CI path filters rather than assumed.

| Commits | Slice |
| --- | --- |
| `2702911708` | S6 |
| `2046e684ed`, `4bef58bf82`, `ca00b7e33e`, `8301dcb900`, `d97f740f73`, `db6b9f2ed3`, `f2dd9dd622`, `4f788f916e`, `7b7648e17a` | S5 (devlog/plan only) |
| `485a525aa9` | S3 |
| `a63a47363f` | S2 |
| `11f1119718` | S1 |
| `9b711073ab`, `90aeffa702`, `47b1879af9` | C1 |
| `369be813c4`, `3ea88f3db8`, `89bc67353c` | S4 |
| `d2d35e02e2`, `e443f58e8a` | G-W4 |
| `913e0d071f`, `ce51b3eb07`, `c63e9ea676`, `e874436065` | G-W5 |
| `35969857f2`, `48abcfbff5` | G-W6 |
| `0c745bd825`, `ee9f4df7b1` | G-W3 |
| `d5585a021a`, `8caf0a5126`, `a223a25d3b`, `00f1762d03`, `627274b8f5`, `ce0ac617da`, `836511b9c4`, `49dcdbf535` | W7 |
| `68951a16c1`, `38a2d9fb84`, `2b43c14c03`, `c3106e3eed` | W8 |
| `45fca0ad62`, `f5a8a44094`, `0eab3851a5`, `626b0f932c` | G-W9 |
| `aa91958e3b`, `09067c586a`, `9eb6290367`, `a90a99a521`, `16869805d6`, `90e7c23175`, `55cd467401`, `571cbe2d0e`, `f9e2ee077c`, `ccb7454a2d`, `60d935f888`, `cf1099577a`, `a6c6e29018`, `a6eb03b82e` | merges into the lanes their slices own; `571cbe2d0e` additionally read by G-W9 for the baseline reseed and by G-W6 for the issuer map |
| whole tree at `2702911708` | S7/G-S7 (state duplication), G-W11 (behavioural wiring), S8 (release surface, test integrity) |

The release-surface slice adds one result worth stating separately, because it is the failure mode
that no test would catch: all 125 source files this range adds are covered by the `src` entry in the
package allowlist, so no facade imports a leaf the published package would omit.

### What the audit changed on dev

Two regressions fixed, and one of the accepted risks closed because it was cheap to close.

- The generic-OAuth 429 ladder now hands its reservation back when nothing was sent.
  `src/server/responses/adapter-dispatch.ts` confirms the permit immediately before the rebuild
  that spends it and releases in its `catch`; since `release()` is a no-op once used, that one
  catch covers both a pre-dispatch throw and a throw from the send itself.
  `src/server/responses/adapter-continuation.ts` only releases, because its replay happens on the
  next loop iteration and confirming before `continue` would charge a hop that never ran. This is
  the shape `run-turn-execution.ts` already had.
- A replacement credential no longer inherits the dead one's quarantine:
  `src/codex/auth-api/login-flow.ts` clears the refresh-failure record where it replaces the
  credential, beside the quota and needs-reauth clears that were already there. The store already
  cleared on a successful refresh and on deletion; replacement was the missing case. Keying the
  cooldown by account id alone stays latent — a stale in-flight refresh of the old generation can
  still record a failure after the clear — and is left for a generation-fencing change rather than
  widened here.
- The file-size ratchet gets its six former god-files back at their current sizes
  (`src/codex/routing.ts` 1626, `src/responses/state.ts` 1371, `src/codex/shim.ts` 1246,
  `src/codex/inject.ts` 987, `src/providers/quota.ts` 558, `src/codex/catalog/sync.ts` 52). They
  had been dropped from the cap list when they fell under the 2,000-line threshold, so the files
  this whole decomposition programme exists to shrink were the only ones free to grow back.

The remaining accepted risks are unchanged: two guards with false-negative shapes, eleven
hand-written files exempted as "generated", the unwired spend ledger, the adapter path reporting
budget exhaustion as a 502, and the file-only account-change scrub. None is a regression in this
range, and each is written down here rather than carried silently into the release.

### The fix itself needed a second round

The release-decision review caught that the first permit fix moved the leak rather than closing it.
Confirming the hop with `use()` immediately before `rebuildAndRefetch` looked right, but that
function returns `{ failed }` when `buildRequest` throws — a request-shaping failure that never
reaches the wire — and the outer `catch` never sees it, so the charge stayed for a send that never
happened.

The hop is now confirmed by a callback the rebuild invokes at its own dispatch boundary, after the
request is shaped and immediately before `noteAttemptSend`, and the `{ failed }` arm releases:
a no-op when the boundary was reached, a refund when the rebuild died before it. That boundary is
also the honest place to name, because it is the line where "we are about to send" becomes true.

Two residuals stay recorded rather than closed. The permit guards are source oracles: they pin the
control flow at the boundary, not the budget arithmetic under an injected failure, because
exercising that path needs a rotation fixture with a throwing snapshot fetch. And the cooldown fix
has a source oracle for the caller plus a unit case for the store, where an integration test
through the existing mock OAuth harness could assert eligibility directly after a reauthentication.

### Closing the cooldown race rather than accepting it

The release-decision review also pointed out that clearing on replacement is mitigation, not
elimination: a refresh flight already in the air when the reauthentication lands still fails
afterwards, and its late report would re-quarantine the credential that replaced the one it was
about. Relative to 2.55.0, which had no cooldown at all, that is a new user-visible exclusion, so
it is fixed rather than written down.

`clearCodexPoolRefreshFailure` now bumps a per-account fence, a refresh flight captures that fence
before it settles, and a failure reporting a stale fence is dropped. A failure of the NEW credential
still counts, so the bound the cooldown exists to enforce is unchanged. `clearAllCodexPoolRefreshFailures`
deliberately does not bump: it is the coarse reset the routing layer performs when it discards
per-account state, and a later genuine failure should still count against the account.

### Third round on the same fix

An interdiff audit of the shipping tree — not the tree the audit started from — found the boundary
was still one step too early. `onDispatch` fired before `waitForProviderRequestSlot`, and that wait
rejects for an abort, a saturated queue, an expired slot or a removed provider without ever calling
the adapter. Since `release()` is a no-op once used, neither the `{ failed }` arm nor the catch
could refund that no-send case.

The hop is now confirmed at the two places that actually reach the wire: after the pacing wait and
immediately before `fetchResponse`, and inside the retry thunk immediately before
`fetchWithHeaderTimeout`. The guard pins both orderings rather than the single textual placement it
pinned before, which is what let the earlier version pass.

The same audit recorded one High finding that is **not** from this change and is accepted with the
others: the hop reservation and the adapter's own budget can both charge one physical replay,
because the hop is not handed down through `pendingHopPermit` the way the passthrough ladder does
it, and Kiro reserves again immediately before its send. That is the same #4546 accounting
incompleteness already listed above, it predates this range's fix, and closing it means threading
the permit through the adapter boundary rather than widening this patch.
