# Phase 2 — one kernel, and the generic kind consumes its persisted settings

Base: the phase-1 layer. Branch: `codex/pool-shared-kernel`, PR base
`codex/pool-manual-selection`. Same lane-L3 precondition as phase 1.

## Thesis

Extract the rotation primitives into a credential-neutral kernel, then make the
generic OAuth kind actually consume the `strategy` and `autoSwitchThreshold` it
already persists.

## Availability and the slice this cycle can actually take

Re-verified at the wp2 P entry against `origin/dev`. The lane partition for the
round in flight does not list `src/oauth/generic-account-failover.ts`,
`src/oauth/pool-settings-capability.ts` or `src/codex/pool-rotation.ts`, so the
kernel extraction and the generic-kind strategy work are available now. Two things
are not:

- `src/codex/routing.ts` is owned by lane L3, so the Codex-side import swap waits.
- `src/server/responses/core.ts` is owned by lane L1 and is the most contended
  file in the round with four open PRs, which is also why the wp4b call-site
  wiring could not follow #4277 immediately.

This cycle takes the kernel, the Anthropic import swap and the generic consumer.
Only the CODEX import swap is deferred, and it is deferred for free: once
`pool-rotation.ts` re-exports the kernel, `src/codex/` keeps its existing import
path and needs no edit at all. So the contended files stay out of this PR without
the kernel being an orphan.

Two kinds of change are moving here and they carry different risk, which is why
only one of them is behind the flag:

- **Relocation** is behaviour-preserving. Moving the state and primitives into
  `pool-kernel.ts` and re-exporting them changes no selection outcome, so it is
  not flagged. `git` history and a green existing suite are its proof.
- **Behaviour** is flagged. The generic kind consuming `strategy` and
  `autoSwitchThreshold`, and the DTO reporting `inert: false`, only happen when
  `pool.kernel` is on. Flag off restores today's outcomes exactly, because the
  pre-kernel path is the same code reached through the shim.

Anchors confirmed present on `origin/dev`: `selectPriorityTier` :86,
`pickRoundRobinAccount` :189, `notePoolRotationSuccess` :213,
`seedPoolRotationAccount` :245, `reconcilePoolRotationState` :260 in
`pool-rotation.ts`; `preferredInitialAccount` :246 and the
`rankAccountsByHeadroom` import :19 in `generic-account-failover.ts`.

## Current behaviour (verified on dd9a2906b)

The primitives already take an opaque `poolKey`, so a third key is addable:

```
src/codex/pool-rotation.ts
  4-5  POOL_KEY_CODEX = "codex"; POOL_KEY_ANTHROPIC = "anthropic";
  13   const selectionState = new Map<string, SelectionState>();
  86   selectPriorityTier(ids, priorityOf, hasHeadroom, pinnedId?)
  189  pickRoundRobinAccount(poolKey: string, eligibleIds, stickyLimit)
  201  peekRoundRobinAccount(...)
  213  notePoolRotationSuccess(poolKey, accountId, stickyLimit)
  232  notePoolRotationFailure(poolKey, accountId)
  245  seedPoolRotationAccount(poolKey, accountId)
  270  reconcilePoolRotationState  // only sweeps "anthropic", "codex", "codex:*"
```

Fill-first is duplicated rather than shared: `pickFillFirstCodexAccount`
(`routing.ts:1370`) and `pickFillFirstAnthropicAccount`
(`anthropic-routing.ts:513`).

`src/oauth/generic-account-failover.ts` imports nothing from `pool-rotation.ts`.
It keeps its own cooldown `health` map (`:64-70`, keyed `provider\0accountId`),
rotates on 429 through `rankAccountsByHeadroom` (`:178-218`) and steers the first
attempt through `preferredInitialAccount` (`:246-292`) when
`oauthAccountFailover.enabled`. It never reads `failover.strategy` or
`autoSwitchThreshold`.

`src/oauth/pool-settings-capability.ts` returns `"codex" | "anthropic" | "generic"`
and stamps `inert: true` on the generic DTO (`:40-54`, `:57-67`).
`src/server/management/oauth-account-routes.ts:395-396` still rejects
`stickyLimit` and `quotaWindow` for the generic kind.

## Change surface

