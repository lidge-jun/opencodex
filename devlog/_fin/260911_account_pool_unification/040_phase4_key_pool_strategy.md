# Phase 4 — API keys gain proactive selection

Base: dev directly. This layer is NOT in the chain: key-failover shares no module
with the OAuth kernel, and an API key is a different identity from an OAuth
account set. The A-phase audit reparented it here.

## Thesis

API-key pools get a proactive strategy before the first attempt, while keeping
the existing reactive 429 and 401 rotation as the fallback.

## Current behaviour (verified on dd9a2906b)

src/providers/key-failover.ts is reactive only. hasKeyPoolFailover (:98-101)
requires authMode not oauth or forward and apiKeyPool length at least 2.
Selection is a circular index walk in rotateKeyAfterFailure (:220-233) starting
from the failed entry, skipping cooled keys. Cooldown state is a local map
(:19-53) keyed by provider and key id. Wrappers: rotateKeyOn429 (:269-278),
rotateKeyOn401 (:288-296), rotateProviderTransportOn429 (:322-338).

src/providers/api-keys.ts listProviderApiKeys (:62-80) returns the pool and an
activeId with no strategy. src/types/provider.ts:384-389 defines apiKeyPool as
id, key, label and addedAt only.

The pre-dispatch hook points are in src/server/responses/core.ts: :4188-4190
(refreshDispatchAdapter calling resolveCurrentProviderApiKeyTransport) and
:4437-4444 (resolveProviderTransport after OAuth resolution). The OAuth side has
preferredInitialAccount at :4335-4340 with the comment that it prefers a known
headroom account before the first attempt; API keys have no analogue.

## Change surface

MODIFY src/types/provider.ts - add an optional per-provider key-pool strategy
field. Do not reuse the OAuth account-pool field names; these are different
identities and phase 5 owns the operator surface.

MODIFY src/providers/key-failover.ts - add a proactive selector invoked from the
pre-dispatch sites, supporting round-robin and a rate-limit-aware order. Keep
:220-233 exactly as the 429 and 401 fallback.

MODIFY src/server/responses/core.ts at :4188 and :4437 to consult the selector
before the first attempt. The mid-retry resolveProviderTransport calls at :4119,
:5399, :5503 and :7346 stay recovery paths and are not touched.

## Policy difference from OAuth pools, stated deliberately

Key rotation is a rate-limit scheduling problem: keys usually share an account or
organization, so moving key costs little cache. Subscription accounts lose their
prompt cache on every move. That is why phase 3 puts affinity ahead of quota for
accounts and this phase does not for keys.

## Security

key-failover already logs failedId and candidateId. The new selector must not
inherit that shape, and must log no key identity. privacy:scan stays green.

## Tests

A configured round-robin strategy changes the first-attempt key; the reactive 429
and 401 walk still works when the strategy is unset; a cooled key is skipped by
both paths; a single-key pool is a no-op.

## Out of scope

No operator-visible surface. Phase 5 owns the management route and GUI; adding
fields there from this layer would collide with it.

## wp4b wiring plan (re-verified against `codex/generic-pool-kernel`)

#4277 shipped `selectProactiveApiKey` (`src/providers/key-failover.ts`:128) and deliberately
stopped there: the picker exists, is unit-tested, and is called from nowhere in production. So
does `forgetApiKeyRotationCursor` (:112). This unit connects both, and nothing else.

| Symbol | File | Line |
|---|---|---|
| `selectProactiveApiKey` | `src/providers/key-failover.ts` | 128 |
| `forgetApiKeyRotationCursor` | `src/providers/key-failover.ts` | 112 |
| OAuth-only branch, skipped by key-auth | `src/server/responses/core.ts` | 4322 |
| transport pin, last `route.provider` write before the first send | `src/server/responses/core.ts` | 4450 |
| `activeProvider` bind | `src/server/chat-native.ts` | 238 |
| `PUT /api/providers/keys/active` | `src/server/management/oauth-account-routes.ts` | 674 |

### Where the call goes, and why there

