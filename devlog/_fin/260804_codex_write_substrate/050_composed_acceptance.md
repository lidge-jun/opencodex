# WP13 — composed acceptance at the production boundary

The failure this phase prevents is not a bad helper. It is a system in which each
helper passes its own tests while one production path still writes around the
substrate. That is already the current shape: startup restores a journal before the
server exists (`src/cli/index.ts:169-176`), server construction rewrites
`models_cache.json` directly (`src/server/index.ts:362-403`), sixteen management
call sites invoke a swallowed best-effort catalog writer
(`src/server/management-api.ts:105-112`), explicit restore writes history inline
(`src/codex/inject.ts:764-794`), and the retry guardian gives up after sixty ticks
(`src/codex/history-migration-guardian.ts:34-35,87-90`). A phase-local green test
can miss every one of those seams.

This document specifies the one acceptance program, split across a workstation-safe
suite and a disposable-host service job, that is allowed to claim C1-C18 for the
composed system. All citations were rechecked on 2026-08-04 at
`ee182744af6958478523fb97ece6af2efb63b082`. The substrate modules named by
`005_contract.md` do not exist at that revision; the current red signatures below
are therefore predictions grounded in the production call graph, not claims that
an unimplemented suite was run.

## IN / OUT

IN: a future `tests/codex-composed-acceptance.test.ts` plus narrowly named child
fixtures under `tests/helpers/`; the production CLI, server, management routes,
convergence entry point, real filesystem, real Bun Workers, and real SQLite files.
Service-manager entry points are a separate disposable-host runner at
`scripts/disposable-host/codex-service-composed-acceptance.ts`; they are not part
of the developer-workstation invocation or Bun's ordinary test discovery.

OUT: mocks of `convergeCodex`, direct calls to phase-local gather/commit/history
helpers as acceptance proof, the live proxy on port 10100, the user's homes, the
owner's installed service and service-manager registrations, GUI controls, six file
integrations, release/deploy/publish work, arbitrary filesystem ABA, and historical
edit-and-revert detection.

## The proof rule

Every acceptance case has two required observations:

1. **RED on the pre-substrate revision.** Run the same case against the parent of
   the substrate implementation and capture the named failure below. A compile
   failure caused only by a missing future import is not enough when the current
   production path can be exercised; the red artifact must show the current wrong
   byte, wrong ordering, blocked listener, bypass, or terminal retry state.
2. **GREEN on the composed revision.** Run through the production entry point and
   read back native bytes, the sole integration record, lock/history state, HTTP
   response, and child exits as applicable. A spy count or green helper test alone
   is not acceptance evidence.

The suite records the parent SHA, composed SHA, case id, entry-point id, child PIDs,
temporary roots, transition ids/generations, and the red/green oracle. This is how
we know a test is not decoration that passes on both revisions.

## Production entry-point census — 36 rows, two execution classes

The count is by independently invokable command/route or independently scheduled
production path. Aliases that execute the same branch are one row. The management
surface has **14 route shapes and 16 current catalog-write call sites** because
`PUT /api/provider-context-caps` has three mutation branches.