NEW `src/oauth/pool-kernel.ts`
- move the WHOLE private `selectionState` map together with
  `pickRoundRobinAccount`, `peekRoundRobinAccount`, `seedPoolRotationAccount`,
  `notePoolRotationSuccess`, `notePoolRotationFailure`, `clearPoolRotationState`,
  `selectPriorityTier`, the priority parsers, `POOL_KEY_*` and the strategy and
  sticky normalizers. Moving a function subset while leaving the map behind would
  split one piece of state across two modules.
- the move is safe: `pool-rotation.ts` imports only two TYPES,
  `OcxAccountPoolRotationStrategy` from `../types` and `GenerationContext` from
  `../lib/state-store-sweeper`. Neither creates a cycle into `src/oauth`.
- add `genericPoolKey(provider) => \`generic:\${provider}\``
- add a fill-first helper with the signature
  `pickFillFirst(ids, afterId, hasHeadroom, stableAll)`. The earlier three-argument
  shape was rejected by the audit: both existing copies walk a STABLE FULL roster
  and not the eligible subset, so dropping `stableAll` changes the wrap order
  whenever an ineligible id sits between two eligible ones.
- extend the reconcile sweep to `generic:*`. `buildGenerationContext` already fills
  `oauthAccountKeys` from `listLiveOAuthAccountKeys` as `provider\0id` for every
  live OAuth provider, so the sweep needs no new field and no Codex dependency;
  today those keys are simply skipped as `valid === null`.

NOT moved, deliberately: the Codex fill-first copy in `src/codex/routing.ts` stays
where it is. Deleting it is the only thing that would force an edit to a file lane
L3 owns, and the audit flagged that as a blocker against this unit's own freeze.
Only `anthropic-routing.ts` and the generic kind switch to the kernel helper, and
the Anthropic caller keeps its weekly `exhausted5h` pre-filter rather than pushing
that rule into the shared helper.

MODIFY `src/codex/pool-rotation.ts` — re-export the kernel so existing importers
and `tests/codex-integration/codex-pool-rotation.test.ts` keep working unchanged.

MODIFY `src/oauth/generic-account-failover.ts` — branch BOTH paths on strategy, not
just the proactive one. `preferredInitialAccount` currently no-ops when the active
account is healthy and requires `hasHeadroomEvidence`, and the 429 path always ends
in `rankAccountsByHeadroom`; leaving either unbranched keeps the strategy inert in
practice even after the DTO says otherwise. `quota` keeps
`rankAccountsByHeadroom`, `round-robin` calls
`pickRoundRobinAccount(genericPoolKey(name), ...)`, and `fill-first` uses the
kernel helper with `autoSwitchThreshold` as its headroom test. Keep the presence
quorum, the `EXCLUDED_PROVIDERS` guard and the per-provider `health` cooldown.

MODIFY `src/server/management/oauth-account-routes.ts` — a manual account selection
must seed the cursor, or the operator's pick immediately loses to sticky
round-robin. Today that PUT calls only `forgetGenericFailoverRoster`, which clears
the presence cache and not the rotation state. Add
`seedPoolRotationAccount(genericPoolKey(provider), accountId)` beside it, mirroring
what `resetAnthropicRoutingForManualSelection` already does for Anthropic.
`clearGenericFailoverHealth` is the wrong map and `clearPoolRotationState` wipes
where seeding is wanted.

MODIFY `src/oauth/pool-settings-capability.ts` — report `inert` from the flag rather
than as a type literal. While `pool.kernel` is off the generic DTO must keep saying
`inert: true`, because nothing consumes the strategy yet and the reversibility rule
below requires the old behaviour to be exactly restorable. The literal becomes a
computed field and only turns false once the kernel is on.

Known readers of that field, all of which move in the same PR:
`src/cli/account-extended.ts` (forces generic auto-switch inactive),
`tests/server/account-pool-management-api.test.ts` and
`tests/cli/cli-account-pool-verbs.test.ts`. The GUI does not read it.
Also lift the `stickyLimit` rejection at `oauth-account-routes.ts:395` and update
`src/types/provider.ts:512-518` comments.