`route.provider` is final for a key-auth request at the transport pin on `core.ts`:4450, and all
four first-send consumers read that same object — the image/video bridge (:6570), web search
(:6653), `runTurn` (:6739) and the generic HTTP path (:7174). One call placed after the OAuth
block and before the pin therefore serves every one of them, with no per-path duplication. That
is the exact position the OAuth side already occupies: "prefer the account with known headroom
BEFORE the first attempt" at :4344.

`chat-native.ts` is a separate entry path and needs its own call, immediately before
`activeProvider` is bound at :238.

Nothing competes with it. `resolveProviderTransport` never swaps keys, and
`applyCodexAuthContextToProvider` is a no-op outside `authMode: "forward"`. The one pre-send
`apiKey` rewrite that does exist (`core.ts`:4196) re-reads an already committed selection and
does not run on a current first attempt.

**No new import edge on the core path.** `core.ts` already imports `hasKeyPoolFailover` from
`../../providers/key-failover` at :269, so the picker joins an existing import — which matters
because `core.ts` is one of the three files that must never reach `src/lab`.

### Cursor invalidation

`forgetApiKeyRotationCursor` has no production caller, so the round-robin cursor currently
outlives the pool it describes. It joins `clearKeyCooldowns(name)` at the three management
routes that already reset key state: the manual active-key PUT at :674, and the add/remove key
routes at :641 and :714. An operator who just chose a key should not be second-guessed by a
cursor that predates the choice — the same rule wp1b and wp2b applied to the account pools.

### Scope boundary

No change to `selectProactiveApiKey` itself, to the reactive 429/401 rotation, or to the
strategy semantics. The picker already refuses to override a healthy committed key and already
returns null when no strategy is configured, so an install that never set `apiKeyPoolStrategy`
executes one predicate and nothing else.

### Acceptance

Criterion c-5 is already met by #4277 for the selection logic; this unit adds the evidence that
it reaches a real dispatch.

- `tests/server/server-key-failover-e2e.test.ts` is the only suite that drives a real
  first-attempt key-auth dispatch with an `apiKeyPool`, so it takes the new case: a two-key pool
  whose committed key is cooled, with `apiKeyPoolStrategy` set, must send the FIRST request on
  the other key. Red control: without the wiring the first attempt goes out on the cooled key and
  earns the 429 the runtime could already predict.
- A second case pins the no-op: with no `apiKeyPoolStrategy`, the committed key is used
  unchanged even when cooled, because rotation stays reactive-only for that install.
- A cursor case: a manual key selection through `PUT /api/providers/keys/active` clears the
  rotation cursor.

### Plan audit — FAIL, folded

**Blocker 1 — the picker does not mutate the route.** `selectProactiveApiKey` writes
`config.providers[name]` and RETURNS a clone; it never touches `route.provider`. The plan said
"wire the call" without saying what to do with the return, which is not implementable: a literal
reading leaves the live route on the cooled key and the whole unit is a no-op that still writes
config. The call site is:

```
const picked = selectProactiveApiKey(config, route.providerName, now);
if (picked) route.provider = picked;
```

**Blocker 2 — the assignment must land before the copies, not merely before the send.**
"One call serves all four consumers" is true only because nothing reassigns `route.provider`
between the pin and each consumer — but they do not all read it late. `adapterProvider` is
copied at `core.ts`:4458 and the adapter is bound at :4477, and the HTTP path captures
`builtInitialRequest` at :7139. So the assignment goes BEFORE :4450, ahead of every copy. The
audit also showed why this cannot be left to self-healing: the HTTP and `runTurn` paths can
re-read a stale selection through `refreshDispatchAdapter` (:4197), but the image bridge
(:6570) and web search (:6655) call `providerFetch(route.provider)` directly and have no such
second chance. Ordering is the entire correctness argument here.

**Major 1 accepted, with the reason recorded.** Putting the picker on the first-attempt path
means an ordinary request can now perform a persisted config write. It is bounded: the picker
returns null unless a strategy is configured AND the committed key is already cooled, so a
healthy install does one predicate and stops. The write goes through the same
`commitProviderApiKeySelection` / `mutatePersistedConfig` lock the reactive rotation uses, and a
later same-request 429 rotation serializes behind that lock rather than racing it. The cost is
paid exactly once per cooldown, replacing a request that was otherwise spent earning a 429 the
runtime could already predict.

