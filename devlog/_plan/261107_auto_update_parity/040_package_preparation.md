# npm package preparation and activation — draft unit

**Status:** depends on signed supply and automatic admission; independent
architect reflection and roadmap audit are pending. Do not implement yet.

## Goal and current behavior

Support user-controlled staged automatic updates for eligible package-owned
installations while preserving each package manager's ownership, the
sync/update mutex, guarded runtime stop and recovery. npm already stages beside
the live tree and then swaps with backup and rollback, but preparation and
activation are currently one transaction
(`src/update/transactional-install.mjs:388`, `:410`, `:475`). pnpm operates on
its selected global owner (`src/update/pnpm-global-install.mjs:472`); safe
independent staging for pnpm and Bun remains to be demonstrated. Existing
`ocx.update.plan/1` and `ocx.update.result/1` consumers retain their contracts.

Automatic preparation must use independently reviewed verification and preserve manager ownership. Any manager without a proven safe preparation and recovery contract remains unsupported.

pnpm's global virtual store and Bun's global metadata/shims need distinct
adapters and isolated proof that the exact signed local bundle can be installed
without fetching or executing unsigned dependencies, and that signed previous
bytes and the manager's links can be restored. Do not rename pnpm store entries
or treat `bun add -g` as preparation. They are separate in-scope units `090`
and `100`; this npm unit cannot close them.

Preparation holds only its own stage lease; it does not hold the sync/update
mutex while waiting for a person or idle. Activation reacquires the existing
home-scoped sync/update mutex and service ownership guard, and obtains the
installation-wide coordination and runtime reservation proposed by `020` only
after those mechanisms are designed and proven. It revalidates the stage and
policy before performing the receipt-backed stop and atomic swap. The
complete lock order and process-exit fencing must be proven against the
selected manager and platform before the unit is audited.

The existing `OCX_DISABLE_UPDATE_CHECK=1` environment opt-out
(`src/update/refresh-scheduler.ts:35`) overrides automatic package checks and
downloads even if the stored policy requests them. An explicit manual check
remains available; any new update flow, including a manual install from its
panel, requires the signed-supply verification. Existing explicit CLI behavior
is inventoried separately and is not silently reused as an unsigned fallback. Turning the
environment opt-out off does not clear the user's persisted policy or a
candidate deferral; the UI explains the effective state.

Persist an operation journal with exact candidate, previous version, owner,
stage identity and `prepared` / `activating` / `observing` / `healthy` /
`failed` / `uncertain` state. Require signed, verified recovery material before
unattended activation. Observe the owned target's version and health within a
30-second initial window and retain rollback material for a ten-minute
probation; do not restore stale data over a newer owner's writes. A failed target
is not retried automatically. A manager unable to guarantee these conditions is
explicitly unsupported until its own implementation unit proves them.

## Candidate change map

| Operation | Path | Before → proposed after |
| --- | --- | --- |
| MODIFY | `src/update/transactional-install.mjs` and sibling modules | Extract owner-held `prepare` and `commit` around current isolated staging, tree verification, authorization, swap and rollback. A prepared handle binds verified candidate, exact installation, policy revision and stage identity. Preserve legacy command interfaces and process-tree exit fences while requiring verified supply for installation. |
| MODIFY | `src/update/orchestrated-plan.ts`, `src/update/orchestrated-entry.ts`, `src/update/orchestrated-node-driver.mjs`, `src/update/orchestrated-session.mjs` | Add a separately versioned automatic preparation/activation contract around the existing identity-bound plan and mutation lease. Enumerate construction, transport, decoding, admission and every consumer before locking design; reject stale policy/owner/candidate. Do not change exact-key existing JSON silently. |
| REVALIDATE | `src/update/pnpm-global-install.mjs`, Bun-owned update paths | Verify their existing command interfaces and ownership refusals remain unchanged in this unit. Their signed-supply migration and manager-specific automatic implementations belong to `090` and `100`. |
| MODIFY | `src/update/refresh-scheduler.ts`, package update coordinator sibling | Discovery remains read-only with existing opt-out, cache and backoff; the separately persisted policy owns whether an exact signed target may be downloaded or activated. Integrate admission unit `020`, failed-target suppression and serving-target health readback. |
| NEW | `src/update/automatic-policy.ts`, `src/server/management/update-policy-routes.ts` | The package owner stores a strict `ocx.update.policy/1` record under its effective OpenCodex configuration directory, atomically updates it with a revision check, and exposes authenticated policy reads/changes through the management owner. Only an independently established first installation uses documented defaults; missing after initialization, ambiguous, corrupt or unreadable policy disables automatic effects and requires recovery. Never use a dashboard snapshot as authorization. Wire the route through the existing registry with focused authorization tests. |
| MODIFY | `tests/update/update-transactional.test.ts`, `tests/update/update-orchestrated-*.test.ts`, `tests/update/update-pnpm.test.ts`, `tests/update/update-sync-mutex.test.ts`, relevant CLI/GUI tests | Add red-to-green signature, stage integrity, owner, lease, process-exit, retry, policy and race cases using isolated homes and local fake installers. Register new domain test files in both test-layout maps. |
| MODIFY | `structure/ops/service-and-sidecars.md`, `structure/ops/update-supervised-recovery.md`, `structure/ops/desktop-supervision.md`, any other mapped owners; docs-site and matching locales | Describe actual supported managers, controls, recovery and manual guidance. |

