# Orphaned Remote Link Child (#8243)

## Failure and hypotheses

`src/client/runtime.ts` binds a startup connection snapshot; `src/client/machine-listener.ts`
reports tunnel readiness without checking that snapshot against the durable connection. Meanwhile,
`src/client/connect.ts` refuses disconnect after the record disappears unless a disconnect receipt
already reached the clearing phase. Pinned sync in `src/client/sync-expectation.ts` correctly refuses
the missing connection and must keep doing so without writes.

Possible causes of the missing record include an old whole-config writer, a concurrent config
mutation, or an external replacement. An audit of config persistence and regression fixtures can
exclude or demonstrate individual cooperating writers; it cannot identify the historical external
writer without evidence from the affected machine. The runtime symptom is falsified if readiness
changes when only durable ownership changes; the disconnect symptom is falsified if the existing
locked transaction can complete from a missing record and safely identified artifacts.

## Design and verification

Use durable connection identity as the authority for listener readiness and status. A missing,
invalid, or different owner/link is distinct from a tunnel failure. Do not derive a connection
from health, tunnel state, or catalog. Revalidate under the existing lifecycle and config locks
before any cleanup; preserve unknown or replaced credentials, sidecars, Desktop state, and Codex
state. Only remove artifacts with independently established ownership, and make interruption and
concurrent reconnect safe. Preserve pinned sync's exit 5 and no-write contract.

Add failing-first focused tests for the stale listener, orphan cleanup, replacement races and
negative ownership cases. Audit whole-config writers and protect a proven cooperating overwrite
where feasible. Update the owning structure and user-facing docs. Run focused tests, typecheck,
`test:changed`, structure and privacy gates, and the docs build; document unrun coverage.

## Open recovery question

The existing `client-link.json` carries a link ID and tunnel details, but no token fingerprint.
The token file and this sidecar can each have been replaced independently. An absent connection
therefore does not establish that the present token belongs to the sidecar, and a token read
followed by compare-and-swap alone only proves that the token did not change during cleanup. A
recovery implementation needs an independent owner witness and a safe path for legacy orphans;
it must not interpret sidecar presence as proof of token ownership.

## Explicit legacy recovery

The operator can instead authorize preservation of the unowned files explicitly with
`ocx disconnect --orphaned-token --yes`. This is a recovery action, not a connection
reconstruction: it moves the service token and any rotation backup to a private directory and
prints its location and restoration guidance. Under the existing start ownership lease and client
lifecycle lock, check that no client runtime is live, treating unknown as a refusal; under the
config mutation lock recheck disconnected state, pending-connect marker, disconnect receipt, and
token file identities immediately before moving. Hub role, admission-secret use and installed or
unverified service definitions refuse recovery. On Windows, private hard links retain file identity
while source handles close before rename. Refuse unsafe paths and preserve all backup bytes if any
part fails. The normal disconnect, sync and enrollment paths retain their ownership checks.
