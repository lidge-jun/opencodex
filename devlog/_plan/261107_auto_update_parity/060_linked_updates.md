# Linked-machine updates — draft unit

**Status:** depends on the signed supply and local update contracts; architecture,
transport authority and independent security audit are unresolved. Do not
implement from this draft yet.

## Outcome

The proposed operator experience would show and control eligible Home and Child
updates, including per-machine state, deferral and failure. Automatic work would be permitted only when
the destination's own setting allows it, the exact artifact is signed and
verified, the destination identity and installer ownership are established,
compatibility is known, and the guarded stop/drain and idle admission succeed.
The Home must not report an offline, stale, unverified or unsupported Child as
updated. All tests use isolated homes, fake links and local mock supply.

## Proposed transport and durable state

Use the existing host-key-pinned, non-interactive SSH exec transport for
Home-initiated links (`src/link/ssh-argv.ts:1`, `:70`) and select the Child
executable once, as the pinned sync path does (`:244`). Client-initiated links
without an authorized Home-to-Child exec route are explicitly unsupported until
a separately audited transport exists. Keep the management relay read-only
(`src/link/management-routes.ts:1`); peer reports are compatibility
observations, not authorization (`src/link/peer-report.ts:1`).

Proposed new CLI operation is `ocx link-update` with `prepare`, `status`,
`commit` and `cancel` subcommands and a versioned bounded JSON request/result
schema: `ocx.link-update.envelope/1`, `ocx.link-update.request/1` and
`ocx.link-update.result/1`. Inputs include an operation UUID, exact link id, candidate identity,
destination policy revision, plan identity and expiry. A `status` read is
idempotent; `prepare` and `commit` record their operation ID before work;
replaying the same request returns the recorded state, while a conflicting
request with the same ID is refused. `cancel` cancels only an uncommitted
operation; after a handoff the caller observes it rather than starting another.
Transport request data is passed as bounded structured input, not interpolated
into shell commands. The Home stores an atomic fleet journal before activation
with target identities and per-Child outcomes, then resumes observations after
its own restart. A healthy Home already at the selected version satisfies the
Home-first prerequisite. A stale or unverified Home does not.

The proposed exact envelope is `{schema, keyId, payload, signature}` with
`schema: "ocx.link-update.envelope/1"`; `payload` is base64url of the exact
UTF-8 request bytes and the signature covers those bytes and a protocol-domain
separator. The closed request has `schema`, `action`, `requestId`, `nonce`,
`issuedAt`, `notAfter`, `fleetId`, `homeId`, `childId`, `configurationId`,
`installationId`, `linkId`, `linkBindingEpoch`, `grantId`, `grantEpoch`,
`operation` and action-specific `args`. `prepare` names the destination policy
revision and exact signed candidate digests; `commit` names the prepared handle,
plan digest, expected operation revision and Home health barrier; `cancel`
names the operation and expected revision; `status` is a read-only discovery or
one-operation query. Each action is separately signed and cannot carry an
arbitrary executable path, command or download URL. Bound the encoded envelope
and result to 64 KiB, decoded request to 32 KiB, input to five seconds, and
request validity to five minutes; these are proposed testable limits.

The response `ocx.link-update.result/1` binds `requestId`, request digest and
nonce, destination and grant/binding identities, operation identity/revision,
durable phase, bounded reason, candidate and policy revision, and separate
`commitAccepted`, `mutationStarted`, `installationVerified`, `runtimeHealthy`
and `rollbackVerified` observations. It is signed by the enrolled destination
response key under a separate domain. Unknown schema, malformed encoding,
duplicate keys, mismatched request binding or unavailable identity is a refusal
or unknown result, never success. These schemas require independent security
review and an exact implementation-level field chain before the plan is locked.

The Child independently checks its durable link connection under the lifecycle
and configuration locks used by its existing expectation check
(`src/client/sync-expectation.ts:108`), its own opt-in policy/revision, selected
executable and install owner, capability, exact signed candidate and fenced
idle admission. SSH authentication alone and the unkeyed plan-consistency hash
(`src/update/orchestrated-token.mjs:3`) are not a replacement for destination
consent or operation authorization. The request proof, replay journal and
lock ordering need a concrete protocol and independent security review before
the roadmap is locked; this paragraph does not claim those controls exist.