MODIFY `src/oauth/anthropic-routing.ts` — import from the kernel. `src/codex/`
keeps importing `./pool-rotation`, which is now a re-export, so this layer needs
no edit inside lane L3's files at all. The audit confirmed the shim is sufficient:
`routing.ts`, `auth-api.ts`, `account-priority.ts` and
`state-store-registrations.ts` all keep their existing import path.

## Reversibility (audit blocker, mandatory)

1. **Flag.** `pool.kernel` defaults to `false`. With it off, Codex and Anthropic
   take the pre-kernel code path and the generic kind keeps reporting `inert`.
2. **Dual-read.** The kernel reads the already-persisted keys without rewriting
   them: `accountPoolStrategy`, `accountPoolStickyLimit`, `autoSwitchThreshold`,
   `anthropicAccountPool.*`, `providers.<name>.oauthAccountFailover`,
   `activeCodexAccountPinned`. No migration writes on upgrade.
3. **Rollback.** Flag off. No config is rewritten, so downgrade is a restart.
4. **Parity proof.** Golden selection traces recorded before and after for Codex
   and Anthropic across manual, affinity, quota, round-robin and fill-first, plus
   the `__main__` and independent-quota-scope callers. Identical picks are the
   gate; a differing pick is a blocker, not a note.

## Tests

Audit record: the A-phase reviewer returned PASS-WITH-FINDINGS with two blockers,
both folded above. The first was that lifting fill-first out of its Codex copy
would have forced an edit inside lane L3's freeze. The second was that dropping
`inert: true` unconditionally contradicts this document's own reversibility rule,
which requires `pool.kernel` to default off and the old behaviour to be exactly
restorable.

## Second-half audit (the flagged behaviour change)

The extraction shipped as PR #4279. A separate audit of the remaining half returned
FAIL, and its findings change that half materially. Recorded here so the next cycle
starts from them rather than rediscovering them.

1. **BLOCKER. Branching the final ranking expression is not enough.**
   `preferredInitialAccount` encodes the quota strategy BEFORE its tail: the
   healthy-active early return tests `isAccountQuotaExhausted` (:262) and the
   roster-wide `hasHeadroomEvidence` check (:272) returns null when a provider has
   no quota data at all. Leave those untouched and round-robin can never run for a
   provider without quota evidence, and fill-first never reaches
   `autoSwitchThreshold` because the healthy active account already returned. Both
   guards have to be strategy-gated: skip the evidence requirement for round-robin,
   and use the threshold rather than exhaustion for fill-first.
2. **BLOCKER. The preference must peek, not pick.**
   `pickRoundRobinAccount` mutates live ring state, but
   `preferredInitialAccount` is explicitly a discardable proposal that the caller
   drops on a resolver throw or a missing project. Mutating there desyncs the
   cursor against requests that never happened. Use `peekRoundRobinAccount` and
   mutate with `pickRoundRobinAccount` plus `notePoolRotationSuccess` only after
   the selection is admitted, which is what Anthropic already does.
3. **The 429 path is safe to branch but fill-first must still move.** That tail has
   no evidence guard, so a strategy branch is structurally fine. Fill-first there
   cannot mean keep-active: the account that just returned 429 is already cooled,
   so staying put would skip rotation entirely.
4. **`stickyLimit` does not exist for the generic kind yet.** The
   `oauthAccountFailover` type carries only `enabled`, `strategy` and
   `autoSwitchThreshold`. Lifting the 400 at `oauth-account-routes.ts:395` before
   adding the field to the type, the DTO, GET and the PUT writer would accept a
   value and then drop it. The kernel default is 1.
5. **The flag lands in a lane-owned file.** `OcxConfig` has no `pool` key today,
   so `pool.kernel` belongs in `src/types/config.ts` (around :363) - which lane L3
   owns. This half therefore inherits the same freeze as work-phases 1 and 2 until
   that ownership clears, or the flag needs a different home.

- `tests/codex-integration/codex-pool-rotation.test.ts` — unchanged behaviour
  through the re-export (`pickRoundRobinAccount` `:270`, `selectPriorityTier` `:111`)
- `tests/oauth/generic-oauth-failover.test.ts` — a configured strategy changes the
  selected account, which is the criterion that closes "no longer inert"
- `tests/server/account-pool-management-api.test.ts` `:435`, `:449` and
  `tests/cli/cli-account-pool-verbs.test.ts` `:315` — update the inert assertions