Existing explicit package commands retain their current behavior until a
manager's verified-supply migration ships. The planned migration preserves
their argument and result interfaces, but may refuse an installation that the
current command permits when verified supply is unavailable. Ship each
manager's migration only after its signed adapter, recovery and compatibility
tests pass; `090` and `100` own pnpm and Bun respectively. Document the change
and supported manual alternatives. Until then, do not claim those managers
have verified automatic updates or silently change their existing commands.

### Package policy contract

The proposed `src/update/automatic-policy.ts` would own the strict `ocx.update.policy/1` record
at `<configDir>/update-policy-v1.json`: `schema`, nonnegative safe-integer
`revision`, `channel` (`latest`, `preview`, `nightly`), `check` and `download`
(`automatic`, `manual`), and `install` (`manual`, `when-idle`). Only an
independently established first installation may use the verified installed
channel provenance in `010` and automatic check/download with manual install.
A missing policy after initialization, or ambiguous initialization state, is a
recovery error that disables automatic effects; it must not reset earlier
manual choices. The package owner must preserve a durable revision high-water
mark and refuse recovery if it cannot establish a fresh revision. Test policy
deletion after a manual choice, owner restart and stale requests. Missing or ambiguous
provenance is `channel-unknown`, not a version-derived preview fallback; an owner
can explicitly choose a channel and establish verified provenance. If the current
channel or install owner cannot be determined, report unknown and do not start
automatic effects. This default permits preparation without a surprise restart;
the current explicit user action is still needed to install until changed.
The Desktop owner additionally supports `on-quit` (`030`); package-owned
background services have no Desktop quit event and reject that value rather
than inventing one. The shared parser accepts the union, and each owner enforces
its own supported values before persisting.

Use `withConfigMutationLockSync` (`src/config/mutation-lock.ts:96`) for a
short compare-and-swap transaction around an atomic, private no-follow file
write. Parse a valid record and compare `expectedRevision` before writing the
next revision; an unreadable, malformed or unknown-schema existing record is
not treated as missing. Lock/write failure or revision overflow changes
nothing and returns a bounded error. Persist candidate deferral and failed
target identity in the operation owner, not in the channel cache; a policy or
owner change invalidates stale prepared authority. Revalidate the revision at
each effect boundary. The `OCX_DISABLE_UPDATE_CHECK=1` process override blocks
automatic checks and downloads without rewriting the stored policy; the status
must distinguish configured from effective behavior.

Add authenticated `GET /api/update/policy` and `PUT /api/update/policy` to
`src/server/management/route-registry.ts` and its management dispatcher, with
closed JSON objects and the existing management authentication/CSRF boundary.
GET returns `{schema, policy, effective, error}` where `effective` includes
the environment override and nullable unavailable reason. PUT accepts exactly
`{expectedRevision, channel, check, download, install}` and returns the new
status or a conflict without writing. These routes do not authorize an install
and must not accept the desktop snapshot capability. Old update/check/status
and badge schemas stay unchanged. Add domain-registered
`tests/update/update-automatic-policy.test.ts` and
`tests/server/update-policy-routes.test.ts` for defaults, invalid/missing
records, concurrent revisions, failed writes, environment override, old-client
compatibility and authorization; no real user home is used.

## Required scenarios

- Valid signed exact candidate stages without stopping or replacing the running
  proxy. Missing, wrong-key, altered, changed target, untrusted transitive
  executable or unconfirmed installer exit prevents activation and leaves the
  live install untouched.
- Policy, owner, serving root, target, staged tree identity and idle admission
  are revalidated before swap. A sync/update conflict, altered stage, changed
  channel, ownership handoff or stale reservation refuses without mutation.
- Installation failure restores and verifies the prior tree and applies the
  existing manager-aware runtime recovery. A success is distinguished from a
  target version serving and passing health; uncertain outcomes never trigger a
  duplicate install. Failed targets do not loop automatically.
- Test npm independently on supported platforms; retain interface and ownership
  regressions for unchanged pnpm and Bun explicit paths. Their signed-supply
  migration belongs to `090` and `100` after each adapter is proven.
  Unsupported or externally managed
  installers display an honest actionable reason. The `090` and `100` units
  remain open until their own automatic adapters are proven.

## Candidate verification

Run focused transactional, orchestrated, mutex, supervisor and manager tests
with isolated homes, test keys and mock feed; demonstrate red then green for
the new behavioral regressions. Explicitly run subprocess and source-oracle
tests. Run `bun run typecheck`, `bun run privacy:scan`, `bun run structure:check`,
the core Lab boundary test, and exact-head required PR checks. Obtain an
independent security PASS for package installation and signing. Resolve exact
test commands and prove their input coverage before locking the roadmap. No
full root suite; the coordinator receives a PR and evidence, not a merge.

Baseline verifier discovery, 2026-11-07: `bun test
tests/update/update-orchestrated-plan.test.ts` passed seven tests using
temporary homes and injected child behavior. `bun test
tests/update/update-transactional.test.ts -t 'manifest verifies|happy path
swaps'` passed two tests and filtered out ten; it uses temporary package trees
and an npm stub. These checks exercise existing plan and transactional owners,
not signature verification or the proposed split prepare/commit contract.

`bun test tests/update/update-refresh.test.ts -t 'package cache refresh'`
passed 16 tests with 17 filtered out (exit 0) against the existing scheduler's
injected clock and lookup. This verifies existing refresh/coalescing/backoff and
opt-out behavior; it does not read a future policy file or prove signed updates.