The independent `auto-update-linked-authority-research-01` lane recommends a
separate Home update signing key and a destination-local grant bound to the
Home, Child, installation and link generation. Creating or approving that grant
is an explicit action by the destination owner; an agent must not auto-answer
it, and old links get no implicit update authority. Separate local policy
controls preparation and activation. A Home request cannot enable a disabled
destination policy or clear its deferral. Key provisioning, response proof,
rotation and revocation are proposed design work, not existing features or a
security PASS; tests use isolated keys and homes only.

Proposed owner-facing local commands are `ocx link-update grant list --json`,
`ocx link-update grant approve --request <local-request>`, and
`ocx link-update grant revoke --grant <id>`. Approval and revocation act only
on the destination's local grant store and require the repository's existing
person-consent boundary; a Home request may present a public-key enrollment
request but cannot approve it. The CLI registry, capabilities and generated
skill surface advertise the new contract only once dispatch and grant
operations exist. A lost approval response is reconciled by grant ID, not
automatically approved again. No agent or test may approve a real user's grant;
tests use isolated fake destinations.

The proposed grant store is `<configDir>/link/update-grants.json`, owned by
the destination account and written atomically with the existing private-file
policy. Each strict `ocx.link-update.grant/1` entry contains `grantId`,
`grantEpoch`, `homeId`, `homeUpdatePublicKey`, `childId`, `configurationId`,
`installationId`, `linkId`, `linkBindingEpoch`, `apiKeyId`, `scopes`,
`expiresAt`, `revoked` and `childResponsePublicKey`. The destination response
public key is enrolled with the grant; private key material belongs in the existing secure
credential owner, never in a status projection or source control. Grant
approval, revocation, connection change and local policy changes serialize
with the durable destination binding. The precise key-storage adapter and
person-consent API must be verified against existing platform implementations.

The proposed key owner is a new `src/link/update-key-store.ts`, independent of
provider API-key accounts. Store the Home update signing key and each Child
response private key under the respective owner's private link directory using
the existing no-follow, owner-only file and required Windows ACL patterns
(`src/codex/installation-id.ts:19`, `:40`); verify a newly written public key
against the private key before publishing a grant. Never print, transmit or
copy private keys into journals, status or config. An OS keyring may be used
only through an explicitly tested adapter; locked/unavailable storage refuses
the operation rather than generating a replacement identity or falling back
silently. File ownership and ACLs protect the account boundary, not against an
arbitrary process already acting as that account. Tests use temporary homes
and generated fixture keys only.

The explicit local grant approval must validate the presented Home public key,
link identity, scopes and expiry and require the destination owner's action;
an incoming Home request cannot approve itself. For CLI-driven approval use the
existing agent-driven and interactive-consent controls
(`src/cli/agent-driven.ts:60`, `src/cli/interactive-confirm.ts:1`), with a
separately reviewed dashboard equivalent if one is added. Refuse absent or
unreadable local consent and persist the approved binding before returning
success. Revocation is an owner action and never waits for Home reachability.

Binding migration must cover the actual writers, not just the connection type:
`commitClientConnection` and `clearClientConnection` in
`src/client/state.ts:202`, `:230`; connect/rotation and disconnect in
`src/client/connect.ts:577`, `:1193`; Child-initiated link sidecar publication
and removal in `src/client/link-join.ts:159` and `src/client/link-state.ts:129`,
`:149`; Home link creation, enrollment, compensation and revocation through
`src/server/management/link-routes.ts:99`, `:233`,
`src/server/management/link-enrollment.ts:165` and
`src/server/management/link-route-state.ts:153`. The current Child sidecar
parser has an exact field set (`src/client/link-state.ts:46`): define and test
an explicit old-record migration before adding any field, and preserve its
fail-closed marker behavior. Search all config and key writers again when the
unit begins; this list is a reviewed starting point, not proof of exhaustiveness.

