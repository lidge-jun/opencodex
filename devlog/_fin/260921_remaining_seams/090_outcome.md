# Outcome

All four lanes are on `dev`, and the seams they were opened for are closed.

| Lane | Landed as | What it changed |
|---|---|---|
| N1 | `2cc11b780a` | The routed Claude Messages error path now carries the replay-refusal code, `x-should-retry: false` and no `Retry-After`, so a refusal no longer reaches that endpoint as an ordinary retryable rate limit. The transient-5xx to 529 mapping the client relies on for backoff and the policy for a genuine provider 429 are unchanged |
| N2 | `ebaf78a46c` | The scope reconstructs each exact outbound identity through the namespace and wire aliases before judging a call, so an allowed call restored from its alias survives sparse-terminal reconstruction. Authorization keys carry kind, namespace and name, so a shared bare name no longer grants another namespace or another kind |
| N3 | `03ab5bfb11` | `applyExplicitChatReasoningWirePolicy` owns the gateway-object form and the tool-bearing effort omission, and both the translated and native builders call it. It is a no-op when neither setting is recorded, and the native path still copies its preserved Chat-only fields verbatim |
| N4 | `bd4822bcea` | A conjunction selector now needs an explicit marker, so a legacy single-criterion value containing a comma keeps its old meaning. The whole recorded path is validated before traversal, and an unreadable selector stays attached to the file its record names as unsafe rather than moving the operation elsewhere |

## Found while waiting

A manual full-matrix run on one lane's branch exposed a Windows-only defect that
pull-request CI never ran: the desktop release-asset test took a basename with
`path.split("/")`, which is not a separator on Windows, so it compared whole
`C:\…` paths against asset names and five shards failed. Fixed in
`e2453085b9` by asking the platform for the last segment. The release matrix
would have hit it.

## Verification

Each lane merged on its own exact head with every requested job green. The four
landed seams were then re-read on the integrated tip and all five acceptance
statements hold at source level.

Two CI conditions shaped the pace and are worth recognising next time. Duplicate
runs for one head appear regularly and one of them is cancelled by concurrency;
a cancellation is not evidence in either direction, and the remedy is to re-run
the failed jobs of the real matrix rather than to read the rollup. Hosted macOS
capacity was saturated for much of this batch, with single jobs queued for over
an hour, which is why the last two merges trailed the rest.

## Not in this unit

The two retry issues left open after the first batch keep their recorded scope:
a mid-turn transport death still has no fallback, and a provider 429 on a single
key still has no cooldown policy. Neither is decided by anything landed here.