**Major 2 — two first-send paths this unit does NOT cover, named rather than silently dropped.**
Native compact for `openai-apikey` (`src/server/responses/compact.ts`:669, dispatch at :745-883)
never enters `core.ts`, and the keyed `/v1/images` path (`src/server/images.ts`:701) reads
`candidates.keyed.apiKey` directly rather than a provider object. Each has a different
provider-resolution shape and needs its own dispatch harness, so they become their own
work-phase instead of riding along untested here. `collaboration.ts` and
`encrypted-payload.ts` are NOT affected: they import `rotateProviderTransportOn429` and
dispatch no first attempt.

**Minors folded.** The web-search fetch is `core.ts`:6655, not :6653 (that line is a comment).
The stale-selection re-read is :4197, not :4196. `src/server/management/provider-routes.ts`:832
and :931 also `clearKeyCooldowns` on key replace and delete, so the cursor reset belongs there
too — five routes, not three.

## wp4 plan — quota-aware API key selection

wp4b wired the picker in; this gives it the third strategy. Today
`apiKeyPoolStrategy` accepts only `round-robin` and `fill-first`
(`src/config.ts`:586, `src/types/provider.ts`:399), so an API key pool cannot do what every
other pool in this codebase already does: prefer the credential with the most room left.

| Symbol | File | Line |
|---|---|---|
| `apiKeyPoolStrategy` schema | `src/config.ts` | 586 |
| `apiKeyPoolStrategy` type | `src/types/provider.ts` | 399 |
| `selectProactiveApiKey` strategy read | `src/providers/key-failover.ts` | 135 |
| per-key quota cache (private) | `src/providers/quota-key-accounts.ts` | 22 |
| `identity()` cache key | `src/providers/quota-key-accounts.ts` | 50 |
| `readProviderApiKeyQuotas` | `src/providers/quota-key-accounts.ts` | 101 |
| `keyQuotaReaderForProvider` | `src/providers/quota.ts` | 2897 |
| editor field list | `src/server/auth-cors.ts` | 821 |

### The one real obstacle: the selector is synchronous, the quota reader is not

Per-key quota already exists — `keyQuotaReaderForProvider` serves seventeen providers — but it
is reached only through `readProviderApiKeyQuotas`, which is `async` and probes the network on a
miss. `selectProactiveApiKey` is synchronous and sits on the first-attempt path, where it must
not await anything.

So `quota-key-accounts.ts` grows one cache-only, synchronous reader:

```
export function cachedApiKeyQuota(name, provider, keyId, key): ProviderQuota | null
```

It recomputes the same `identity()` the async path stores under, reads `cache`, and returns
null on a miss. It never probes, never awaits and never schedules one — a selector that could
trigger a network read on the request path would be a worse defect than the one this unit
fixes. A miss is simply "no evidence", which is the same word the OAuth side uses.

Env-placeholder keys resolve through `resolveProviderApiKey` exactly as the async path does,
inside a try/catch: an unresolvable key is a miss, not a throw on the dispatch path.

### Ranking, and what happens without evidence

`quota` ranks the eligible keys by remaining headroom and takes the roomiest. When NO eligible
key has a cached row, it falls back to the first eligible key — which is what `fill-first`
already does, and therefore exactly today's behaviour for a provider whose quota reader does not
exist or has never run.

That is deliberately NOT the OAuth rule. `preferredInitialAccount` returns null without
evidence because its active account is still perfectly usable. Here the function has already
established that the committed key is cooling, so returning null would mean deliberately
dispatching on a spent key. There is no no-op available; the only question is which replacement.

### Change surface

`src/providers/quota-key-accounts.ts` — add `cachedApiKeyQuota` and a
`setCachedProviderApiKeyQuotaForTests` seam mirroring the account-side
`setCachedProviderAccountQuotaForTests`, because a synchronous reader of a private cache is
otherwise untestable without a live probe.

`src/types/provider.ts`:399 and `src/config.ts`:586 — widen the union to include `quota`.
`src/server/auth-cors.ts`:821 already lists the field as editor-visible and needs no change.

`src/providers/key-failover.ts` — a third branch in `selectProactiveApiKey`. `round-robin` and
`fill-first` keep their current code paths byte for byte.

### Acceptance

