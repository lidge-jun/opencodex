# wp6 — Complete integration recovery, maintenance settings and Hub observation

Depends on wp5. Class C3 with C4 destructive/ownership review. Layer 5.

## Exact command and module changes

| Command | Existing authority and payload | Files |
| --- | --- | --- |
| claude desktop profile show --json | GET /api/claude-desktop on current management runtime; existing desktop show stays local | NEW src/cli/claude-desktop-profile.ts; MODIFY claude-desktop.ts dispatch |
| claude desktop profile import FILE --json | Bounded DesktopProfile parsed by existing validator; PUT {profile}, save only, separate existing apply. Preserve conflict/unavailable-model/applied-marker guards | same module; no server behavior change |
| integration client enable --client droid --reasoning-default MODEL=EFFORT (repeatable) / --clear-reasoning-defaults | Existing integration payload gains droidReasoningDefaults; same map in any adopted preview/apply plan; no other client accepts it | MODIFY integrations.ts; NEW integration-input.ts if needed |
| integration client history remove --op ID --yes --json [--client aside --profile N] | DELETE exact global/Aside/profile journal path with op identity; newest-row refusal, missing row and snapshotRemoved:false retained | NEW integration-journal.ts; wire integrations.ts |
| integration client sync --client aside --json | Reuse refreshAsideProfilesThroughServer, not broad sync; report per-profile partial failures nonzero; no profile override | integrations.ts/aside-profiles.ts existing helper |
| integration native cursor status/local-installer --json | Fixed existing Cursor GET routes; installer read never installs | MODIFY inspect.ts; small sibling if needed |
| remote-workspace hub status/runtimes/sessions --json | Fixed Hub GET routes; keep existing remote-workspace status executor-local | NEW remote-workspace-hub.ts; MODIFY remote-workspace.ts |
| storage policy set --archived-bytes-over N [--reduce-to-bytes N or --remove-oldest-percent N] | PUT nested trigger.archivedBytesOver and exclusive target shape; retain --percent alias; never implicitly enable | MODIFY storage.ts |
| link revoke --link-id ID --force --yes --json | Only explicit force sends body {force:true}; CLI output explicitly derives remoteCleanup:skipped/unverified from force intent (the endpoint returns only linkId), with a remote disconnect recovery hint. Never claim a failed remote attempt. Ordinary revoke default unchanged | MODIFY link.ts |

## Preview and optional checked commit

Add integration client preview --client ID --operation apply|overwrite|disable [--profile N] [Droid defaults] --json and integration client restore --op ID --preview [--client aside --profile N] [--confirm-drift] --json. NEW src/cli/integration-preview.ts owns response/target validation; wire existing integrations.ts.

Generic preview POSTs /api/client-integrations/preview {clientId,operation,droidReasoningDefaults?}; generic restore preview POSTs /api/client-integrations/restore/preview {opId,confirmDrift?}. Aside always uses /api/client-integrations/aside/profiles/N/preview with operation and optional restore intent. No aggregate Aside preview. All use existing admin management admission, not a GUI-session workaround.

The returned version-1 plan has clientId, operation, optional profileId, state/foreignEdit, changes, fingerprint, canApply and willChange. It is an observation, not a stored authorization. Validate identity and render refused/no-op/applicable states distinctly. Fingerprint versions are p[0-9]+ with the supported hash shape; never accept an unbound marker.

Existing enable/disable/restore gain optional --plan-fingerprint TOKEN. Derive operation from the actual command, enabled and overwrite intent, then send the flat pair operation + planFingerprint (not a nested plan object). Repeat exactly the preview's profile/opId/confirmDrift/Droid defaults. No required new preview step for direct legacy commands. Stale 409 returns a failure/re-preview instruction and never silently commits the returned replacement fingerprint. Reject --preview combined with --plan-fingerprint before any request. A stale-plan failure tells the operator to rerun the explicit preview; no unvalidated error-body dump is added to legacy stderr. Add tests/cli/cli-integration-preview.test.ts with real server plan/binding tests for unchanged, changed file/roster, wrong action/profile and passive-cache-unavailable scenarios.

No new management authority or automatic GUI-session bootstrap. Remote Workspace enroll/start/prompt/revoke and SSH fingerprint/credential workflows remain current consent-session exclusions; Hub read commands do not unlock them. Client-role refusal is truthful. File-client apply/restore retain direct mode; the new optional preview/bound mode covers the GUI inspection workflow. No speculative snapshot or provider refresh occurs inside preview.

Update capabilities-integrations/access-remote/observe-system, remove fulfilled route deferred entries, regenerate chapters and update skills/ocx remote/recovery recipes plus public integration/storage/remote docs. Structure owners: cli-management, clients/integrations, clients/claude-desktop, remote-workspace, remote-link and storage ownership. No GUI component changes or installation/service deployment.

NEW tests/cli/cli-claude-desktop-profile.test.ts, cli-integration-journal.test.ts, cli-integration-droid.test.ts, cli-aside-sync.test.ts, cli-integration-cursor.test.ts, cli-remote-workspace-hub.test.ts, cli-storage-policy-fields.test.ts, cli-link-force.test.ts. Existing server integration/journal/Aside-owner/storage policy/link tests prove persistence/ownership contracts.

## Activation matrix

A wrong client/profile, missing op, nonconfirmed delete/force, newest journal row, concurrent profile save during the live handler and unreadable file must not silently mutate. A failed live profile save never writes local profile. Partial Aside results stay visible in both modes. Forced link results say remote cleanup was skipped/unverified, derived from the explicit invocation; do not invent a server residual field. Hub empty devices differs from unavailable Hub; executor status does not substitute. Cleanup targets cannot combine, omitted enable stays unchanged, integer boundaries reject incorrect shapes. Explicit security review checks irreversible backup retirement, credentials/trust boundaries and forced link semantics.

## Shared completion contract

This phase follows 002_terminal_ux.md and 003_verification_strategy.md. Main owns registry/dispatch integration, layout-map registration, generated output and Git branch state; executor write scopes are disjoint and named before B. Existing method/path/body semantics come from the referenced source inventories, not endpoint-name guessing.

Update the phase's capability domain, generated references, relevant public CLI pages and owning structure contracts in the same layer. Every new test file enters scripts/test-layout/layout.json and tests/fixtures/test-layout-expected.json. Existing tests are retained; no baseline cap increases or green-on-retry acceptance.

Planned new test paths below become executable verification only after B creates them. The current baseline gates in 003 have actually run. C invokes the exact focused files, typecheck, structure and skill-surface checks, privacy where data is handled, a source-bound cxc receipt and real isolated CLI QA (stdout/stderr/exit/teardown). A successful function mock is transport proof only; relevant existing server tests or isolated real handlers verify accepted state. No live user proxy, credentials or upstream requests.

Before P>A, revalidate this document against the parent layer and record the prior D conclusion. Consult an architect for actual decision changes; independent A review is separate. C must preserve saved-versus-applied/refused outcomes. D records exact checks and ledger evidence before the next cycle. Publishing is main-owned; this request stops at open PRs.
