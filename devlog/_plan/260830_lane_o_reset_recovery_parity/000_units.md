# Lane O — connection-reset recovery parity on the sidecar and loop legs

Unit for the work-phase that followed Lane N. Its trigger was a hook restating
issue #2885 fallout as "the web-search sidecar ignores `upstreamHttpVersion` and
skips the fresh-connection retry treatment". Half of that was already shipped;
the other half turned out to be wider than the sidecar.

## What was already true

PR #2908 (`22f2df614`) landed the transport-pin half. `src/web-search/loop.ts:326`
resolves `deps.incomingMeta.providerFetch`, both send legs use it, and
`src/server/responses/core.ts:5006` rebuilds it at send time so a 429 rotation
cannot pin a stale credential. `src/web-search/executor.ts:77` wraps the sidecar
leg in `withUpstreamHttpVersion(forwardProvider)`. Nothing in that description is
outstanding, and no part of this unit re-does it.

## The gap that was real

`applyUpstreamRecoveryInit` (`src/lib/upstream-retry.ts:295`) exists for one
reason: Bun has ignored the hop-by-hop `Connection: close` header
(oven-sh/bun#20492), so leaving a half-closed pooled socket needs the
transport-level `keepalive: false` extension as well. Setting the header alone
lets the retry land back on the same dead socket.

The main lanes call it — `src/server/chat-native.ts:207`,
`src/server/responses/compact.ts:715`, and six sites in
`src/server/responses/core.ts` (3831, 3902, 4103, 4163, 5521, 6038). The
web-search loop and the images loop take the `retryRecovery` argument
`fetchWithResetRetry` hands them, spend it on `deps.onAttemptSend` telemetry, and
then build a plain init. Every sidecar executor passes a zero-argument thunk: it
still retries, but it cannot ask for fresh-connection recovery.

Be precise about the consequence. `fetchWithResetRetry` retries a reset up to
three times, and on these legs each replay stays *eligible* to reuse the pooled
socket the reset came from — not guaranteed to, since the pool may hand out
another. That is enough to make recovery a matter of luck, and the retry then
reports as exhausted rather than as the pool problem it is. It matches the
failure shape #2885 reported without explaining it, and this unit does not claim
to close that issue.

`src/adapters/kiro-retry.ts` already hand-rolls the same two fields (header at
168, `keepalive` at 173) and is out of scope; an independent audit confirmed it
correct.

## Diff

Thread the recovery init through the legs that already receive the recovery kind,
and give the sidecar thunks the argument they were missing:

- `src/web-search/loop.ts` and `src/images/loop.ts` — pass the existing
  `retryRecovery` through `applyUpstreamRecoveryInit`, preserving the
  `accept-encoding: identity` handling and the provider-scoped executor.
- the sidecar executors — accept the recovery argument and route their init the
  same way, composed so a protocol pin and the recovery fields cannot displace
  each other.

## Composition constraint

`withUpstreamHttpVersion` spreads `{...(init ?? {}), protocol}` and is typed to
return `RequestInit | undefined`; `applyUpstreamRecoveryInit` spreads
`{...init, headers}` and adds `keepalive`. The order is not free. Recovery goes
**inside**:

```ts
withUpstreamHttpVersion(url, applyUpstreamRecoveryInit(baseInit, recovery), provider)
```

so the recovery helper always receives a defined init and the version helper
spreads the result, keeping headers, `keepalive`, body, signal, and redirect
alongside `protocol`. The reverse nesting needs a `?? baseInit` fallback to type-check
at all and would otherwise dereference the `undefined` branch. An independent
audit probed the composed object under Bun and observed `protocol`,
`keepalive: false`, `connection: close`, the body, and `redirect: "manual"`
surviving together. The regression asserts a pinned provider still sees its
`protocol` on the replay.

What is not verified: no wire capture was taken. Under an HTTP/2 pin,
`Connection` is a prohibited hop-by-hop header and Bun may normalize it away
while still honoring `keepalive: false`. The same canonical helper already runs
on provider paths that support an HTTP/2 pin, so this is a documented unknown
rather than a reason to exclude a site.

## Evidence standard

A green suite proves nothing here. Each assertion is driven red by reverting its
own site to the plain init, and any assertion that stays green under that
mutation is deleted rather than kept.