- `tests/adapters/key-failover.test.ts`: the roomiest eligible key wins; a cooled roomier key is
  skipped; with no cached rows the first eligible key is taken; an unknown strategy value still
  degrades to no-op. Red control for each: with the `quota` branch removed the ranking cases must
  fail.
- `apiKeyPoolStrategy` is currently undocumented in `docs-site` — no row exists anywhere. It
  gains one in `reference/configuration/providers.md` describing all three values, since shipping
  a third undocumented value is how the generic pool ended up inert and unexplained.

### wp4 plan audit — FAIL, folded

**Blocker 1 — a cache hit is not evidence.** `readEntry` stores `{ unavailable: true, quota:
lastGood }` for up to `LAST_GOOD_MS` (30 minutes) when a probe fails, so the row survives with a
stale measurement attached. A reader that returns `entry.quota` on any hit would rank on a
number taken up to half an hour ago from a probe that has since been failing — and rank it
ABOVE a key with no row at all. `cachedApiKeyQuota` returns null whenever `entry.unavailable`
is set or `entry.quota` is null. Last-good is a display value; it is not a selection input.

**Blocker 2 — the ranking was not specified, and the obvious formula does not work.**
"Remaining headroom" is undefined for `ProviderQuota`, which carries `fiveHourPercent`,
`weeklyPercent`, `monthlyPercent`, `customWindows[].percent` and `creditsUsd`. The definition
this unit uses, matching `headroomOf` on the OAuth side so the two pools cannot disagree:

`headroom = 100 - max(fiveHourPercent, weeklyPercent, monthlyPercent, ...customWindows.percent)`,
and null when none of those is a number. `creditsUsd` is deliberately excluded: it is a
currency amount, not a percentage, and mixing the two scales produces an ordering that means
nothing.

**Mixed evidence needs a rule and now has one**, borrowed from
`rankAccountsByHeadroom`'s three buckets rather than invented: measured-with-headroom first
(most headroom wins), then unmeasured, then measured-and-exhausted, with the stable roster order
breaking ties. An unmeasured key is not assumed spent, and it is not assumed fresh either.

**Recorded, not fixed — providers whose rows cannot discriminate.** DeepSeek reports every key
at `customWindows.percent: 0`, so all headrooms tie at 100 and the pick falls through to the
stable order, which is exactly today's behaviour. That is the correct outcome for a provider
that publishes no per-key differentiation, and it is why the fallback has to be a real ordering
rather than an error.

**Major 1 — "unknown strategy is a no-op" was wrong.** Today any truthy value that is not
`round-robin` takes the `eligible[0]` default, which IS fill-first; zod is the only thing
rejecting junk. So the new branch is `else if (strategy === "quota")` placed after the
round-robin block and BEFORE that default. Replacing the default would silently retarget
fill-first. The acceptance bullet claiming a no-op is struck.

**Major 2 — the test seam cannot mirror the account-side signature.** The key cache is keyed on
`identity(name, provider, id, resolvedKey)`, so the seam takes the provider name, the provider
config, the key id and the raw key, not `(provider, accountId, quota)`.

**Minors folded.** `keyQuotaReaderForProvider` is at `quota.ts`:2898, not :2897. The e2e helper
added in wp4b types its strategy parameter as `"round-robin" | "fill-first"` and widens with the
union. The provider count is approximate and the claim is dropped. `resolveProviderApiKey` is
synchronous and swallows its own failures, so the try/catch is belt-and-braces rather than
required — kept, and labelled as such.

**Deliberate:** a `quota` pick still records `keyRotationCursor`. The cursor is where the pool
last was, not a round-robin private; leaving it accurate means switching an operator to
`round-robin` later resumes from the key actually in use instead of the start of the ring.

## wp4c plan — the two first-send paths that never enter core.ts

wp4b wired `selectProactiveApiKey` into the Responses core and native chat. The audit that
produced it named two dispatch paths those two call sites do not cover, and they became this
unit rather than riding along untested.

| Seam | File | Line | Shape |
|---|---|---|---|
| native compact | `src/server/responses/compact.ts` | 745-746 | `compactProvider` object; key applied as a header |
| keyed images | `src/server/images.ts` | 701-703 | `candidates.keyed` destructured to `{ provider, apiKey, providerName }` |