| ID | Production entry point | Current write/reconciliation edge |
|---|---|---|
| P01 | `ocx init` / `ocx setup`, answer Yes to injection | dispatches `runInit` (`src/cli/index.ts:727-732`), which saves config and calls `injectCodexConfig` (`src/cli/init.ts:176-198`) |
| P02 | `ocx start` | dispatches `handleStart` (`src/cli/index.ts:734-736`) and calls `syncModelsToCodex` after bind (`src/cli/index.ts:318-321`) |
| P03 | foreground start graceful shutdown / process-exit cleanup | the start-installed cleanup calls `restoreNativeCodex` (`src/cli/index.ts:240-266`) and is registered for signals and exit (`src/cli/index.ts:284-310`) |
| P04 | `ocx ensure` | live and newly spawned branches call `syncModelsToCodex` (`src/cli/index.ts:358-381,398-412`) |
| P05 | `ocx sync` | dispatch calls `syncModelsToCodex` (`src/cli/index.ts:827-842`) |
| P06 | `ocx sync-cache` | directly calls `invalidateCodexModelsCache` (`src/cli/index.ts:849-855`) |
| P07 | `ocx restore` / `ocx eject` | dispatch calls `restoreNativeCodex` (`src/cli/index.ts:745-790`) |
| P08 | `ocx restore back` | the reverse branch calls `syncModelsToCodex` (`src/cli/index.ts:747-764`) |
| P09 | `ocx stop` — **disposable host only** | `handleStop` calls the globally addressed service manager before restoring native state (`src/cli/index.ts:456-551`), dispatched at `src/cli/index.ts:737-743` |
| P10 | `ocx uninstall` / `ocx remove` — **disposable host only** | stops and removes a globally addressed service before restoring native state and deleting owned OpenCodex state (`src/cli/index.ts:554-638`), dispatched at `src/cli/index.ts:795-798` |
| P11 | `ocx recover-history --legacy-openai` | directly calls `restoreLegacyOpenaiHistory` (`src/cli/index.ts:711-724,792-794`) |
| P12 | `ocx provider add ... --sync` | live-proxy branch calls `syncModelsToCodex` (`src/cli/provider.ts:130-146,216-239`) |
| P13 | `ocx models add` | dispatches the custom add and live sync (`src/cli/models.ts:110-166,315-319`) |
| P14 | `ocx models remove` | dispatches the custom remove and live sync (`src/cli/models.ts:183-206,321-323`) |
| P15 | `ocx v2 mode ...` | persists mode then calls `syncModelsToCodex` (`src/cli/v2.ts:143-168`) |
| P16 | `ocx v2 on|off` | changed transition calls `syncModelsToCodex` (`src/cli/v2.ts:172-198`) |
| P17 | startup reconciliation path | journal replay is before bind (`src/cli/index.ts:169-176`), server construction directly invalidates cache (`src/server/index.ts:362-403`), and start arms the history guardian (`src/cli/index.ts:318-322`) |
| P18 | `POST /api/stop` — **disposable host only** | calls `stopServiceIfInstalled`, directly restores Codex, then drains (`src/server/management-api.ts:167-194`) |
| P19 | `POST /api/sync` | calls `syncModelsToCodex` with the server-captured config (`src/server/management/config-routes.ts:261-268`) |
| P20 | `POST /api/providers` | provider create reaches catalog write (`src/server/management/provider-routes.ts:99-147`) |
| P21 | `PATCH /api/providers?name=...` | provider edit reaches catalog write (`src/server/management/provider-routes.ts:151-338`) |
| P22 | `DELETE /api/providers?name=...` | provider delete reaches catalog write (`src/server/management/provider-routes.ts:449-487`) |
| P23 | `PUT /api/provider-context-caps` | all/global/per-provider branches reach three write calls (`src/server/management/provider-routes.ts:495-546`) |
| P24 | `PUT /api/disabled-models` | persists then refreshes (`src/server/management/model-routes.ts:208-215`) |
| P25 | `PUT /api/model-visibility` | persists then refreshes (`src/server/management/model-routes.ts:221-314`) |
| P26 | `POST /api/custom-models` | creates then refreshes (`src/server/management/model-routes.ts:321-353`) |
| P27 | `PUT /api/custom-models/:id` | updates then refreshes (`src/server/management/model-routes.ts:356-391`) |
| P28 | `DELETE /api/custom-models/:id` | deletes then refreshes (`src/server/management/model-routes.ts:394-405`) |
| P29 | `PUT /api/selected-models` | persists allowlist then refreshes (`src/server/management/model-routes.ts:426-441`) |
| P30 | `PUT /api/combos` | saves combo then refreshes before Claude follow-up (`src/server/management/combo-routes.ts:83-200`) |
| P31 | `DELETE /api/combos?id=...` | deletes combo then refreshes (`src/server/management/combo-routes.ts:203-217`) |
| P32 | `PUT /api/v2` | saves agent settings then refreshes (`src/server/management/agent-settings-routes.ts:178-280`) |
| P33 | `PUT /api/subagent-models` | saves roster, refreshes, then runs Claude/Desktop follow-up (`src/server/management/agent-settings-routes.ts:518-528`) |
| P34 | `ocx service start` — **disposable host only** | service dispatcher starts the installed wrapper (`src/service.ts:2511-2563`), whose baked command is `ocx start --port ...` (`src/service.ts:340,1378`) |
| P35 | `ocx service stop` — **disposable host only** | verifies stop, then directly restores native Codex (`src/service.ts:2564-2595`) |
| P36 | `ocx service uninstall` / `remove` — **disposable host only** | removes service, then directly restores native Codex (`src/service.ts:2610-2635`) |

`ocx restart` and tray restart compose P09/P04 or P03/P02
(`src/cli/index.ts:939-949,963-967`); service install eventually launches P02; they
do not own another Codex writer. CLI runtime model/combo commands that call the
management API are covered by the receiving P20-P33 route. If implementation finds
another production edge, this count changes and C14 remains red until the row and
runtime matrix are amended.

### Hard service-manager gate

The suite as previously written would have taken down the owner's proxy. The
authoritative audit observed `com.opencodex.proxy` installed and running as PID 72848
on this machine (`009_audit_synthesis_r4.md:17-24`). A temporary
`OPENCODEX_HOME` does **not** namespace the launchd label
`com.opencodex.proxy` or the Task Scheduler/systemd name `opencodex-proxy`:
they are fixed constants (`src/service.ts:42-43`), and start/stop/remove address
those constants directly (`src/service.ts:1640-1672,1868-1898,2045-2072`). Windows
also has the fixed native service id `opencodex-proxy-native`
(`src/lib/winsw.ts:33`).

