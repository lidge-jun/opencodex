# Lane Q — issue #2892 gaps 3 and 4

The last two of the five gaps #2892 raised against the merged stored-Pool 401
recovery path. Gaps 1–2 shipped as `8f199fcb6` (#2920), gap 5 as `84049830e`
(#2922). An independent recon audit re-derived both remaining gaps from current
`dev` and confirmed each is still reachable — and corrected the reporter on one
point, recorded below.

## Gap 3 — a rotated grant never reaches an inactive same-grant alias

A successful refresh persists the rotated credential to the flight owner only, via
the generation CAS at `src/codex/account-store.ts:748`. A live joiner can CAS the
result onto its own record. Nothing writes to a third category: a non-deleted
record carrying the same `refreshGrantFingerprint` that is not participating in
the flight.

`findFreshCredentialForGrant` (`src/codex/account-store.ts:393`) is a pre-fetch
lookup and propagates nothing. So the alias keeps a refresh token that upstream
has just rotated away. The next refresh on that alias sends a dead grant, and
`invalid_grant` is classified `revoked` — which retires a healthy account. That
classification is correct behavior for a genuinely dead grant; the defect is that
the grant died because we rotated it and never told the alias.

### The design an adversarial audit rejected

My first plan had two branches: an untouched alias adopts the rotated credential
whole, and an alias whose access token had changed concurrently keeps its own
access token but takes **only** the rotated refresh token. An independent audit
refused that second branch, with two findings I could not rebut:

- The generation fence in `src/codex/plan-from-token.ts:32` treats a higher
  generation as proof of a **newer access-token JWT**, which is what lets JWT plan
  claims supersede an older WHAM observation. Bumping a generation while
  deliberately keeping the old access token lets a stale JWT overwrite an
  authoritative plan. `tests/codex-plan.test.ts:129` already pins that meaning.
- A flight is keyed by grant and does not record participant account ids
  (`src/codex/account-store.ts:308`), so a scan cannot distinguish a dormant alias
  from a live joiner. Rotating a joiner's grant while preserving its 401-rejected
  access token makes the provenance CAS inapplicable, and the recursion's
  freshness shortcut then returns the rejected bearer — defeating 401 recovery in
  exactly the case the branch existed to serve.

### What ships instead

One batch compare-and-swap, one `persist`, and a deliberately narrow eligibility
test. An alias is repaired only when it is provably an untouched duplicate of the
pre-refresh credential: same old grant fingerprint, same access token, same
expiry, and the same `chatgptAccountId` as the owner. Such an alias receives the
rotated access token, refresh token, and expiry **together**, so the generation
bump keeps meaning what every fence already assumes. `replacedAt` and the
validation metadata are preserved, because the probe-lease lineage check accepts
only an intact `G → G+1`.

Anything else is left alone: a differing access token, a differing account id, or
a tombstone. The `chatgptAccountId` equality requirement is not decoration — a
fingerprint is `sha256` of the refresh token and carries no identity claim
(`src/codex/account-store.ts:62`), and no repository invariant guarantees one
grant cannot span two account ids.

This is a **partial** close of gap 3, and the issue comment says so. Dormant
duplicates stop being retired for a grant we rotated away; a mixed alias still is.
Healing that case needs durable grant lineage and verified identity binding, which
the current fingerprint-and-generation model cannot express safely.

The flight's returned `resolvedGrantFingerprint` stays the **old** fingerprint:
joiners wait on that key, and retagging it would make every legitimate joiner look
foreign.

## Gap 4 — stale credential evidence writes unscoped state

The reporter described an async interleaving between validation and mutation. That
part is wrong and worth stating: `recordCodexUpstreamOutcome` is synchronous
(`src/codex/routing.ts:2095`) and there is **no `await`** between the generation
check at `src/codex/routing.ts:2210` and the mutations at 2216–2223. The
same-process race the issue describes is not reachable.

The cross-process race is real regardless. The check is an unlocked synchronous
store read (`src/codex/account-store.ts:186`) while writers coordinate under the
mutation lock, and OS preemption needs no `await`. The side effects then carry no
credential identity: health entries have no generation field, reauth state is a
bare `Set<string>` fenced only by config generation, and affinity clearing removes
every entry for the account.

Affinity is already self-invalidating on the next generation check. Health and
reauth are not. Rather than thread a generation through every health consumer, the
fix keeps the whole sequence synchronous and makes the *observable end state*
free of stale evidence: snapshot the health entry and the reauth flag, apply the
mutations, then re-validate the generation and roll back if it stopped being live.

A cross-process replacement landing inside the window is therefore caught after
the fact instead of being prevented, which is the strongest guarantee available
without taking the config lock on the request path — the lock runs with
`busy_timeout=0`, so acquiring it per outcome would convert ordinary contention
into thrown request errors. Affinity clearing is deliberately not rolled back: it
is self-invalidating, and re-adding swept entries would be a worse bug than the
sweep. `recordCodexUpstreamOutcome` stays synchronous — many callers consume it as
`void` (`src/server/responses/core.ts:391`), so making it async would silently
leave mutations unawaited.

## Constraints the audit flagged

The refresh-flight map is keyed by the old grant (`src/codex/account-store.ts:315`)
and joiner provenance deliberately carries that old fingerprint, so alias
propagation must not disturb that ordering. The config lock runs with
`busy_timeout=0` and must stay synchronous, so the routing path must not acquire
it per outcome. Affinity requires exact credential-generation equality, so any
alias generation bump has to be reasoned about rather than assumed harmless.

## Evidence standard

Each regression is driven red by a named mutation, using the existing blocked-fetch
seam rather than a timing sleep. Any assertion that survives its mutation is
deleted rather than kept.