Both are genuinely independent: native compact runs only when
`supportsNativeResponsesCompactEndpoint` accepts the destination and never reaches
`handleResponses`, and the keyed image path builds its own URL and Authorization header
without a route object at all.

### One seam per file, and only first sends

`compact.ts`:745 is the native-compact branch:

```
if (compactProvider.authMode !== "forward" && compactProvider.apiKey) {
  headers.set("authorization", `Bearer ${resolveProviderApiKey(compactProvider.apiKey)}`);
```

The pick goes immediately above it, reassigning `compactProvider` from the returned clone —
the same assign-then-use shape wp4b established, and for the same reason: the picker returns a
clone and never mutates its argument.

`images.ts`:701 destructures `{ provider, apiKey, providerName }`. The pick runs before the
destructure so the header below is built from the chosen key.

**Explicitly NOT a seam:** `compact.ts`:446 sits inside `resolveAlternateCompactContext`, which
runs after a failure. It is the compact analogue of the 429 rotation loops and must stay
reactive; putting a proactive pick there would move a retry off the account the retry exists to
replace.

### What stays out

No change to `selectProactiveApiKey`, to the reactive rotation, or to the strategies. The picker
already returns null unless a strategy is configured AND the committed key is cooling, so an
install that never set `apiKeyPoolStrategy` evaluates one predicate on each of these paths and
stops — including the persisted-write path, which is never reached.

### Acceptance

- A cooled committed key with a configured strategy is replaced on the FIRST native-compact send
  and on the FIRST keyed image send, proven end to end rather than by unit-calling the picker.
- Without a configured strategy both paths still use the committed key, so rotation stays
  reactive-only for an install that never asked otherwise.
- Red control: with each call site removed, its case must fail with the cooled key on the wire.
- The Lab boundary suite runs, because `compact.ts` imports from the same module family the core
  path does.

### wp4c plan audit — PASS-WITH-FINDINGS, folded

**Major 1 — the images seam carries a resolved SNAPSHOT, not a live field.**
`candidates.keyed.apiKey` is built once by `selectImagesProvider` (`src/server/openai-sidecar.ts`:237-238,
:282), so the literal "pick, then destructure" would set the Authorization header from the OLD
key while the picker had already persisted the new one — a request on a cooled key plus a config
write, which is strictly worse than doing nothing. The header is rebuilt from the returned clone
through `resolveProviderApiKey` instead.

This is the same class of mistake wp4b's blocker caught: the picker returns a clone and mutates
nothing, so every seam has to be asked "what does the send actually read?" rather than "did I
call it".

The call also stays INSIDE the `candidates.keyed` branch rather than moving up next to
`selectImagesProvider`. Higher up it would run — and write config — even on requests that
ChatGPT forward goes on to serve, spending a rotation on a path that never used the key.

**Minor 2 — gate the compact reassignment.** `compactProvider` starts as `route.provider` and is
overlaid only for `codexAccountMode` or custom reserve-forward. The picker returns null for
forward providers, so an ungated assign would be harmless today, but it stays inside the
existing `authMode !== "forward" && apiKey` branch so a future overlay cannot be clobbered by
accident. The provider name to pass is `route.providerName`.

**Minor 3 — my lease concern was overstated, corrected.** Key-auth native compact does not hold
host-circuit admission at all: `preAuthUpstreamHostCircuitKey` requires
`codexAccountMode === "pool"` with `authMode === "forward"`. Turn admission is a counter and the
config write is SQLite, so there is no shared mutex to deadlock on and the lease stays valid —
the same situation wp4b already ships at the core seam. The plan's caution was unfounded and is
struck rather than left standing as a vague worry.

**Minor 4 — confirmed there are no other first-send key applications in either file.**
`compact.ts`:289 and :380 are 401 refresh paths, and :446 is the 429/402 pool alternate.

**Both paths are e2e-testable**, which is what lets the acceptance claim an end-to-end proof
rather than a unit call: native compact through the openai-apikey harness in
`tests/adapters/openai/openai-api-virtual-models.test.ts`, and the keyed image path through
`tests/server/server-images.test.ts`, whose keyed fallback already asserts a specific Bearer.
The cooled-committed-key setup is the one wp4b built in `server-key-failover-e2e.test.ts`.