Therefore P34-P36 are removed from the workstation suite. The same audit found P09,
P10, and P18 calling `stopServiceIfInstalled` / `uninstallServiceIfInstalled`, which
query or mutate those global registrations (`src/service.ts:2204-2266`); those rows
also run only in the disposable-host job. P01-P08, P11-P17, and P19-P33 do not call a
service-manager registration API. P02/P04/P17 are seeded with
`claudeCode.systemEnv:false` and no system-env tracking record, so their production
startup/cleanup path cannot issue per-login-session `launchctl setenv/unsetenv`
(`src/server/system-env.ts:251-258,364-391`).

Negative evidence is not proof of disposability. The empty-service gate protects
this workstation because its existing service makes the gate fail, but a normal
developer account with no installed service would pass it. The disposable-host job
therefore requires a positive, image-provisioned sentinel **before it performs even
the read-only service queries below**. On POSIX the sentinel is the root-owned,
non-symlink regular file `/etc/opencodex-disposable-service-host-v1`; on Windows it
is the non-reparse regular file
`C:\ProgramData\OpenCodex\opencodex-disposable-service-host-v1` owned by `SYSTEM`
or `Administrators`. Its exact bytes are
`OPENCODEX_DISPOSABLE_SERVICE_HOST_V1\n`; only root/`SYSTEM`/`Administrators` may
write it. The runner checks path type, owner, write permissions/ACL, and exact bytes
at process start. Missing, redirected, broadly writable, or mismatched sentinel
state is a hard failure before any service query, setup, or lifecycle command.

The runner is deliberately outside `bunfig.toml`'s `tests` root, has no
`.test.ts`/`.spec.ts` suffix, and is invoked only by the separately labelled CI
job as `bun run scripts/disposable-host/codex-service-composed-acceptance.ts`.
`bun run test`, bare `bun test`, and `bun test ./tests/` must not import or spawn it.
An ordinary repo-hygiene test reads `bunfig.toml`, `package.json`, and the test
import graph to assert those three commands remain rooted at `tests/` and have no
edge to the disposable runner. The disposable runner also proves its own sentinel
check ran before recording any platform query in its event ledger. Thus an explicit
positive marker and non-discoverability are the first gate; the absence checks below
remain a second gate, never the evidence that the host is disposable.

"Disposable" still means a throwaway VM/OS host and a **throwaway OS account**, not
a temp home on a developer account. After the positive sentinel passes and before
any service setup or row is run, the job must prove all of the following for that
account; an unavailable query, permission error, nonempty registration, or existing
artifact is a hard failure, not a skip:

- macOS: `launchctl list | awk '$3 == "com.opencodex.proxy" { print }'` prints
  nothing, and `test ! -e "$HOME/Library/LaunchAgents/com.opencodex.proxy.plist"`
  succeeds.
- Windows: `schtasks.exe /Query /TN opencodex-proxy` exits nonzero with the
  task-not-found result, and `sc.exe query opencodex-proxy-native` exits with service
  error 1060 (service does not exist).
- Linux: `systemctl --user list-unit-files opencodex-proxy.service --no-legend
  --no-pager` prints nothing, `systemctl --user status opencodex-proxy.service`
  reports the unit not found, and
  `test ! -e "$HOME/.config/systemd/user/opencodex-proxy.service"` succeeds.

Only after that empty result may fixture setup install the service state needed by a
row. Each P09/P10/P18/P34-P36 case starts from a restored clean VM/account snapshot,
runs the empty gate, installs and starts/stops only its fixture registration as the
row requires, invokes the row, tears that registration down, reruns the same platform
gate, and requires the same empty result. State is not carried from one service row
to the next. The job never runs on an account that has a real OpenCodex service,
regardless of which home installed it.

## Harness: real isolated processes, never the user's state

The parent creates one root with `mkdtempSync(join(tmpdir(),
"ocx-composed-"))`, then creates explicit `codex/`, `ocx/`, `home-a/`, `home-b/`,
`userprofile-a/`, `userprofile-b/`, `runtime/`, and local-provider fixture
directories beneath it. No path is derived from the parent process's `HOME`,
`USERPROFILE`, `CODEX_HOME`, or `OPENCODEX_HOME`.

Every OpenCodex child is spawned as follows. This is a call-site excerpt, not a
compilable unit — `repoRoot`, `fixtureRoot` and the fixture identifiers come
from the harness that surrounds it, so the fence is tagged `ts-excerpt` to keep
it out of the unit-wide compile check that the other five documents pass:

```ts-excerpt
Bun.spawn([
  process.execPath,
  resolve(repoRoot, "src/cli/index.ts"),
  ...argv,
], {
  cwd: fixtureRoot,
  env: {
    ...minimalAllowlistedEnvironment,
    HOME: fakeHome,
    USERPROFILE: fakeUserProfile,
    CODEX_HOME: codexHome,
    OPENCODEX_HOME: ocxHome,
    XDG_RUNTIME_DIR: sharedRuntimeRoot,
    OPENCODEX_API_AUTH_TOKEN: fixtureToken,
  },
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});
```

This executes the production CLI module in a second Bun process. It does not import
a command handler into the test process and does not install or call a global
`ocx`. Interactive P01 input is sent through the child's stdin. Servers bind port
`0`; the harness reads the isolated runtime-port record and verifies `/healthz`
reports that same PID/port. Provider discovery points only at a local fixture
server. No external API call is permitted.

The `saveConfigPreservingClaudeCode` warning is binding: a route fixture without an
injected persistence seam can overwrite the developer's real home
(`src/server/management/context.ts:9-19`). Therefore the composed suite never
constructs management routes around an in-memory config. It starts the real server
with the temporary `OPENCODEX_HOME` and sends authenticated HTTP to it.

Setup helpers may seed production-shaped files and hold a real SQLite transaction;
they may not replace convergence, admission, lock, history, or writer functions.
Synchronization is by child IPC/stdout sentinels, HTTP completion, SQLite lock
ownership, and file/record observations—never `sleep` as readiness. Each child has
a hard watchdog, all Workers are joined, all spawned PIDs are proven exited, and
only then is the known temporary root removed. A teardown failure fails the case.

