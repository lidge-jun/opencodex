# 100 — Post-split rebase of the stack

## What changed under us

The mega-file split landed while this work was open:

| PR | Merge |
|---|---|
| #2019 WP1 types | `da86a830a` |
| #2023 WP1b clusters | `2235f456d` |
| #2036 WP2a config leaf | `eca18d0c8` |

`src/types/tools.ts` now exists on `dev` and `OcxTool` lives there. **#1934 also
merged** (`a5289aad5`), which `070` had named as the real collision hazard for
`#1587` — it touched all five of that fix's files.

So both of `#1587`'s blockers cleared at once. It moves from "last, most
contested files" to implementable.

## Rebase

Bottom-up, three branches, **zero conflicts**:

```
fix/service-proxy-env       eb910776a -> d7caaa9bf
fix/tray-registry-encoding  e3b063750 -> f1f400fea
fix/cursor-abort-teardown   346eaa80d -> 2c4e00ede
```

Zero conflicts is the expected result and not the interesting part: none of the
three fixes touches `types.ts`, `config.ts`, or anything the split moved. That
was the collision analysis in `070`, and it held.

## The verification that actually mattered

A green result from *before* the rebase proves nothing here — the split replaced
`types.ts` with a barrel and moved every type cluster, so the whole tree these
branches compile against is different.

Re-run on the rebased top of stack:

```
bun test service + tray + windows-text + cursor-cancel + cursor-eof
  163 pass / 0 fail
bun x tsc --noEmit
  exit 0
```

## Deferred items: what is still blocked

Re-checked live rather than carried from the previous turn:

| PR | State | Consequence |
|---|---|---|
| #2029 | OPEN, `CHANGES_REQUESTED` | `#2114` still must not get a competing PR |
| #2101 | OPEN | `#2108` phase 1 still collides on `server/index.ts` + `auth-context.ts` |
| #2054 | OPEN, `CHANGES_REQUESTED` | the kimi-k3 and 429 halves of `#1527` still cannot start |

Only `#1587` actually became unblocked. The other three deferrals stand for the
same reasons they were recorded, which is worth stating explicitly — "the split
landed" is not a general unblock.