On relink, ownership change or key rotation, first persist the invalidation of
the old binding under the relevant locks, then publish the new connection; a
crash between them leaves update access disabled and requires a new local
grant. On revoke, mark the grant revoked and advance its epoch durably before
acknowledging, then stop future prepare/commit dispatch. An already accepted
operation is reconciled by its destination owner to a safe outcome; revocation
does not authorize a second installer or erase its recovery record. Status
under an invalidated binding is available only to the local owner; a stale
remote grant receives a refusal. Add focused tests for each writer,
interrupted invalidation, concurrent commit/revoke and old-record migration.

For each operation, persist request identity and a monotonically increasing
destination operation revision before starting work. Identical retries return
the recorded outcome; conflicting reuse is refused. Cancellation and commit
compete in a single durable transition; cancellation after accepted commit is
too late, and recovery continues under the destination owner. An expired or
lost request is observed through a new status request, never blindly replayed
as a fresh install. Windows SSH currently ties the selected command to the
channel lifetime (`src/link/remote-windows.ts:37`), so a destination-owned
worker handoff must be proven on that platform before accepted work is claimed
to survive disconnect.

The proposed lock order is `U → O → A → N → L → C → J`: existing home
sync/update mutex (`U`), proposed installation-wide ownership coordination (`O`), link apply
exclusion (`A`), native integration (`N`), client lifecycle (`L`), config
mutation (`C`), then a short journal transaction (`J`). Existing client code
documents `N → L → C` (`src/client/lifecycle-lock.ts:1`); the combined order
is a proposed extension and must be proven against every caller; `O` is not an
existing installation-wide lease. No inner lock
is held over SSH, installer execution or readiness waits. Preparation holds
only a stage lease while waiting; activation reacquires and revalidates the
relevant owners. A durable binding epoch must change before a relink, key
rotation or installation-owner change can become effective.

Compatibility for the future Home/Child pair must be established from signed
release capability metadata for each candidate, rather than extrapolated from
current peer reports. Unknown or invalid future compatibility defers. A Child
that cannot update through its actual installer reports a specific unsupported
or owner-action state. The full installer/platform matrix and target metadata
format remain open deliverables, not a diagnostic-only completion condition.

The signed compatibility descriptor must bind each exact release artifact and
its provided/required link protocols, update actions, recovery protocol,
installer adapter and fleet-journal reader versions. Before Home-first
activation, check the current pair, the new Home with each old Child, the new
Home with each new Child, Child recovery under the new Home, and Home recovery
after a Child has moved. Unknown pairs defer. After Home restart, obtain fresh
identity and health evidence before resuming Child commits; a healthy Home
already on the selected signed artifact can satisfy the prerequisite without a
new update. Initial rollout activates one Child at a time, and post-update
catalog sync is reported separately.

`003_contracts.md` defines the closed descriptor and exact-pair comparison.
Add `src/link/update-compatibility.ts` and
`tests/clients/link-update-compatibility.test.ts`: consume only descriptors
validated by the shared supply parser and compare each required Home/Child and
recovery pair. Validate the Home fleet journal reader and destination adapter
for the actual operation, not merely one matching link protocol. The release
unit owns generation and parser vectors; this unit owns the comparator and
fleet gating. Older artifacts without authenticated descriptors stay unknown
until the publisher provides a descriptor bound to their exact bytes or the
owner performs an explicit manual bootstrap. This proposal does not assert
that historical descriptors already exist.

The Home-first barrier applies to a coordinated fleet operation, not to every
independent server update. An owner may request an individual Child update
while Home remains on its current release if the authenticated descriptor
proves that current Home and both the target and recovery Child are compatible.
The Child may also follow its own enabled signed channel and idle policy while
the Home is offline. Such work retains destination consent, signed supply,
durable operation identity and guarded activation. This preserves the
independence documented by GOAT (`docs/internals/remote-updates.md:21`, GOAT
reference revision); lack of a live Home is not permission to weaken those
local checks. Fleet Home-first resumption and individual Child operation need
separate tests and status.