- `tests/adapters/anthropic/anthropic-account-pool.test.ts` — parity
- `tests/providers/kiro/kiro-pool-rank.test.ts` — the kiro exhaustion special case
  in `account-quota-rank.ts:84-108` survives

## wp2b implementation plan (re-verified against `dev` 29d632ff2)

Every anchor below was re-read on the post-merge tree, after #4275/#4277/#4279/#4284 landed.

| Symbol | File | Line |
|---|---|---|
| `isProactivePreferenceEnabled` | `src/oauth/generic-account-failover.ts` | 150 |
| `rotateGenericOAuthAccountOn429` | `src/oauth/generic-account-failover.ts` | 178 |
| `preferredInitialAccount` | `src/oauth/generic-account-failover.ts` | 246 |
| `forgetGenericFailoverRoster` | `src/oauth/generic-account-failover.ts` | 308 |
| `GenericPoolSettingsDto` / `inert: true` | `src/oauth/pool-settings-capability.ts` | 40 / 54, 65 |
| `PUT /api/oauth/accounts/active` | `src/server/management/oauth-account-routes.ts` | 325 |
| generic GET / PUT DTO | `src/server/management/oauth-account-routes.ts` | 360 / 422 |
| `stickyLimit` 400 | `src/server/management/oauth-account-routes.ts` | 396 |
| `genericPoolKey` / `pickRoundRobinAccount` / `peekRoundRobinAccount` / `notePoolRotationSuccess` | `src/oauth/pool-kernel.ts` | 12 / 198 / 210 / 222 |
| `genericFailoverAccountId = resolved.accountId` | `src/server/responses/core.ts` | 4407 |
| per-provider `oauthAccountFailover` | `src/types/provider.ts` | 520 |

### The question 020 left open: where does a round-robin proposal commit?

`peekRoundRobinAccount` exists and does not advance the ring, which is correct for
`preferredInitialAccount` — that answer is discardable, and the resolver drops it when the
account turns out to be removed, reauth-flagged, or missing a Cloud Code Assist project. But
a peek that never commits is a ring that never turns: every request would propose the same
account forever, and "round-robin" would be a label on a constant.

So a commit site is mandatory, and it has to be the admission point, not the proposal. That
point already exists and already has a generic-only branch:

```
src/server/responses/core.ts:4405-4408
  if (isGenericFailoverProvider(route.providerName, route.provider)) {
    genericFailoverAccountId = resolved.accountId;
  }
```

One line joins it: `noteGenericPoolSelection(config, route.providerName, resolved.accountId)`.
The function lives in `generic-account-failover.ts` and does the flag read, the strategy read
and the `notePoolRotationSuccess(genericPoolKey(name), id, stickyLimit)` call itself. No policy
moves into `core.ts`, the import comes from a module `core.ts` already imports from, and the
core-path Lab boundary is untouched — `pool-kernel.ts` pulls only two types.

This is the one file in the unit that sits on every user's request path, so it takes exactly
one statement and no branching of its own.

### Change surface

**`src/types/config.ts`** — add `pool?: { kernel?: boolean }` beside the existing optional flag
objects (`resetCreditAutoRedeem` at :833 is the nearest shape). **`src/config.ts`** — add
`pool: z.object({ kernel: z.boolean().optional() }).optional().catch(undefined)` next to
`resetCreditAutoRedeem` at :1304. `.catch(undefined)` matches the house rule: a malformed hand
edit turns the feature off rather than costing the operator their providers.

**`src/types/provider.ts`** — add `stickyLimit?: number` to the per-provider
`oauthAccountFailover` block at :520, with the same 1..100 range the Anthropic pool documents.

**`src/oauth/generic-account-failover.ts`** — branch BOTH paths on strategy, because branching
one leaves the setting inert in practice:

| Strategy | `preferredInitialAccount` | `rotateGenericOAuthAccountOn429` |
|---|---|---|
| flag off, or absent/`quota` | unchanged: healthy-active return :262, `hasHeadroomEvidence` :267, `rankAccountsByHeadroom` | unchanged: ring after the failed id, then `rankAccountsByHeadroom` |
| `round-robin` | skip BOTH guards, `peekRoundRobinAccount(genericPoolKey(name), eligible, stickyLimit)` | `pickRoundRobinAccount` over the eligible ring |
| `fill-first` | skip the healthy-active return; keep active while its usage is under `autoSwitchThreshold`, else advance to the next eligible account | must NOT keep the failed account: advance to the next eligible one |

