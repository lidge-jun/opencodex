# 010 — wfb: count sends and children over a window, not over a lifetime

## Today

```ts
export function workflowSendCeilingReached(rootId, policy) {
  const state = roots.get(rootId);
  return state !== undefined && state.sends >= policy.maxPhysicalSends;
}
```

`state.sends` only ever grows. `state.children` is a Set that only ever gains
members. Neither has a clock. A root that made 256 sends in its first hour is
refused for the rest of the process even if it sends nothing for a day.

## The change

Keep the counters, add a window. A root records its sends as timestamped buckets
and the ceiling compares the count **inside the window** against
`maxPhysicalSends`. Distinct children get the same treatment: a child seen once,
hours ago, and never again should not hold a slot forever.

The default window has to be argued for rather than picked. 256 sends is the
number already in the tree and it was chosen against a fan-out, so the window is
the interval over which that fan-out would be abusive. A ten-minute window keeps
the original intent — seven hundred sends in a minute is still refused several
times over — while an ordinary session that averages well under a send every two
seconds never approaches it.

`maxConcurrentChildren` stays as it is. Concurrency is already instantaneous; it
has no lifetime problem to fix.

## What must not change

An unconfigured install must not see a refusal it would not have seen before.
Windowing only ever admits more, never less, for the same traffic — the count
inside a window is bounded by the lifetime count — so this direction is safe by
construction. Say so in a test rather than trusting the argument.

The eviction rules from #4546 stay: a root is evicted only when it is both
inactive and not exhausted, and a full table refuses rather than laundering a
fan-out into a fresh allowance. A windowed root that has aged out of its window is
no longer exhausted, which is exactly the state that makes it evictable again.

## Acceptance

1. A root at the ceiling is admitted once its window rolls, without a restart.
2. A burst inside one window is still refused at the same count as before.
3. Distinct children age out of the window the same way sends do.
4. Bucket storage per root is bounded; a root that sends forever does not grow
   forever.

