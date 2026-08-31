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
reauth were not.

My first attempt snapshotted the state, mutated, then re-read the generation and
rolled back. Two reviewers independently rejected it, correctly: a replacement can
land at any point *after* `recordCodexUpstreamOutcome` returns, so a post-write
read narrows the window without closing it. @Ingwannu reproduced the surviving
ordering on the exact head — record a 401 at G, return, then persist G+1, and the
quarantine still applied to G+1.

The evidence is now tagged with the credential it came from and checked when it is
*read*, which is what actually settles it. `credentialFailureGeneration` holds the
generation a 401/403 was derived from, and the health readers (`shouldFailover`,
`getCodexUpstreamHealth`) drop a failure whose credential is gone. The reauth set
became a map from account id to the generation that justified the flag, with
`undefined` preserved as an account-wide mark so a login flow with no specific
credential still quarantines unconditionally.

Affinity clearing stays un-reverted: entries already carry a generation and
self-invalidate, so re-adding swept entries would be the worse bug.
`recordCodexUpstreamOutcome` stays synchronous — many callers consume it as
`void` (`src/server/responses/core.ts:391`), so making it async would silently
leave mutations unawaited. The config lock is still never taken on the request
path; it runs with `busy_timeout=0`, and per-outcome acquisition would turn
contention into request errors.

## The alias plan note

Review also caught that propagation installs the rotated JWT on an alias but left
its configured plan alone: a `plus → pro` rotation gave the alias a Pro credential
while its plan stayed `plus`, and the cached-token fast path never repairs that, so
quota scoring and the 30-day projection stayed wrong until a restart or a WHAM
refresh. Each propagated alias is now reconciled at its **own** committed
generation, which is why the commit returns `{ id, generation }` rather than ids —
aliases need not share a generation, and the plan note is generation-fenced.

That last point produced the one genuinely vacuous assertion of this unit: with a
single `saveCodexAccountCredential` per record, owner and alias generations
coincided, so an assertion about the per-alias fence passed even when the code used
the owner's generation. The fixture now advances the alias twice so the generations
diverge, and the mutation turns red.

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