The two guards are skipped deliberately and for different reasons, both measured in 020's audit:
`hasHeadroomEvidence` returns false for any provider with no quota data, so leaving it in front
of round-robin makes round-robin unreachable exactly where it is most useful; and the
healthy-active early return fires before `autoSwitchThreshold` can ever be read, so fill-first
would never reach its own threshold test. Keep the presence quorum, the `EXCLUDED_PROVIDERS`
guard and the per-provider `health` cooldown on every branch.

**`src/oauth/pool-settings-capability.ts`** — `inert` becomes `boolean` computed from the flag
instead of the literal `true`. `genericPoolSettingsDto` takes the flag as a third argument
rather than reading config itself, so the DTO stays a pure projection.

**`src/server/management/oauth-account-routes.ts`** — three edits. The active PUT at :325 gains
`seedPoolRotationAccount(genericPoolKey(provider), accountId)` beside `forgetGenericFailoverRoster`,
or the operator's pick immediately loses to sticky rotation — the same defect wp1b just fixed on
the Codex side, and `forgetGenericFailoverRoster` only drops the presence count, never the
cursor. The 400 at :396 narrows to `quotaWindow` alone. The pool PUT accepts and persists
`stickyLimit` with the 1..100 validation.

**`src/cli/account-extended.ts`** — the generic branch at :395 currently hardcodes
`const enabled = false`. With the kernel on it reports the real state.

### Acceptance

Criterion c-3: a test asserts a configured strategy actually changes the selected account, and
the DTO stops reporting `inert` once the flag is on.

- `tests/oauth/generic-oauth-failover.test.ts` — round-robin rotates across dispatches for a
  provider with NO quota data (the case the evidence guard blocks today); fill-first holds the
  active account under threshold and advances over it; quota is byte-identical to today; every
  one of them is a no-op with `pool.kernel` off.
- `tests/server/account-pool-management-api.test.ts` — `inert` follows the flag, `stickyLimit`
  round-trips, `quotaWindow` still 400s. The existing marker test at :435 reads the source for
  the literal `inert: true;` and moves with the type.
- `tests/cli/cli-account-pool-verbs.test.ts` — the CLI reports the live threshold when on.
- Red control for each new case, as in wp1b: the assertion must fail with its production branch
  removed. A test that passes either way is not coverage.

### Reversibility

`pool.kernel` defaults off, and off means the pre-kernel code path byte for byte: the guards
stay, the DTO still says `inert: true`, and `noteGenericPoolSelection` returns before touching
the ring. No migration writes on upgrade; the kernel reads keys that are already persisted.

### A-phase findings folded into this plan

Verified while auditing the plan above, before any code was written.

