# 020 — contracts and qualification ledger

Status: implemented contracts with focused evidence; final qualification is tracked
in 030 and the local PR verification packet, not inferred from historical help.

## Native contract

The gateway uses the integrated experimental `thread/queue/add` RPC, with one
connection for discovery, revalidation and submission. Validated native IDs and
text echo establish queued; a correlated rejection establishes not_sent.
Post-write cancellation, malformed/lost receipts and route loss remain unknown.
Nothing retries a possibly submitted message.

Stock `codex-cli 0.160.1` was exercised in a separate credential-free home with
a synthetic local provider. Executable SHA-256:
`f34a4d2301892ae96c90097786bfe5dc269f187b6f69faf42a7b357b8c081e35`.
The real daemon accepted the gateway request, completed a synthetic turn and sent
a return response through the authenticated route. This is Linux evidence,
not macOS or production-node qualification.

Separately, a disposable loopback OpenSSH server with generated keys proved
fingerprint confirmation, private enrollment, separate -L/-R routes, request and
response and complete owned cleanup. Native endpoints in that SSH fixture are
strict offline Unix fixtures. These two receipts are complementary, not a claim
that the combined real-SSH/real-native matrix ran.

## Fixed aggregate contracts

One foreground owner covers at most four peers, 16 admitted connections, 32 active
requests, ten helpers (eight persistent tunnel children plus two transient control
or inspection children) and 2 MiB accounted input/output. Connections admit at
most four pending requests, frames at most 1 MiB, state at most 128 KiB and helper
stdout/stderr at most 64 KiB each. There is no waiting queue. Full capacity refuses
before allocation, and release is idempotent.

Setup uses one 30-second budget across peers and stages. Authentication is bounded
to five seconds, route refresh to ten seconds, leases to 25 seconds. Connections
last at most 30 seconds. Owned cleanup has a three-second ceiling with TERM then
KILL; concurrent shutdown joins the same flight. Escaped process groups are not
claimed to be terminated; retained pipes are canceled. Logical helper operations
settle after bounded cleanup; unresolved physical children retain their reservation.
Withdrawn published routes remain part of the owner's final cleanup join.

## Regression mapping

| File in tests/codex-integration | Evidence covered |
| --- | --- |
| messaging-remote-contract.test.ts | Direction/nonce/identity proofs; exact RPC admission; metadata projection; no native attachment before auth; replacement listener gets no client proof/body; upgrade and capacity refusal; revocation. |
| messaging-remote-store.test.ts | Absent reads stay absent, strict bounded schema, private ownership/mode/symlink/file guards, locking, secret omission. |
| messaging-remote-enrollment.test.ts | Explicit receiver enable, immutable transaction, fingerprint mismatch, lost-reply reconciliation, generation-bound journal ownership, concurrent completion, removal and journal-failure ordering, full registry refusal. |
| messaging-remote-send.test.ts | Same connection, machine-aware replies, return-only receiver, strict receipts, unload, source admission revalidation after awaits, lost/malformed receipts, no replay. |
| messaging-remote-lifecycle.test.ts | Inert imports and pure parser, owned cancellation, shared cleanup/output limits; published and unpublished tunnel cleanup joins both helpers, including failure. |
| messaging-remote-process.test.ts | Bounded logical settlement for unresolved exit and failed stdin, retained physical reservations, persistent/transient caps and injected Darwin listener inspection. |
| messaging-remote-interop.test.ts | Opt-in generated-key loopback SSH enrollment, duplex delivery and zero owned reservations after cleanup. |
| messaging-remote-native.test.ts | Opt-in explicit stock binary, real queue/turn contract in isolated home, synthetic provider and return delivery. |

Existing local messaging and shared SSH policy regressions are part of integrated
validation. Import-graph selection alone cannot cover source-oracle, subprocess or
golden-file guards; run those explicitly.

## Remaining gates

Full-suite qualification remains incomplete: the existing runner stopped its
parallel lane after 900 seconds, exit 124; serial lanes were not reached. The
local PR packet records the resource exception, observed failures, focused
coverage and commands instead of claiming a passing full suite. No ratchet,
timeout or required check was relaxed.

A later bounded `test:changed` attempt selected 979 of 2,222 files and exceeded its
explicit 180-second runner ceiling, exit 124, without a final count receipt. It is
also incomplete, not passing; final focused regressions cover subsequent changes.

Required exact-head hosted CI once publication is authorized and macOS
interoperability remain outstanding. Local checks and independent source review
are recorded separately from maintainer acceptance and operational qualification.
No receipt from an unrun or skipped tier is described as passing.

Unreleased security assessment material belongs in ignored scratch or managed
scan artifacts, never in this public planning ledger.