The native lock is the deliberate exception to the temporary-root statement. Its
database lives under the fixed effective-user runtime root, not under the case root:
`/tmp/opencodex-runtime-v1-<uid>/native-write-locks/<sha256(canonical CODEX_HOME)>.sqlite`
on POSIX and
`<FOLDERID_LocalAppData>/OpenCodex/Runtime/v1/<SID>/native-write-locks/<sha256(canonical CODEX_HOME)>.sqlite`
on Windows (`005_contract.md` §7, "The lock namespace has one environment-independent
root per effective user"). Before spawning a child, the harness resolves
that exact path through the production identity/runtime resolver, checks that the
hash input is the case's canonical `CODEX_HOME`, and requires the exact database and
its `-journal`, `-wal`, and `-shm` sidecars to be absent. A pre-existing file fails
the case; it is never adopted or deleted.

After every child and Worker is joined and every SQLite handle is closed, teardown
re-resolves the same path, rechecks the effective uid/SID, canonical-home hash, owner,
mode/ACL, and non-symlink/non-reparse components, then removes only that four-name
allowlist: `<hash>.sqlite`, `<hash>.sqlite-journal`, `<hash>.sqlite-wal`, and
`<hash>.sqlite-shm`. It does not glob, enumerate, truncate, or remove the shared
runtime root or `native-write-locks` directory. A failed identity check aborts
cleanup and fails the case. Each allowlisted file is removed only if it exists and
was absent at preflight. This confines per-case lock files without touching another
Codex home's per-user lock state.

## Runnable composed scenarios

### A — every entry reaches one funnel

Parameterize the 30 workstation-safe rows P01-P08, P11-P17, and P19-P33 in the
ordinary suite. Run P09/P10/P18/P34-P36 only in the separately gated disposable-host
job above. The workstation rows seed authorizing isolated state without any service
artifact; the disposable P34-P36 setup installs its fixture service only after the
empty-registration gate. Invoke the real entry, read `integration-record.ts` for
provenance/extensions, read the transition id, native generation, and history
schedule/state through `transition-state.ts`, and capture a recursive before/after
manifest. Every native mutation must have
exactly one admitted transaction; OFF entries must produce a removal transaction, not
a skip. P20-P33 retain their existing primary 2xx/201 behavior and expose the contract disposition;
P30/P33 still complete their Claude/Desktop follow-up. The two job manifests together,
not either one alone, make the 36-row census.

**RED today:** `convergence.ts` and the integration record do not exist; P06, P11,
P17, P18, P24-P33, P35, and P36 visibly reach direct writers. The management rows
also pass through the bare catch at `src/server/management-api.ts:105-112`, so no
typed transaction can be observed. **GREEN:** all 36 rows yield either one recorded
transition or a typed no-write refusal/busy outcome, and the symbol-level module
graph enforces every domain row in `005_contract.md` §8's permitted-root table:
native/journal/catalog/provenance writes root at `convergence.ts`, history writes
root at `history-worker.ts`, and transition-state writes root only at those two.

### B — two-process race after approval, before commit

Process A invokes P19 with desired ON and gathers from a local provider whose HTTP
response is held after request receipt. The fixture emits `GATHER_ENTERED`. Process
B uses a production config mutation route to persist B and then A again, completing
both cooperating generations while A remains inside gather. Release the provider
response; A reaches the native/config section with its old admission. Assert A is
rejected before the first catalog/cache/backup/config/profile write. Regather then
succeeds.

**RED today:** P19 passes the server-captured config to `syncModelsToCodex`
(`src/server/management/config-routes.ts:261-264`), gather and write are one awaited
function (`src/codex/catalog/sync.ts:507-568`), and there is no generation. A writes
its stale catalog. **GREEN:** the A candidate records zero writes and a fresh
production call commits.

### C — `/healthz` during real SQLite contention

Seed a production-shaped `state_5.sqlite`, manifest, and eight rollout files. A
holder child opens that exact DB with `bun:sqlite`, executes `BEGIN IMMEDIATE`, and
prints `DB_LOCK_HELD` only after the transaction succeeds. While the holder waits
for parent IPC, invoke P19 so history work overlaps the lock. Before
releasing it, require ten authenticated-independent `/healthz` responses and an
eight-chunk local SSE request to complete. Each health request has a 500 ms
watchdog; the whole overlap has a 2 s watchdog. Then release the transaction,
observe durable `pending/db-busy`, and wait for the production retry to converge.

**RED today:** history uses a 5 s SQLite busy timeout and synchronous retry sleep on
the caller thread (`src/codex/history-provider.ts:526-548,565-578`), so the 500 ms
health watchdog fires. **GREEN:** history waits in the Worker; all health responses
and chunks complete while the DB remains locked, and the later retry clears the
durable unresolved state.

### D — foreign/unknown authority creates nothing

Create foreign service-home evidence, then repeat with corrupt and unreadable
mirror evidence. Snapshot the whole temp root and the exact case-specific OS-runtime
lock path,
invoke P02, P04, P19, one of P20-P33, P07, P18, P35, and P36, and compare byte/path
manifests. Assert no lock directory, SQLite DB/journal, integration record, native
journal, backup, catalog/cache, config/profile, history manifest/row, or rollout
line was created or changed.

**RED today:** ownership preflight applies only to teardown and fails open on
non-mismatch errors (`src/integrations/native/ownership-preflight.ts:21-35`);
management catalog writes never call it. At least the management/startup rows
create or rewrite native artifacts. **GREEN:** every row refuses before the first
artifact and reports `foreign` or `unknown`.

### E — one effective user, different environment homes, same lock

Two real children use the same existing `CODEX_HOME`, OS account, and runtime root.
Child A gets `HOME=home-a`, `USERPROFILE=userprofile-a` and holds the production
lock. Child B gets `HOME=home-b`, `USERPROFILE=userprofile-b` and invokes P19 with a
zero deadline. Assert B receives typed busy with the same lock id/path. Repeat by
varying HOME alone and USERPROFILE alone. Assert one uid/SID namespace and no lock
artifact below either fake home or `CODEX_HOME`.

**RED today:** there is no native cross-process lock or uid/SID namespace, so both
callbacks can write. **GREEN:** B is busy until A releases, then acquires the one
uid/SID-scoped database.

### F — canonical-home matrix and lock taxonomy

Invoke P19 from children using default, explicit, absolute, tilde, symlink, and
platform case-equivalent spellings of one existing home; they must contend on one
lock. Two different homes acquire independently. Missing home, namespace symlink,
malformed DB, and finite-deadline contention return typed `refused` or `busy`, never
throw; a normal run proves `acquired` through a `converged` response.

Wrong-owner/mode activation is not fabricated with `chown` in ordinary CI: an
unprivileged POSIX account cannot create a path owned by another uid. That case stays
in `tests/codex-user-identity.test.ts` and uses the resolver seam required by the
contract (`005_contract.md:773-777`): a child process calls the exported production
resolver while the filesystem-inspection seam reports the real fixture directory with
`uid !== process.getuid()` (or a broad mode), then proves typed refusal and zero
callback/SQLite-open activity. Windows uses the corresponding owner/ACL seam. A job
that instead uses a real foreign owner must be a separately labelled privileged
disposable job; it is not required for ordinary CI and may not run on a workstation.

**RED today:** no such exclusion exists, so same-home contenders both mutate and
unsafe namespace fixtures are not classified. **GREEN:** the exact
`acquired | busy | refused` taxonomy is observable through P19 and no refused case
runs its commit.

### G — config A→B→A and target retarget

Use Scenario B's barrier, but require B to persist A→B→A through production config
mutations. A's content digest ends equal to its admitted digest. Assert A still
fails on generation before mutation. In a second run, retarget a parent symlink once
between gather and commit and assert target-identity refusal with zero writes.

**RED today:** equality is the only available observation and there is no monotonic
generation/target expectation; the stale A bytes commit. **GREEN:** generation
detects the cooperating ABA and target identity detects single-direction retarget.
An arbitrary parent-symlink A→B→A wholly between checks is deliberately not claimed
(`005_contract.md` §3).

### H — history overtaking after stale mutation is detected and repaired

This must reach the contract's hard half: B commits **after** A has changed history,
not before A's initial expectation check. Seed at least two production-shaped
rollouts. A holder child opens the real state DB and prints `DB_WRITE_HELD` only after
`BEGIN IMMEDIATE` succeeds. That permits A's reads but blocks its later DB write. The
parent sends P19 to a single P02 server for transition A. Through the production
Worker, A commits its native pair, writes the manifest, changes at least one rollout, and then
parks at the real DB transaction (`src/codex/history-provider.ts:606-648` for apply;
the reverse path changes rollouts before its DB transaction at `:656-690`). The
parent uses `fs.watch` plus an immediate byte recheck and proceeds only after both the
manifest and rollout post-images are observed; no timer or injected Worker hook
declares the pause.

While A is blocked mid-traversal, process B invokes P07 or P19 in the opposite
direction. Require B's newer `{nativeGeneration,currentTxId}` and its
`history:{status:"pending",txId:B,...}` schedule to be durable before releasing the
holder. Release `BEGIN IMMEDIATE` before A's production busy deadline; A finishes
its remaining DB work and reaches the terminal conditional record update. Assert A
reports `pending/overtaken`, B's exact pending schedule was not replaced by A, and
the guardian in the same P02 process observes B, runs after A releases the history
lock, and repairs manifest, every
rollout, and DB to B. Reverse ON/OFF and repeat. The real SQLite write lock plus the
observed manifest/rollout post-image is the deterministic mid-traversal barrier; no
mock or direct history helper is accepted.

**RED today:** manifest and rollouts are outside SQLite's transaction
(`src/codex/history-provider.ts:606-648,656-695`) and there is no transition-owned
terminal conditional update, so A can overwrite/cancel the newer direction or leave
its stale bytes terminal. **GREEN:** A is allowed to mutate stale history, cannot
replace B's pending schedule, and the live guardian makes B the clean terminal owner.

### I — retry beyond the old horizon, without restart

Seed the canonical `transition-state.ts` coordinator row with unresolved current
history at `attempts: 60` and `nextRetryAt` due now, then start one P02 server and
keep it alive. Hold the real DB
through the first retry, observe the attempt advance beyond 60 and another finite
timer remain armed, then release. Wait no longer than one exported production
backoff cap plus a 2 s watchdog and assert the same PID converges; no restart/module
reload is allowed.

**RED today:** `DEFAULT_MAX_TICKS = 60` and the terminal branch stops scheduling
(`src/codex/history-migration-guardian.ts:34-35,87-92`). **GREEN:** attempt 61+
retains a timer and the same long-lived process converges after contention clears.

### J — unchanged OFF with residue and unchanged ON with absence

For OFF, persist desired OFF, leave one OpenCodex-owned artifact at a time
(config route, profile, catalog row, cache, journal, history manifest/row, rollout),
then invoke P19 without changing intent. Every residue must be removed/restored and
observed OFF. For ON, persist desired ON, delete one required artifact at a time,
invoke P19 without changing intent, and require reconstruction plus observed ON.
For C12, keep one P02 server alive across both halves: a second real CLI process
persists OFF, P19 removes through fresh admission, that process persists ON, and
the same server PID applies through fresh admission. An invalid persisted config
must refuse without changing any native byte.

**RED today:** no persisted `clientIntegrations.codex` intent exists; P19 always
calls the apply-oriented `syncModelsToCodex`, while restore is a separate command.
OFF residue is reapplied and ON absence is not judged against a shared observed
state. **GREEN:** callers say only `converge`; admitted intent selects direction and
unchanged intent still repairs observed state.

### K — current-byte provenance, recovery, and one schema

Sequence P02 apply, P07 remove, P08 apply, P18 remove, and P02 startup using the same
isolated homes. After each transition, read the record only through its production
owner in `integration-record.ts` and assert provenance plus unknown record/ledger/
entry extension keys survive. Separately read `transition-state.ts` and assert the
native generation, current transaction id, history observation, and schedule match
the same transition. For an absent baseline, matching post-image removal
must restore absence. For a present baseline, restore exact bytes. Change current
bytes after apply and require preservation/conflict. Corrupt or remove the record
and require automatic refusal before mutation.

**RED today:** there is no integration record; restore filters catalog rows and
deletes profile by filename (`src/codex/inject.ts:723-741`,
`src/codex/catalog/sync.ts:572-597`) without baseline/post-image authority.
**GREEN:** every phase reads one extension-safe schema and current-byte drift is
preserved/reported. Edit-then-revert to identical bytes is outside C10.

### L — external provider remains an independent veto

Create an owned service home but set an external root `model_provider`, add a dead
journal and native residue, then invoke P02, P04, P19, P20, P07, P18, P35, and P36.
Assert byte-exact preservation and no lock/record creation; the response names
`external-provider`, not service ownership or already-converged.

**RED today:** direct management refresh and startup cache invalidation bypass the
external guard, while restore deletes the journal even when external
(`src/codex/inject.ts:764-769`). **GREEN:** the external-provider veto is checked
after service authority and before every artifact for every row.

## Substrate-sensitivity audit

The named RED is mandatory for every scenario. The observations in the last column
are either baseline-green controls that can pass without the substrate or easier
halves that do not activate the defect; recording only one of them is a false proof
and does not satisfy the scenario.

| Scenario | Observation that must be RED before the substrate | Baseline-green or non-defining observation that cannot count as RED |
|---|---|---|
| A | at least one row reaches a direct writer or lacks the sole-funnel receipt; the complete 36-row manifest cannot be produced | a row's primary CLI/HTTP success status |
| B | stale A writes catalog/native bytes after B changes admitted config | provider request reached the fixture and a later fresh call succeeds |
| C | `/healthz` or SSE exceeds its watchdog while the production history path waits on the held DB | health/SSE with no overlapping DB contention |
| D | P02/P04/P19/P20 creates or changes an artifact under foreign/unknown authority | P07/P18/P35/P36 may already refuse through teardown ownership checks; those rows are coverage, not the RED oracle |
| E | same-uid/SID contenders with different environment homes both enter mutation | distinct canonical Codex homes proceeding independently is the expected control |
| F | equivalent spellings fail to contend or an unsafe namespace reaches callback/SQLite open | two different canonical homes acquiring independently; an ambient OS error from an unconstructible `chown` fixture |
| G | cooperating A→B→A or one-way target retarget lets stale A mutate | final config bytes equalling A after A→B→A |
| H | after A has changed manifest/rollout bytes, A can replace B's pending schedule or B is not repaired | rejecting A at the initial pre-mutation expectation check tests only the easy half |
| I | attempt 61 has no next timer or the same PID never repairs after release | a retry below the old 60-tick horizon |
| J | unchanged OFF leaves residue/reapplies it, or unchanged ON leaves a required artifact absent | already-clean ON/OFF no-op behavior and invalid-config parsing by itself |
| K | missing/conflicting provenance permits mutation or current-byte drift is overwritten | a simple untouched present baseline that the filename-based restore already happens to reproduce |
| L | a dead journal or another native artifact changes while an external provider is active | external-provider detection with no journal/residue present |

Any case that is green on both SHAs is labelled `baseline-green-control` in the case
manifest and cannot satisfy a criterion. Each A-L scenario needs its named
substrate-sensitive RED artifact and corresponding GREEN artifact under the same
fixture and entry point.

## C1-C18 matrix

| Criterion | Production proof | What fails on the current revision |
|---|---|---|
| C1 | P19 and P20-P33 through A/B: provider response barrier proves gather is write-free; fixed commit receipts and typed outcomes prove the bounded commit | gather writes backup/catalog in one awaited function (`src/codex/catalog/sync.ts:507-568`); management errors are swallowed (`src/server/management-api.ts:105-112`) |
| C2 | P19 through B/G: cooperating config change after admission rejects before every native write | no generation/under-lock authoritative admission exists, so stale captured config commits |
| C3 | P19 through C while `/healthz` and SSE complete under held real SQLite write transaction | synchronous 5 s busy wait/retry runs on the listener thread |
| C4 | P02/P19 through C/I: unresolved is durable, attempt 61+ is armed, same PID later converges | current guardian terminates at 60 and has no durable typed record |
| C5 | P19 through F: converged proves acquired, zero-deadline contention proves busy, unsafe namespace proves refused | no native lock API/taxonomy exists; both contenders write |
| C6 | P19 through F across equivalent and distinct real homes | textual-path callers have no common cross-process lock |
| C7 | P19 through D/E/F proves no home-derived namespace; the F resolver-seam child proves wrong-owner/mode refusal without privileged `chown` | no per-user namespace exists; current paths are home/environment-derived elsewhere |
| C8 | P02/P04/P07/P18/P19/P20/P35/P36 through D, with full manifest including runtime lock path | current ownership check is teardown-only and fails open; management/startup bypass it |
| C9 | P02/P04/P07/P18/P19/P20/P35/P36 through L | management/startup write around the guard and external restore deletes the journal |
| C10 | P02/P07/P08/P18 through K | filename/filter restore has no baseline/post-image record and cannot restore proven absence safely |
| C11 | P19 through J for OFF-with-residue and ON-with-absence | no persisted Codex intent/observer; `/api/sync` always follows the old apply seam |
| C12 | one P02 server plus a subprocess config writer, then P19 OFF and ON through J | P19 passes the long-lived captured `config` object (`src/server/management/config-routes.ts:261-264`) |
| C13 | **Not provable through a production entry point.** Run typecheck, full suite, GUI lint, privacy scan, docs build, then require this composed suite's case manifest and red/green evidence | those static/broad gates can be green today while A-L are red; C13 alone proves none of C1-C12 |
| C14 | A's workstation and disposable-host manifests together drive P01-P36; P20-P33 cover 14 route shapes/16 calls; module-graph reachability and transition receipts must agree | 16 management call sites and multiple CLI/startup paths reach direct writers instead of one funnel |
| C15 | P02/P07/P19 through H in both directions: B commits only after A's manifest/rollout post-images exist, B's pending schedule survives A's terminal conflict, and the guardian repairs B | only DB substeps are transactional; processes can overtake file writes and stale completion has no conditional terminal update |
| C16 | P02/P07/P08/P18/P17 sequence through K, preserving optional provenance and record/ledger/entry extensions through `integration-record.ts` while every phase reads the same transition/history row through `transition-state.ts` | no shared record owner/schema exists |
| C17 | P19 through G with production config A→B→A and one-way parent retarget | no generation or stable target expectation exists; equal content passes |
| C18 | P19 through E with independently different HOME and USERPROFILE in real children | no uid/SID lock exists, so environment-home variation does not contend |

C13 is the only criterion not provable through a production entry point. It is a
meta-gate and must remain labelled that way; substituting its commands for A-L is
the exact false proof WP13 exists to prevent.

## Determinism and runtime budget

- No random timing decides a race. Provider-response gates, `BEGIN IMMEDIATE`
  ownership, child READY messages, generation/record observations, and explicit IPC
  releases define every ordering.
- Random ids are printed and compared, never predicted. The fixture clock may seed
  persisted due timestamps, but the production scheduler and real monotonic
  deadlines execute; no fake timer or mocked Worker satisfies C3/C4.
- The focused composed suite has a **120 s hard budget** on macOS/Linux and **180 s**
  on Windows. All cases except C/I should finish within 10 s each; C is capped at
  2 s of held contention, and I may wait one production backoff cap. Exceeding the
  budget is failure, not a retry-green allowance.
- Case order is irrelevant. Every case gets a fresh root and port 0. The suite runs
  serially initially because it intentionally contends on per-user runtime
  namespaces; parallelization is allowed only after distinct runtime roots and PIDs
  are proven in the case manifest.
- Windows CI must exercise real SID, junction/reparse, ACL, and USERPROFILE behavior;
  POSIX CI must exercise real uid, symlink, mode, and the wrong-owner resolver seam.
  A real foreign-owner fixture is privileged-disposable-only. Platform skips are
  limited to the opposite platform's primitive, never the shared criterion.

## What this suite deliberately does not prove

- It does not prove crash-atomic native commits. The contract promises detectable
  partial state and later convergence, not a filesystem transaction.
- It does not prove arbitrary filesystem A→B→A wholly between observations,
  bind-mount alias collapse, or cross-namespace identity. C17 covers cooperating
  generations and single-direction target drift.
- It does not prove that matching current bytes were never edited and reverted.
  C10 is current-byte evidence only.
- It does not prove GUI controls, Grok, Claude Code/Desktop, or the six file-client
  integrations; those are outside this unit.
- It does not prove provider correctness or internet availability. Provider gather
  is a deterministic local fixture.
- It does not prove release packaging, installation, deployment, or the live proxy
  on 10100. Published-launcher smoke belongs to release verification after this
  source-level production-boundary suite passes.
- It does not make C13 evidence for C1-C12. Green typecheck/full-suite/privacy output
  remains necessary and insufficient.

## Acceptance of WP13

WP13 passes only when A-L are red on the pre-substrate revision for the named
observable reason, green on the composed revision, all 36 production rows are in
the paired workstation/disposable-host manifests, C1-C12 and C14-C18 have
artifact-level evidence, C13 is separately green, every child/Worker is joined, the
positive sentinel is verified before the disposable event ledger's first service
query, the negative service gate is empty before and after that job, ordinary test
commands cannot discover the disposable runner, and teardown removes only the
suite's explicit temporary roots plus the validated four-name lock-file allowlist.
A missing row, a same-process substitute for E/H, a mocked convergence function, a
test that passes on both revisions without a separate substrate-sensitive RED, or a
green broad suite beside any red composed case is a failure.