Independent automatic updates may race, so a comparison of only today's peer
versions is insufficient. For an offline or uncoordinated move, require both
the currently installed artifact and its target/recovery artifacts to carry the
same publisher-authenticated `compatibilityEpoch` and
`compatibilityVectorSha256` described in `003`; each endpoint retains the
last verified peer epoch/vector and installation binding. This is a
publisher-certified invariant over every artifact in that epoch, not a claim
that a peer observation is fresh. A target that changes either value cannot
activate independently: it must use the coordinated fleet transition, which
holds the fleet generation lease and checks all transitional/recovery pairs.
An unknown, revoked or unavailable epoch also defers. A current peer reading
is still required before a coordinated commit; an old authenticated reading is
not treated as current. An operator may perform a separately authorized manual
recovery if coordination is unavailable, without weakening signature or owner
checks.

The release build must derive the compatibility vector from the owning feature
and protocol declarations and prove the epoch invariant in release tests; a
publisher must not reuse an epoch after a compatibility change. Add
`tests/clients/link-update-compatibility.test.ts` cases where Home and Child
simultaneously validate their old peer and select individually compatible but
mutually incompatible targets: changed epochs must refuse independent
activation. Also test matching epoch/vector with an offline Home, stale or
revoked descriptors, rollback targets and a coordinated breaking transition.
Before a coordinated epoch change, the Home durably records the transition and
obtains an authenticated generation-bound update fence from every participating
Child. Each Child closes new independent admission, reports and reconciles any
already accepted operation, and retains that fence until the Home commits or
cancels the same fleet generation. An offline or uninspectable participant
blocks that breaking transition; the coordinator must not infer an ack from a
stale report. Lost acknowledgements are read back against the same generation,
and a restarted coordinator reconciles the durable fences before dispatching.
Test an independent update accepted just before the fence, one racing it, a
lost acknowledgement and offline participants. Existing same-epoch automatic
updates can resume only after their local fence is released or reconciled.
This permits independent updates only where the signed compatibility horizon
proves the resulting cross-product, and remains a design pending security and
release review.

The proposed Home journal is `<configDir>/link/fleet-updates.sqlite`; the
Child journal is `<configDir>/update/link-operations.sqlite`. Both use private
permissions and durable transactions. The Home stores fleet ID, generation,
frozen member/link identities, exact artifact digests, Home health barrier,
per-Child operation IDs, request digests, latest authenticated result and
separate sync outcome. The Child stores grant/binding epochs, operation sequence,
request digest, local policy revision, prepared-stage identity, durable phase,
installer/stop receipts and outcome. Request or result secrets are not logged.
Home startup takes one fleet lease, reconciles unresolved intents before
dispatch, re-proves its own target/health and establishes a fresh barrier;
Child startup reconciles its own unfinished operation before accepting another.
The initial implementation must prove SQLite durability and platform file
ownership using isolated crash/restart tests, not just schema serialization.

## Existing owners and candidate change map

