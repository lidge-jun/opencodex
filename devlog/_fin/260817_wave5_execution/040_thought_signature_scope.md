# WP4 — thought-signature replay scope + durability (Wave 5A-4) — rev 2 after audit

> Rev 2 folds blockers 7 and 8.

## Confirmed defect: incomplete key

`keyFor` (`src/responses/thought-signature-replay.ts:74-90`) derives from five
fields: `[clientThreadId, providerName, adapterName, modelId, callId]`. The sibling
`src/responses/reasoning-replay-cache.ts:65-85` uses seven — it also includes
`providerDestinationIdentity` and `credentialIdentity`. Both fields exist on the
type (`src/types.ts:7`, `:11`) and are populated in `src/server/responses/core.ts:305-341`.

So two accounts, two endpoints, or a pre/post credential rotation sharing one
thread + provider name + model can read each other's opaque signature.

## The constraint rev 1 missed (blocker 8)

This store is **durable**, unlike the in-memory sibling. Its own comment at `:66-73`
explains why the extra fields were left out: the reasoning cache's identities are
process-local HMACs (`processLocalIdentity`, `reasoning-replay-cache.ts:91`) that do
not survive a restart. Adding them naively makes every key unstable across restarts
and defeats the store's entire purpose.

And `keyFor`'s output IS the on-disk key: the snapshot is written with `version: 2`
at `:143-144`. Changing the derivation silently invalidates every persisted entry —
every resumed thread loses its signature on upgrade and hits the exact upstream 400
this store exists to prevent.

### Required approach

1. Derive a **restart-stable** destination + credential identity for this store —
   not the process-local HMAC. Destination can be the normalized base URL; the
   credential needs a stable non-secret discriminator (e.g. a salted-but-persisted
   digest, or the account id already used for pooling). If no restart-stable
   credential discriminator exists, say so and scope the fix to destination only,
   rather than shipping a key that silently stops surviving restarts.
2. Bump the snapshot to `version: 3` with an explicit drop-or-migrate decision.
   Dropping is acceptable (a lost signature degrades to a normal turn); silently
   mismatching is not.

## Durability: retarget (blocker 7)

Rev 1 named `src/adapters/google-antigravity-replay.ts`. That file never calls the
remember API — it owns a separate Antigravity session snapshot with its own persist
gate. The real seam is `thought-signature-replay.ts:190-226`, which **already**
returns `durable: Promise<void>` so a caller can await commit before exposing an item.

A repo-wide search finds no `src/` caller of `rememberAndSerializeExtraContent` /
`rememberExtraContentForReplay` outside the module and one test. So WP4 begins with
a discovery step: identify the live call path (or establish there is none yet). If
no caller exists, the emit-before-commit defect is **not live** and that half of the
work-phase is NOOP with evidence — not a fix invented to match the audit.

The swallowed-failure half is real: `:149` discards persist errors.

Minor: `src/responses/parser.ts` needs no change; `:39` calls
`lookupReplayThoughtSignature`, which derives the key internally.

## File change map

| File | Change |
|------|--------|
| `src/responses/thought-signature-replay.ts` | restart-stable identity in `keyFor`; `version: 3` + migration decision; typed persist failure instead of a silent discard |
| `src/server/responses/core.ts` | supply the restart-stable identities to the scope ref (read-only addition) |
| `tests/thought-signature-replay-scope.test.ts` | **new file** — cross-account / cross-destination / rotation isolation; restart-stability; upgrade test proving no stale-key hit after the version bump |

## Accept criteria (with activation)

1. Two accounts sharing thread+provider+model never read each other's signature.
   *Activation:* two writes under different credential identities, one lookup each,
   assert miss.
2. Same across two destinations for one provider name.
3. A key written before restart is still readable after a simulated restart
   (reload from disk) — the regression the naive fix would cause.
   *Activation:* write, drop the module cache, reload, assert hit.
4. A `version: 2` file on disk does not produce a stale-key hit under `version: 3`.
5. A persist failure surfaces a typed error rather than a silent success.

Verifier: `bun test tests/google-signature-history-roundtrip.test.ts` — the existing
coverage of this module; there is no `tests/thought-signature-replay.test.ts` on disk
(round-2 audit blocker A). Add `tests/thought-signature-replay-scope.test.ts` as a new
file for criteria 1-5, and run `tests/reasoning-replay-identity.test.ts` to prove the
sibling in-memory cache is unaffected by the identity plumbing.

## Credential-identity specifics (round-2 audit, non-blocking finding)

The restart-stable discriminator exists for OAuth and does not for key auth:

| Auth mode | Material | Restart-stable? |
|-----------|----------|-----------------|
| OAuth | `accountId` + `generation` (`reasoning-replay-cache.ts:150`) | yes, and already non-secret — use it directly |
| Key | derived from `provider.apiKey` (`:163`) | value is stable but is raw secret material; needs a persisted-salt digest, or scope to destination only |
| `local` | `credentialIdentity` is `undefined` (`core.ts:329`) | n/a |

So the honest-scoping fallback binds only for key auth; do not discard OAuth
scoping because one mode is hard. And because `keyFor`'s guard is all-or-nothing,
a required credential field would make `authMode: "local"` providers stop
remembering entirely — the policy for that case must be stated in the
implementation, not left to the guard's default.

## Closure

File the issue with these conditions, implement, close citing the merge SHA and the
isolation + restart test output. If the discovery step shows no live caller, the
issue records that finding instead of claiming a fix.
## Outcome (executed) — discovery done, implementation deferred with reasons

**The caller-discovery step resolved the open question, and the answer changes the
shape of the work.** The round-1 audit could find no `src/` caller of the remember
API and concluded the emit-before-commit defect might not be live. It is live. The
callers are in `src/bridge.ts`, and they discard the durable promise explicitly:

```ts
void rememberExtraContentForReplay(currentToolCall.callId, currentToolCall.providerMetadata, replayCacheScope);
...(rememberAndSerializeExtraContent(...).extra ?? {}),   // durable dropped
emit("response.output_item.done", { output_index: currentToolCall.outputIndex, item });
```

in the streaming close path (freeform and function-call branches) and again on the
non-streaming `pushOutput` path.

**Why this is not a one-line fix.** `closeCurrentToolCall` is a *synchronous* closure
writing into a `ReadableStream` controller. There is no `await` at that point, so
"await durability before emit" requires either an async close path or a pre-emit
barrier — a change to the streaming core, which `AGENTS.md` gates behind the full
suite and which sits next to the subagent-fallback synchrony invariant documented in
the repository root. That is its own work-phase, not a rider on a scope fix.

**Filed as #1926** with both halves, the restart-stability constraint, the
OAuth/key/local credential-identity split, the `version: 2` → `version: 3` migration
requirement, and the exact caller locations. Terminal outcome for this cycle:
**NEEDS_HUMAN on sequencing** — the fix is well-specified and the constraint that
blocked the naive version is written down, but landing it means touching the
streaming emit path, which deserves a maintainer's call on scheduling rather than an
agent slipping it into a wave.
## Amendment after the WP4 audit — the destination half landed

The reviewer pushed back on deferring the whole key-scope fix, and was right. The
restart-stability blocker binds to the **credential** component only:
`provider.baseUrl` is configuration, stable across restarts by construction, and the
only reason today's `providerDestinationIdentity` is unstable is that it runs through
the random-keyed HMAC. A plain digest of the same normalized URL is equally
non-reversible here. This document already sanctioned that fallback — *"scope the fix
to destination only"* — and then deferred the branch it had pre-authorized.

Landed in `ebab9d253`:

- `durableReplayDestinationIdentity()` beside the process-local form (not replacing it —
  the in-memory cache is right to prefer the random-keyed version).
- `providerDestinationDurableIdentity` threaded through the identity type and `core.ts`.
- The durable `keyFor` includes it, closing cross-endpoint collisions under one provider name.
- `load()` reads the store version for the first time; `STORE_VERSION = 3` drops v2
  entries explicitly instead of letting them go dead and age out invisibly.

Ablation: removing the destination component fails the new cross-endpoint test while the
restart test stays green — the pair that matters, since the naive fix would have passed
the first and broken the second.

### Corrections to this document and to #1926

The audit found four errors in what I wrote, all corrected on the issue rather than
edited away:

1. **A third call site.** `failCurrentToolCall` discards the durable promise too, at two
   more sites, reached from six places including the stall watchdog. The writeup named
   only `closeCurrentToolCall` and `flushToolCall`.
2. **The `local` claim was backwards.** Those providers already never remember — `core.ts`
   only binds `scope.current` when credential *and* destination exist. There was no
   regression to protect against.
3. **The version mechanism was mis-stated.** `version: 2` was written and never read, so a
   bump would have invalidated nothing. Fixed by actually reading it.
4. **A fourth auth mode.** Codex pool auth rides a rotating bearer — the worst
   restart-stability story of the four, and absent from the table.

And one correction to the deferral reasoning itself: the streaming call sites are already
inside an `async` loop, so the obstacle there is the reentrancy guard, not the absence of
an await point. The real blocker is `buildResponseJSON`, a synchronous public export with
three callers. Awaiting a disk write per tool call would also put fsync latency on the hot
path, which argues for a turn-end barrier rather than per-item awaits.