**The `inert` contract is published, in seven languages.** Turning `inert` into a computed
field makes live documentation false, and AGENTS.md requires docs-site to stay in sync and
translated locales not to contradict the English source. The statements that change:
`docs-site/src/content/docs/reference/configuration/providers.md` :568 ("the generic selector
does not act on it yet, so omitted and set behave the same today"), :569 ("inert until the
selector consumes it") and :590 ("`inert: true` for those two fields only"); and
`reference/cli/providers-accounts.md` :351 ("Generic pool thresholds are currently inert") and
:355, whose signature literally reads `inert: true | null`. The same page exists under
`ko`, `ja`, `fr`, `ru`, `tr`, `zh-cn` and `zh-tw`. All of it moves in this PR: a flag-gated
feature still has to describe both states, not the old one.

**The DTO marker test fails OPEN, which is worse than failing.**
`tests/server/account-pool-management-api.test.ts:435` locates its slice with
`source.indexOf("inert: true;", start)`. Once the type reads `inert: boolean;` that returns
`-1`, and `source.slice(start, -1)` happily returns almost the whole file — which still
contains "strategy", "autoSwitchThreshold" and "enabled", so all three assertions pass while
the test has stopped checking anything. It must be rewritten against the new literal, not
merely allowed to keep passing. This is the same failure mode wp1b was built on, so it gets
named rather than discovered later.

**`src/server/management/provider-routes.ts`:1023-1024 is a reader the plan did not name.**
It carries `oauthAccountFailover` forward when a provider is overwritten, to stop an edit
silently enabling rotation. It copies the whole object, so a new `stickyLimit` rides along
with no change — verified, listed here so the next reader does not have to re-derive it.

**The core-path import edge is already there.** `src/server/responses/core.ts` imports from
`../../oauth/generic-account-failover` at :150, so adding `noteGenericPoolSelection` to that
existing import creates no new module edge at all, and `pool-kernel.ts` imports only two
types. `bun test tests/lab/core-lab-boundary.test.ts` is green at 17 pass / 0 fail on this
branch and is re-run at Check.

**Fill-first's stable order is `eligibleFailoverAccounts`:164**, which preserves
`set.accounts` order from the store and filters out reauth-flagged and cooled accounts. That
is the order the 429 ring already walks, so fill-first advances through the same sequence
rather than inventing a second one.

### Plan audit round 2 — FAIL, three blockers folded

A dispatched reviewer returned FAIL on the plan above. All three blockers are real and two of
them contradict what this document said one revision earlier. Recorded rather than quietly
edited, because the corrections are the useful part.

**Blocker 1 — fill-first must walk the SORTED FULL roster, not the eligible subset.**
The "A-phase findings" note above claimed `eligibleFailoverAccounts`:164 is the order
fill-first advances through. That is wrong, and it is the exact bug 020's own earlier audit
already rejected when it added the `stableAll` argument to `pickFillFirst`. Both shipped
copies walk a stable roster sorted with `localeCompare` — `src/codex/routing.ts`:1443 and
`src/oauth/anthropic-routing.ts`:427 — and dropping to the eligible subset changes the wrap
order whenever an ineligible id sits between two eligible ones. The generic roster is worse
than unsorted-by-accident: `getAccountSet().accounts` is in LOGIN order, so two operators who
added the same accounts in a different sequence would get different rotation. The generic
fill-first sorts the full roster the same way, then skips ineligible ids while walking it.
Supersedes the paragraph above.

**Blocker 2 — the commit site fires on every generic dispatch, so it must gate on
round-robin specifically.** `core.ts`:4407 is reached on every generic first dispatch,
including the preferred-null quota path and the fallback after a preferred account is dropped
at :4368-4388. The plan said `noteGenericPoolSelection` "does the flag read and the strategy
read" without saying what it does with them, which is not precise enough to implement: an
ungated call would advance round-robin sticky state for quota and fill-first pools too.
It returns immediately unless `pool.kernel` is on AND the resolved strategy is
`round-robin`. Anthropic already draws exactly this line — `anthropic-routing.ts`:791 notes
rotation only on its round-robin branch — so this is matching an existing contract, not
inventing one.

**Blocker 3 — the CLI has three states, not two.** `src/cli/account-extended.ts`:402-409
prints "unavailable" and "threshold support is unknown" whenever `inert !== true`, so a
kernel-on `inert: false` would render the live feature as an unknown capability — the
opposite of the truth. `tests/cli/cli-account-pool-verbs.test.ts`:393-403 also feeds
`inert: false` through a malformed-capability loop that expects `enabled: false`. The CLI
needs `true` (stored, not applied), `false` (applied) and `null`/absent (unknown) as three
distinct renderings, and that test's fixture must stop conflating the middle one with
malformed input.

**Major folded — an exact-equality DTO assertion.**
`tests/server/account-pool-management-api.test.ts`:477 asserts the generic GET body with
`toEqual`, so adding `stickyLimit` breaks it. :484 uses `toMatchObject` and is safe. The PUT
round-trip at :486 breaks only once PUT actually persists the field. All three move with the
change.

**Major folded — `src/cli/capabilities.ts`:331** also publishes the inert contract, alongside
the docs-site pages already listed.

**Correction — anchor.** This document cited `hasHeadroomEvidence` at :267; that is where its
comment begins. The call is at :272. The anchor table itself was verified correct.

**Confirmed, no action —** the reviewer independently reached the same conclusion on the Lab
boundary: `core.ts` already imports `generic-account-failover`, and `pool-kernel.ts` is
`import type` only, which the boundary walker skips. No new edge.