| Operation | Path | Before → proposed after |
| --- | --- | --- |
| MODIFY | `src/link/compatibility.ts`, `src/remote/features.ts`, `src/link/peer-report.ts` as needed | Reuse authenticated relay and peer-feature compatibility (`compatibility.ts:71`); advertise a versioned update capability only when it is actually implemented. Unknown and older peers stay readable but are not admitted to unattended replacement. |
| NEW / MODIFY | `src/cli/link-update-command.ts`, `src/cli/dispatch.ts`, `src/cli/registry.ts`, `src/cli/capability-contracts.ts`, `src/cli/capabilities-base.ts`, `skills/ocx/` | Add separate local grant and remote operation entry points, advertise `link-update/1` only when implemented, and regenerate the CLI skill surface. Preserve existing command output and use the established person-consent controls for grant changes. |
| MODIFY | `src/client/connect.ts`, `src/client/state.ts`, `src/types/config.ts` and all connection-state readers identified by search | Create and persist a binding epoch, parse older records safely, invalidate grants before connect/disconnect/rotation or installation ownership changes, and recheck the same binding under existing locks. The full writer/consumer list and migration tests must be enumerated before implementation. |
| NEW / MODIFY | `src/link/` update orchestration sibling, `src/cli/sync-fanout.ts`, `src/cli/sync-command.ts` | Existing fan-out selects known linked Children and bounds work (`sync-fanout.ts:99`, `sync-command.ts:207`). Reuse identity, deadline and per-child verdict patterns while keeping update and catalog sync separate contracts. Establish whether a shared runner is appropriate before editing. |
| MODIFY | `src/link/ssh-argv.ts`, `src/link/remote-windows.ts` only after design approval | For Home-initiated SSH, select the existing pinned executable, frame its output and carry an exact validated update request; never interpolate untrusted shell text. Preserve existing `sync --expect-link` behavior. |
| MODIFY | `src/update/orchestrated-plan.ts`, `src/update/orchestrated-entry.ts`, `src/update/orchestrated-admission.mjs` only where required | Existing plan rejects ambiguous ownership, source/desktop/mise installs and downgrades (`orchestrated-plan.ts:21`); reuse plan token, deadline, installer and observed-result contracts, adding exact verified artifact and destination-bound authorization without weakening them. |
| NEW | Destination-owned policy, operation journal and admission modules under the established owners | Persist explicit local enable/defer policy and bounded status. Recheck link identity, consent, signed target, compatibility and idle immediately before mutation. The owner and wire schema need architect and security review. |
| NEW / MODIFY | `desktop/src-tauri/src/link_update_bridge.rs`, native update owner in `desktop/src-tauri/src/updater.rs`, `src/link/` destination worker | A destination-owned Desktop app accepts only a locally granted, operation-bound request and applies it through its existing native updater, consent policy and Stop/Quit-aware recovery. A package worker never replaces a Desktop bundle. An offline app, absent local grant or unverifiable app identity returns owner-action/unknown; completing this unit requires supported remote Desktop activation, not a permanent refusal. |
| NEW / MODIFY | `src/server/management/link-update-routes.ts`, `src/server/management-api.ts`, `src/server/management/route-registry.ts`, `gui/src/remote-link-update-api.ts`, `gui/src/pages/RemoteLink.tsx`, `gui/src/components/remote-link-update-panel.tsx`, all GUI locales and relevant docs-site locales | Register the separate versioned status/action endpoints below, parse their DTOs in the GUI and render destination status, retry and Later. Preserve `parseRemoteLinkStatus` and the old `/api/link/status` response. Never claim completion until destination evidence proves version and health. |
| MODIFY | `tests/cli/sync-fanout.test.ts`, `tests/clients/link-peer-compatibility.test.ts`, focused `tests/update/` and `tests/clients/` | Cover authenticated identity, mixed old/new peers, Home/Child ordering, duplicate requests, deadlines, signed payload mismatch, busy/idle races, recovery and sync interaction using isolated fixtures. Register new domain test files in both layout maps. |
| MODIFY | `structure/remote-link.md`, `structure/remote-messaging.md`, `structure/ops/service-and-sidecars.md`, other source owners from the index | Review both `src/link/` owners (`structure/INDEX.md:366`); record actual post-change ownership, wire schema, compatibility, outcomes and invariant tests in affected docs. |

### Dashboard management boundary

`src/server/management/link-update-routes.ts` owns separately registered
`GET /api/link/updates/v1/status`, `POST /api/link/updates/v1/action` and
`GET /api/link/updates/v1/action-result?requestId=<uuid>`;
`src/server/management-api.ts` dispatches the sibling through its existing
on-demand management composition and `route-registry.ts` records both methods
and the mutation. Both require the existing operator-paired dashboard session
(`link-route-state.ts:67`); reject admin-token-only, unpaired, Tailscale
identity, passive relay and snapshot-capability callers. Keep existing CSRF,
origin, body and mutation controls, and prove the new handler is never exposed
through the read-only link management relay. Neither endpoint can approve,
create, widen or revoke a destination grant or alter destination policy.

