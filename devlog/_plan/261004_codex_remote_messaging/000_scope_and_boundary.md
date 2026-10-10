# 000 — remote Codex messaging: second contribution

Status: implemented locally; bounded contribution qualification recorded. No publication,
deployment or maintainer acceptance of the remote boundary is implied.

## Baseline and direction

The contribution branch is rebuilt on upstream `dev`
`a47a1b52a94ef3d65d8435944bd4e6bf34a2e622`, containing integrated local messaging
[PR #6544](https://github.com/lidge-jun/opencodex/pull/6544).
It does not carry the superseded local PR commits.
The broader deployed experiment remains separate.

[Proposal #6478](https://github.com/lidge-jun/opencodex/issues/6478) and
[scoped lifecycle feedback](https://github.com/lidge-jun/opencodex/issues/6478#issuecomment-5975718099)
require a bounded optional owner, aggregate cross-peer limits, idempotent owned
cleanup and no replay. Foreground ownership is a revisable proposal, not accepted
remote architecture. Enrollment/authentication/SSH require independent review.

## Included scope

- CLI-only Codex-to-Codex delivery to exact loaded recipients on individually
  enrolled SSH peers, selected by exact alias or machine UUID.
- Explicit enable, fingerprint probe/confirmation, enrollment, list, removal,
  status and foreground `ocx message serve`.
- Stable per-configuration-home machine identity and protected directional
  capabilities, with versioned SSH-stdio enrollment and retained transactions
  for unknown enrollment outcomes.
- IPv4-loopback gateway: mutual capability-derived proofs on the actual data
  connection before attaching to the existing native Unix daemon. No capability
  in URLs, argv, upgrade headers, ordinary receipts or logs.
- Initialization, loaded discovery, projected metadata and direct experimental
  `thread/queue/add`; no generic RPC, lifecycle, turns or approval/config writes.
- An owned -L/-R pair and bounded return lease support replies without a second
  SSH login. Live owner proof, not persisted ports, establishes route readiness.
- Discovery, final recipient revalidation and queue submission share one
  authenticated connection; exact receipt correlation, queued/not_sent/unknown,
  and no automatic resend.
- Shared owner-wide capacities, cancellation, shutdown, focused regressions,
  isolated real-SSH and stock-native qualification, docs and ownership records.

## Deliberate exclusions

No mesh/coordinator, dashboard/API, caches, isolation policy, Claude, managed
skills, prompt/delegation policy, idle triggers or session creation/resume.
No proxy startup hook, daemon start/restart/install, remote installation or
automatic tunnel recovery. Unrelated local extensions are not carried.

The gateway is a protected OpenCodex wrapper protocol, not a native WebSocket
endpoint: raw `codex queue --remote` does not perform its mutual proof handshake.
Native daemon auth/configuration is unchanged. SSH provides network encryption;
capability proof is endpoint identity/admission, not transport encryption or a
same-UID isolation boundary.

## Publication boundary

Prepare a local PR description and exact-head evidence. Do not push or open the
next PR without user direction. Reference #6478 rather than closing the broader
proposal. Linux qualification does not establish macOS interoperability; required
current-head hosted CI and maintainer/security acceptance remain separate gates.
