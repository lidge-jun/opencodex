# ADR-6480 — decision recorded under "Foreground routes and aggregate ownership"

- Contract owner: [remote-messaging.md](../remote-messaging.md#foreground-routes-and-aggregate-ownership)
- Status: implemented contribution candidate; upstream architecture acceptance remains separate.

## Decision record

Intent: extend the integrated local foundation with individually enrolled remote
Codex delivery and replies, without coupling messaging to proxy startup or importing
the broader local experiment's coordination/UI/cross-harness features.

Alternatives: implicit proxy-owned listeners; direct full native app-server tunnels;
independent per-peer budgets; copied SSH policy; credential-bearing URL/upgrade
headers after an unrelated identity probe; or one foreground owner with shared
policy, connection-bound authentication and one aggregate budget.

Choice: explicit enable/enrollment and foreground serve, separate -L/-R children
using unchanged Remote Link argv builders, expiring return leases and receiver-issued
directional capabilities. The wrapper authenticates each actual data connection
with mutual capability-derived proofs before native initialization/body submission.
It retains strict same-connection native queueing and no replay after uncertainty.

Consequences: ordinary proxy/local paths stay inactive; receiver-only peers need no
reverse SSH credentials. Owners must remain running and cannot transparently retry
lost sends. Raw native queue clients are not gateway clients. State and runtime
evidence distinguish enabled, running, initiated and leased rather than inferring
processing. Same-uid session identity is descriptive, not a new security boundary.

Contract review, independent security review, exact-head validation and maintainer
acceptance are still needed before merge. No mesh, management UI, cross-harness
permission model, managed skills or idle-trigger policy is implied by this decision.