Status returns a closed `ocx.link-update.dashboard-status/1` object with
`schema`, `fleetId`, `fleetRevision`, `destinations` and `nextCursor`. A page
contains at most 100 destinations; `nextCursor` is null at the end or an opaque,
bounded server-issued cursor bound to fleet ID/revision and this paired session.
The only optional query is `cursor`; stale or invalid cursors refuse rather than
mixing revisions, and the GUI restarts the read on a changed fleet revision.
Each item has
`linkId`, `bindingEpoch`, `operationId`, `operationRevision`, `candidateId`,
`destinationPolicyRevision`, `lastActionRequestId`, `phase`, `reason`, `commitAccepted`,
`mutationStarted`, `installationVerified`, `runtimeHealthy`, and `deferred`.
Nullable identities and outcomes mean unknown, never success. `phase` is one
of `unknown`, `unavailable`, `eligible`, `preparing`, `ready`, `deferred`,
`committing`, `installed`, `healthy`, `failed`; `reason` is a bounded closed
code, not raw remote errors. Values come from the local durable Home journal
and authenticated Child result; the DTO is display evidence only. A stale or
offline Child remains unknown/unavailable and cannot be called healthy.
`lastActionRequestId` is null or the newest journaled dashboard request for the
link, including an unresolved request. It lets a newly opened GUI recover the
request identity after a tab or Home restart; it is not an action capability.

The closed action request `ocx.link-update.dashboard-action/1` contains
`schema`, fresh UUID `requestId`, `action` (`retry` or `later`), `linkId`,
`bindingEpoch`, `operationId`, `expectedOperationRevision`, `candidateId` and
`destinationPolicyRevision`. Require exact keys, bounded bodies and matching
journal/binding/policy revisions; null operation/candidate is rejected for an
action. `later` durably suppresses this candidate for that destination until an
explicit retry or a different verified candidate; it never cancels a committed
handoff or changes the Child's policy. `retry` clears that local deferral only
after rechecking destination grant, local policy, compatibility, candidate,
identity and admission; a new operation is allowed only after reconciliation of
the old one. The response contains `schema`, `requestId`, `operationId`,
`operationRevision`, `disposition` (`pending`, `accepted`, `deferred`, `refused`
or `uncertain`) and `reason` (a bounded code or null), with literal schema
`ocx.link-update.dashboard-action-result/1`. It is an acknowledgement, not proof of
installation. Before external effects, atomically persist `requestId`, SHA-256
of the exact accepted request bytes, original operation ID A, destination/link
and binding identity, and a pending receipt. The journal then records resulting
operation ID B (or null), resulting revision and disposition. On repeated POST,
look up request ID and compare the exact-body digest before stale-revision
checks: identical bytes return the existing pending or recorded receipt only;
a different digest refuses. Neither replay nor a readback may issue an effect.
First execution still validates current grant, policy, binding, candidate,
operation revision and owner before dispatch. A crash between journal and
dispatch is reconciled by the durable Home owner and destination protocol;
pending does not mean the effect did or did not occur.

The separate `action-result` GET requires a newly authenticated paired session,
accepts exactly one UUID `requestId` and returns a closed bounded
`ocx.link-update.dashboard-action-readback/1` object: `schema`, `requestId`,
`requestDigest`, `linkId`, `bindingEpoch`, `originalOperationId`,
`resultingOperationId`, `operationRevision`, `state` (`pending`, `recorded`,
`unknown`) and `disposition`/`reason` (nullable until recorded). For `unknown`,
all evidence fields except `schema` and requested `requestId` are null. A known
request is looked up from the durable Home journal, not from the currently
observed peer; after relink or grant revocation it is historical evidence only.
Unknown, expired or pruned records return null evidence and `unknown`, never
evidence that an effect did not occur. Retain unresolved requests and their
operation bindings until reconciliation; a bounded terminal-retention policy
may prune only settled receipts. After a lost response, GUI reload, Home restart
or session replacement, the GUI recovers `requestId` from its pending request or
the status projection, reads that exact request, then observes resulting B if
known. An unresolved or unknown result disables further effectful retry until
owner reconciliation; no mere possession of the request ID grants authority.

`gui/src/remote-link-update-api.ts` strictly parses these separately versioned
objects; `RemoteLink.tsx` renders a sibling
`gui/src/components/remote-link-update-panel.tsx` keyed by link and operation,
without appending fields to `parseRemoteLinkStatus`. On a 404 or unsupported
schema from an older server, show an unavailable state and disable actions;
never infer success. Unit `080` uses this same Home-side DTO after its own
Child-pull authority and durable operation contract are implemented. Add
`tests/server/link-update-dashboard-routes.test.ts`,
`tests/clients/link-update-dashboard.test.ts` and
`gui/tests/remote-link-update-panel.test.tsx` as future tests, with the two
root-test layout registrations where applicable. Cover paired versus unpaired,
admin and relay rejection, malformed and stale revisions, old servers, mixed
links, offline status, Later persistence, revocation/policy change, duplicate
requests, A→B Retry with a lost acknowledgement, identical replay before stale
revision rejection, conflicting request bytes, pending/unknown retention,
repaired sessions, Home restart, pagination and both SSH and Child-pull
transports, and translated accessible
states. A reachable implementation and these tests require separate security
review; these DTOs themselves are not authorization.

The Desktop bridge is a separate local owner IPC, not a call to privileged
WebView commands. The native app creates an owner-private endpoint under its
validated update-operation directory: a Unix-domain socket on macOS/Linux or a
current-user-ACL named pipe on Windows. Its private identity record binds app
PID/process instance, install ID, endpoint and a fresh secret; the destination
worker validates file ownership, challenges the live app and binds the reply to
the same connection and process instance before sending the already signed,
bounded request. The app verifies the destination-local grant, link binding,
policy, candidate and operation revision again, then invokes its existing
native update owner; neither the IPC caller nor the dashboard gets an install
path or verification bypass.

Each IPC request carries operation ID/generation and a nonce plus a body-bound
capability derived from the private app secret; the reply binds that request
digest, nonce and native owner generation. Record `accepted` durably before a
success reply. Repeated identical requests read the same operation; changed or
stale requests refuse. The app and its separately signed guardian preserve the
journal and reconcile after application exit; a lost IPC reply is observed via
the destination journal, not retried as a second install. If the app is not
running or its identity/endpoint is unknown, return owner-action/unknown; do
not start or replace it as a package. Add isolated POSIX and Windows IPC tests
for forged or stale app identity, unauthorized callers, changed grant/policy,
lost replies, process exit, concurrent native-page/remote actions and Stop/Quit
intent. The IPC boundary is separate from the bundled update-page guard
(`desktop/src-tauri/src/lib.rs:272` at the inventory baseline) and requires
independent security review.

## Required activation scenarios

1. For a fleet operation, Home is updated and proven healthy before Child
   commits; for an independently requested Child operation, the current Home and
   target/recovery compatibility can authorize the Child without updating Home.
   Each eligible Child uses its own exact target and independently verifies the
   signature. Catalog synchronization remains separately reported.
2. A disabled or deferred Child, changed link identity, disconnected Child,
   unknown capability, incompatible protocol, source/mise-owned install,
   missing signature or target downgrade produces a specific non-success state
   without touching the installation. Device-side consent is not inferred from
   Home control alone.
3. An active request or unknown idleness defers. If idleness, identity, policy,
   target, owner or plan token changes after planning, a fresh admission refuses
   before any mutation; the existing stop/drain path never interrupts a request.
4. A timeout or disconnected client cannot be called success. A Child that
   continues after a lost reply is observed rather than blindly retried; a
   failed or rolled-back target is not automatically retried in a loop. Result
   readback verifies version and health, with explicit uncertain outcomes.
5. Old peers and malformed/unknown capabilities cannot acquire update authority;
   standard sync remains functional. Exercise POSIX and Windows command framing,
   duplicate and partial outputs, concurrent operations and isolated fake feeds.
6. A linked Desktop owner applies an authorized request only through its native
   updater; missing local consent, a stopped/offline app, changed native owner or
   busy activity is reported without a package installer taking over. Test both
   successful native delegation and refusal, including Stop/Quit intent.

## Candidate verification

Run red-to-green focused fan-out, compatibility, orchestrated-update and new
integration tests, including subprocess/source-read files explicitly. Run
`bun run typecheck`, `bun run privacy:scan` and `bun run structure:check`;
validate relevant GUI locales/build if visible UI changes, and obtain a separate
independent security PASS. Exact commands and evidence that they reach the
changed paths must be established before locking the plan. No full root suite;
required exact-head PR CI and any authorized platform proof remain mandatory.
