# PR1 — macOS launchd repair/status (issue #4236 defects 1 & 2)

Branch `codex/260911-l4-launchd-repair`, based on `dev` (`babb76449`). First of the four-PR
hub single-port stack; the others target this branch's head in turn.

Scope: `src/service.ts` macOS path only, plus the two shared test-safety guards the work
uncovered. Defects 3 and 4 from the issue (secondary-port misdiagnosis, `ocx status` fence
comparison) are deliberately left to PR2, which owns the loopback listener.

Three rounds. The first is the three commits below; the second folds in a review of them, and
every fix it carries is marked in place; the third (section E) makes `ocx service restart`
actually restart, which the second round's no-op had quietly turned into a no-op of its own. In short: the new protocol was still asking the OLD
two-state `launchdJobMatchesPlist` at both decision points (so an unreadable `launchctl print`
still evicted a healthy hub, twice), the no-op pre-check compared whole-file bytes while
`buildPlist` bakes the repairing process's `PATH`, the comment justifying `kickstart -k` was
wrong about launchd re-reading the plist, and every mutating verb still addressed `gui/<uid>`
alone while the new probe reports `user/<uid>` too.

## What shipped

### A — `installLaunchd()` (repair must not be an outage)

1. **No-op pre-check, on the TRI-STATE probe.** The plist is rendered BEFORE anything is
   written. If the rendered bytes equal the on-disk bytes, the data-token file is unchanged,
   and `probeLaunchdLoadState()` answers `loaded-current`, the function re-asserts 0600 on the
   plist, refreshes install state, logs
   `service is already loaded from the current plist; nothing to do.` and returns. launchd is
   not touched at all. This is the headline fix: a repair of a healthy hub used to evict it
   unconditionally.

   Two things the first round got wrong here, both found in review:

   - It asked `launchdJobMatchesPlist`, which reports `loaded:false` for EVERY non-zero
     `launchctl print` — EPERM from a non-Aqua ssh/cron context, an unspawnable launchctl, an
     undocumented status. On a healthy serving hub that read as "not loaded", so the pre-check
     evicted, the verification failed the same way, the rollback evicted again and the error
     ended with "IS NOT RUNNING" about a job that was up. Both checks now go through
     `probeLaunchdLoadState`, and `unknown` refuses to touch launchd at all (item 9).
   - It compared whole-file bytes, while `buildPlist` bakes `process.env.PATH` from whichever
     process is repairing. A tray helper, `ocx update`'s child or an ssh session carries a
     different PATH, so the pre-check missed and the healthy hub was evicted *and* had its
     PATH narrowed. `reusePreviousPlistPathVariable()` now puts the installed PATH back when
     PATH is the ONLY difference and the live job runs the exec line this install baked — the
     two files then compare equal on their own terms, and the PATH the service already runs
     with survives. Anything else differing means a real rewrite, PATH included.
2. **Backup + rollback.** The previous plist bytes are held in memory and copied to
   `<plist>.prev` before the overwrite. On terminal failure the bytes go back, a
   bootout/settle/bootstrap tries to re-register them, and the thrown error states whether
   that worked.
3. **`bootstrap gui/$uid <plist>` replaces `load -w`.** `bootout` was already
   domain-explicit; `load` acts on the CALLER's bootstrap domain, so from ssh/cron/another
   bootstrap context the old pair deleted the gui-domain job and registered nothing.
4. **Bounded settle after an eviction that evicted something** — up to 5 × 200 ms while
   `launchctl print <target>` still answers 0, the launchd twin of the Windows
   `SCHEDULER_SETTLE_DELAYS_MS` idea. `bootout` is asynchronous, so the old back-to-back
   retry raced the same exiting job twice and added nothing. A `bootout` that exited 3 is not
   settled: nothing is exiting to wait for.
5. **Success is `probeLaunchdLoadState()` answering `loaded-current`, never stderr.** It is
   asked against the command this install actually baked, and `writeServiceInstallState`
   runs only after it agrees. Stderr regexes are advisory routing signals now.
6. **One retry, routed by the failure.** Exit 5 / `Bootstrap failed` → `kickstart -k` (only
   when the rendered bytes are already on disk, see item 10), then `enable` + a second
   bootout/bootstrap (see the launchctl findings below). Exit 0 with a disagreeing probe →
   one more bootout/bootstrap, because that is the silent no-op. Any other failure (malformed
   plist, EPERM) throws immediately so the real stderr reaches the operator undelayed — the
   property the previous code had and kept. A probe that answered `unknown` is NOT retried: a
   retry is another eviction.
7. **Error text names what the probe actually found.** `not-loaded`: the job was evicted from
   `gui/<uid>` and is not running (or the previous plist was restored and re-bootstrapped).
   `loaded-stale`: it *is* loaded, from a different command than the plist just written —
   telling that operator "nothing is listening" sends them to fix the wrong thing. Both name
   `launchctl bootstrap gui/<uid> <plist>` as the remedy, plus `launchctl print` and
   `launchctl print-disabled` to inspect.
8. **`stableLauncherEntry()` prefers the recorded launcher** when it is still an absolute
   executable file, falling back to the PATH walk otherwise (defect 1g). A repair from a
   context without `ocx` on PATH no longer rewrites a working launcher-form plist into the
   version-pinned Bun + CLI pair.

   **This is not a macOS-only change.** `installSystemd` resolves the same function, so a
   Linux repair from a PATH-less context now keeps the `ExecStart` the unit already has. The
   failure it prevents there is milder (systemd reloads and restarts; it never evicts into
   nothing), but the silent rewrite was identical, so the behaviour is deliberately shared
   rather than branched. `tests/service/service.test.ts` covers the systemd side directly.
9. **An unverifiable launchd state refuses to act.** `unknown` from the pre-check throws
   before a single file is written or a single verb is run, saying the job may be RUNNING and
   naming `launchctl print gui/<uid>/<label>` and `launchctl print user/<uid>/<label>` so the
   operator can ask it themselves. `unknown` after the bootstrap neither evicts again nor
   rolls back (a rollback is another eviction) and never claims the job is down: an accepted
   bootstrap warns and records install state, a refused one throws with the real stderr and
   an explicit "this says nothing about whether it is running".
10. **`kickstart -k` is only trusted for bytes already on disk.** launchd restarts the
   definition it has CACHED; it does not re-read the plist. When only `EnvironmentVariables`
   changed the exec line is unchanged, so the verification would agree, install state would be
   written, repair would report success — and launchd would keep the OLD environment. So new
   bytes skip `kickstart` entirely and go to `enable` + evict/bootstrap, which is the only way
   to hand launchd a new definition. A fresh install counts as new bytes.
11. **Both user domains are evicted, and `<plist>.prev` is removed on success.** The probe
   reports `user/<uid>` as well as `gui/<uid>`, so a gui-only `bootout` left a user-domain
   registration of the same Label alive and then bootstrapped a SECOND one into `gui/` — two
   `KeepAlive` jobs fighting for one port. `launchdEvictionTargets()` is the shared list, used
   by `installLaunchd`, `stopLaunchd` and the install-cleanup `stop`; `bootout` against a
   label a domain does not hold exits 3 and changes nothing, so both are addressed
   unconditionally rather than enumerated first. The rollback copy is deleted once the new
   definition is verified loaded, instead of living until the next `uninstall`.

### B — `statusLaunchd()` / `diagnoseService()` darwin branch

`launchctl list | grep <label> || true` is gone. New `probeLaunchdLoadState()` asks
`launchctl print` in BOTH `gui/<uid>` and `user/<uid>` (the way `inspectLaunchd` does), keeps
the 112/113 distinction, and returns a four-state verdict:

| state | `running` | `viable` | summary |
|---|---|---|---|
| `loaded-current` | true | `!stale` | `installed and loaded (launchd; …)` |
| `loaded-stale` | true | `!stale` | `installed and loaded from an OLDER plist (launchd; …)` |
| `not-loaded` | false | false | `installed, not loaded (launchd; …)` |
| `unknown` | false | `!stale` | `installed; launchd state could not be verified — <reason> (launchd; …)` |

`deriveLaunchdServiceDiagnostic()` is a pure function so all four are testable without a live
launchd. `platformServiceInstallCleanupOps` (the install-cleanup twin) now uses the same probe
and `bootout` instead of `launchctl list` + legacy `unload`, and keeps failing closed on
`unknown` — installing new assets over a manager we could not query is the unsafe direction.

### C — `serviceCommand` repair branch

`repairService()` is wrapped, so `reportServiceServing("repaired")` runs even when repair
throws. The failure is printed and `process.exitCode` is 1 either way. This matters precisely
because darwin repair can now roll back: the operator needs the "did anything come back?"
answer, and a throw used to escape to the top level and skip it.

### D — `stopLaunchd` / `uninstallLaunchd`

`bootout` in EVERY domain `launchdEvictionTargets()` names (`gui/<uid>` and `user/<uid>`);
legacy `unload` survives only when launchctl could not be spawned at all (`status === null`).
Exit 3 ("No such process") is the not-loaded case, not a failure. `uninstallLaunchd` routes
through `stopLaunchd` and also removes `<plist>.prev`.

Gui-only was the remaining half of the same defect: against a `user/`-domain job
`ocx service stop` exited 3 in a domain that never held it and returned as though it had
stopped something, and the install-cleanup `stop` did the same before laying new assets over a
live manager. The cleanup `stop` now treats 0/3/112/113 as benign per domain
(`launchctlBootoutBenign`) and throws on anything else, so it still fails closed.

### E — the `restart` verb (follow-up round)

The no-op in A/1 has a second half. `ocx service restart` maps to the repair path, so once
`installLaunchd` started returning early on a healthy loaded-current job, a restart of a
healthy macOS service restarted **nothing** — and the operator docs had to tell people to run
`launchctl kickstart -k gui/$(id -u)/com.opencodex.proxy` themselves, which is the opposite of
the "simpler commands" goal.

- `installLaunchd` now returns `LaunchdInstallOutcome { reloaded }`. `false` is the no-op path
  and only that path: the plist was not rewritten, launchd was not touched, the job is the
  same process it was. `platformOps` wraps the call, because `ServiceOps.install` promises
  nothing about a return value.
- `repairService` takes a `verb: "repair" | "restart"`. On darwin, `restart` + `reloaded:
  false` runs `restartLaunchdJob()`: `launchctl kickstart -k gui/<uid>/<label>`, verified with
  `probeLaunchdLoadState` against the exec line an install would bake, logging one line —
  `service restarted (launchctl kickstart -k gui/<uid>/com.opencodex.proxy).` An `unknown`
  probe warns (it is not evidence); `not-loaded`/`loaded-stale`/a failed kickstart throw with
  the manual command, and the repair branch still runs its `reportServiceServing` health wait.
  `kickstart -k` is the right verb here precisely because it opens no eviction window — and it
  cannot publish bytes, which is irrelevant when there are none to publish.
- **`repair` keeps the no-op.** A repair of a healthy service must not be an outage; only the
  verb that promises a new process costs one.
- `normalizeServiceSubcommand` no longer folds `restart` into `repair`; `serviceCommand`'s
  repair branch accepts both and passes the verb down, and reports `restarted` rather than
  `repaired`. A BARE `ocx service` still selects `repair` — it is an idempotent "make it
  current", not a request to bounce a healthy hub.
- **Windows and Linux are unchanged.** The scheduler repair already stops then starts the
  task, WinSW repair restarts the service, and `installSystemd` ends in an unconditional
  `systemctl --user restart`, so neither platform has a no-op to compensate for and neither
  reads the verb. Checked rather than assumed — the Linux installer was the one that could
  have had the same problem.
- `src/cli/version-skew.ts` now advises `ocx service restart` instead of
  `ocx service repair (restart is an alias)`: a version skew leaves the definition byte-
  identical, so repair would no-op and keep the old process serving. `src/cli/registry.ts`
  describes the two verbs separately; the `service` usage error does too.

Tests (8 new cases in `tests/service/launchd-repair.test.ts`, 54 total): restart of a healthy
loaded-current job runs exactly `kickstart -k` on the gui domain and no `bootout`/`bootstrap`;
repair of the same state runs zero launchctl calls and never reaches the restarter; restart of
a not-loaded job takes the ordinary evict/bootstrap path with no kickstart; `installLaunchd`
returns `{ reloaded: false }` / `{ reloaded: true }` for the two paths; `restartLaunchdJob`
prints the one line naming the command, throws when the job is gone afterwards, and only warns
on `unknown`; a source-oracle case pins the darwin wiring (restart verb only, real default
restarter) and the unconditional `systemctl --user restart`. `tests/service/service.test.ts`
covers the verb surviving `normalizeServiceSubcommand`/`planServiceCommand`/
`selectServiceSubcommand` and the shared dispatch branch. Every case injects `restartLaunchd`
or the launchctl seam: the default would kickstart the live hub, and `kickstart` is not on the
live-service-manager guard's read-only list, so a default call from an armed test process
fails closed.

### Two test-safety guards this work uncovered

Both were pre-existing, and both were hitting this machine.

- **`assertNotRealLaunchAgentsUnderTest`** (`src/lib/test-home-guard.ts`) plus an injectable
  `plistPath` on `installLaunchd`. `os.homedir()` reads the password database, not `$HOME`, so
  the suite's HOME sandbox does not move `~/Library/LaunchAgents`. The existing
  `withLaunchAgentHome()` helper in `service.test.ts` was therefore inert, and every
  `installLaunchd` case rewrote the developer's live `com.opencodex.proxy.plist` with a
  definition whose token file, log path and homes pointed into a temp sandbox. launchd holds
  its own parsed copy, so nothing broke until the job next restarted.
- **`serviceStatePaths()` drops the legacy default-home entry under an armed test process.**
  That entry exists so an install made before `OPENCODEX_HOME` was set can still be found, but
  it is the real `~/.opencodex/service-state.json`, so a sandboxed test still wrote the live
  record. Observed directly: one run replaced this host's `codexHome`/`opencodexHome` with
  `/var/folders/...` paths.

  Two review fixes on top: the filter asks the guard's own `isProtectedHomeUnderTest()` so one
  canonicalization decides (a local `resolve()` calls `/var/folders/...` and
  `/private/var/folders/...` different directories on macOS), and `writeServiceInstallState`
  goes through `serviceStateWritePaths()`, which THROWS when the filter leaves nothing. With
  `OPENCODEX_HOME` unset under an armed guard both candidates resolve to the real home, the
  list went empty, and the writer silently wrote nowhere while reporting success. Reads stay
  quiet — an empty read list is "no install state", which is true.

Both real files on this machine were restored from the live job's own
`launchctl print` output and re-verified (`plutil -lint` OK, command identical to the running
job, 0600, `/healthz` 200). Nothing was left in `~/Library/LaunchAgents` by this work.

## launchctl semantics, measured on this host

macOS 26 / Darwin 27.0.0, arm64, uid 501. Measured with a throwaway
`com.opencodex.test-probe` label in a temp plist running `/bin/sleep 600`, never against the
live `com.opencodex.proxy` job (`launchctl print gui/501/com.opencodex.proxy` returned 0
before and after every probe). The probe was booted out and its files deleted.

```
launchctl print gui/501/<label>            → 113 absent, 0 loaded
launchctl print user/501/<label>            → 113 (the shipped agent lives in gui/ only)
launchctl print gui/99999/<label>           → 112 (no such domain)
launchctl bootstrap gui/501 <plist>         → 0 first time
launchctl bootstrap gui/501 <plist> (again) → 5  "Bootstrap failed: 5: Input/output error"
launchctl load -w <plist> while bootstrapped→ 0  AND "Load failed: 5: Input/output error"   ← the silent no-op
launchctl kickstart -k gui/501/<label>      → 0 when loaded, 113 when absent
launchctl bootout gui/501/<label>           → 0 when loaded, 3 "Boot-out failed: 3: No such process"
```

Second probe, the finding that changed the design:

```
launchctl disable gui/501/<label>           → 0
launchctl bootstrap gui/501 <plist>         → 5  "Bootstrap failed: 5: Input/output error"   ← same code, different cause
launchctl kickstart -k gui/501/<label>      → 113
launchctl load -w <plist>                   → 0, job loaded, and print-disabled flips to "enabled"
launchctl enable gui/501/<label>            → 0
launchctl bootstrap gui/501 <plist>         → 0, job loaded
```

So **exit 5 is ambiguous**: either something is still bootstrapped under the label, or the
label sits in the domain's disabled list. The `-w` in the legacy `load -w` was doing the
second job silently, and dropping it without `enable` would have made a disabled job
permanently unrepairable. The retry therefore tries `kickstart -k` (live job) and then
`enable` + bootstrap (disabled list), in that order. `enable` runs ONLY on that retry, so an
ordinary repair does not quietly undo a deliberate `launchctl disable`.

Residue worth noting: `launchctl enable`/`disable` write a per-uid override database, so
`launchctl print-disabled gui/501` now carries an inert `"com.opencodex.test-probe" => enabled`
entry for a label that no longer exists. There is no launchctl verb to remove an override
record; it references nothing and is harmless.

## Decisions

- **`unknown` keeps `viable` true.** `isServiceViable() === false` is what makes
  `src/update/index.ts` (after a service refresh exits 0) and `src/update/job.ts:1229` treat a
  healthy supervisor as dead and start a COMPETING proxy on the service's own port. A probe
  that could not be run is not evidence against the service, so `unknown` reports honestly in
  the summary — no "not loaded", no `ocx service repair` — and does not disprove viability.
  `startable` is likewise untouched, so the tray still hands the start to `ocx service start`,
  which no-ops on an already-loaded job. `src/cli/status.ts:216`-`222` still appends
  "registered but NOT serving … re-run 'ocx service repair'" only when `installed && !live`,
  which stays honest: with `unknown` AND a live proxy it prints the unverified summary under
  `✅ Proxy: running` and recommends nothing.
- **`loaded-stale` keeps the viability the grep era gave it** (loaded ⇒ viable). Only the
  summary is upgraded, so the update fallback behaves exactly as before while the operator
  finally learns the live job came from an older plist — the one case where `repair` is right.
- **Verification compares the command THIS install baked**, via a new shared
  `launchdServiceCommand()` that `buildPlist` also uses, not
  `expectedLaunchdCommand(installedServiceListenPort())`. A fresh install has no install state
  yet, and a lost state file makes `expectedLaunchdCommand` fall back to the Bun + CLI pair —
  which would call a correctly loaded launcher job stale (#3464) and turn every first install
  into a rollback.
- **`<plist>.prev`, not `<plist>.prev.plist`.** launchd globs
  `~/Library/LaunchAgents/*.plist` at login, so a backup ending in `.plist` would be a second
  registration of the same Label fighting the real one for the port.
- **`installLaunchd` stays synchronous** (`ServiceOps.install` and
  `RepairServiceDeps.repairLaunchd` are `() => void`), so the settle loop uses
  `Bun.sleepSync` behind an injectable `sleepSync` seam rather than making the whole
  call chain async.
- **`startLaunchd` still uses `load -w`, deliberately.** Switching it would change
  `ocx service start` semantics (the `-w` clears the disabled list, `bootstrap` does not), and
  it already cross-checks with `launchdJobMatchesPlist` before throwing. Out of scope here.
- **`repairService()` itself still does not consult `diag.running`/`diag.viable`** (issue
  defect 1c). The no-op now lives inside `installLaunchd`, which is the only function that
  knows whether the rendered plist differs — a check in `repairService` would have to re-render
  it to be correct.
- **PATH is reused only when it is the ONLY difference.** Always preserving the installed
  PATH would make it un-updatable except through `uninstall` + `install`; never preserving it
  is the bug. So a plist that differs in PATH *and* something else is rewritten whole, which
  means a repair that legitimately changes the definition still bakes the repairing process's
  PATH. That is the accepted residual: at that point the eviction was going to happen anyway,
  and the operator asked for a new definition. The narrow rule is what keeps the common case —
  a repair from a tray helper or `ocx update`'s child against an otherwise-identical
  definition — from being an outage.
- **`unknown` refuses the whole command, install included.** A repair that cannot read
  launchd's state cannot prove the hub is down, and evicting on that guess is the original
  defect. A fresh install refuses for the same reason: the install path's own cleanup ops
  already fail closed on `unknown`, and the label may be held by a registration we cannot see.
  The cost is that a repair from a context which genuinely cannot reach `gui/<uid>` (ssh,
  cron) now fails instead of acting — with an error that says so and names the two `print`
  commands. That is the direction that keeps a serving hub serving.
- **Both domains are evicted unconditionally rather than enumerated.** `probeLaunchdLoadState`
  stops at the first domain that answers, so it cannot report "both"; asking twice more just
  to learn what `bootout` reports by exiting 3 would add a round trip per install for nothing.
- **`kickstart -k` kept, but narrowed.** It is still the only recovery that does not open a
  second eviction window, which is worth having for the busy-label case. It just cannot
  publish bytes, so it is limited to the case where there are none to publish.

## Tests

`tests/service/launchd-repair.test.ts` (54 cases — 46 from the first two rounds plus 8 for the
restart verb in section E), registered in
`scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`. The five
obsolete `installLaunchd` cases in `tests/service/service.test.ts` (which asserted the `load`
verb) were removed and replaced by a pointer comment; two new `stableLauncherEntry` cases were
added there (the recorded-launcher preference, and the systemd half of it), and the two
existing launcher-discovery cases now pass `state: null` to stay PATH-discovery tests.

Every `installLaunchd` case injects `plistPath` into its own fixture directory and a scripted
tri-state `probe`, so none of them can reach the real LaunchAgents path or a live launchctl.
`OPENCODEX_HOME` is pinned per case and RESTORED afterwards — the first round set it with no
`afterEach`, which leaks this file's temp home into the next file in the same Bun worker.

Coverage: healthy-and-identical repair is a no-op (zero launchctl calls); a plist differing
ONLY in the baked PATH is also a no-op and keeps the installed PATH on disk; identical plist
but stale live command still reloads, and deletes `<plist>.prev`; the reload is
domain-explicit `bootstrap` preceded by a `bootout` of BOTH domains, with no `load`/`unload`;
the settle loop waits while `print` answers 0, is bounded at 5 × 200 ms per evicted domain, and
is skipped entirely for a `bootout` that exited 3; exit 0 with a disagreeing probe is a
failure; exit 5 tries `kickstart -k` for unchanged bytes and refuses to trust it for an
env-only change (two bootstraps, no kickstart); a disabled job takes `enable` + bootstrap in a
pinned twelve-verb sequence; an ordinary repair never runs `enable`; a malformed plist is not
retried; terminal failure restores the previous bytes and names
`launchctl bootstrap gui/<uid> <plist>` and `print-disabled`; a `loaded-stale` outcome is
reported as loaded rather than down; a fresh install invents no rollback; an `unknown`
pre-check changes nothing at all (no verb, no file, no `.prev`) and names both `print`
commands; an `unknown` after an accepted bootstrap neither retries nor rolls back; an
`unknown` after a refused one throws without "IS NOT RUNNING"; the LaunchAgents guard refuses
the real directory. Plus `reusePreviousPlistPathVariable` (PATH-only, anything-else, identical,
a PATH containing `$&`, a definition with no PATH entry), `launchdEvictionTargets`, the
0/112/113/spawn-failure probe tri-state including "113 in gui is not absence, ask user/ too",
all four diagnostic states, and source-oracle cases for the repair-branch try/catch, the
install-cleanup ops (both domains, benign statuses), `installLaunchd` never using
`launchdJobMatchesPlist` while `startLaunchd` still does, the PATH pre-check, the state-path
filter plus its fail-loud write path, stop/uninstall, and the shared systemd launcher.

## Verification

Run from the worktree with `node_modules` symlinked.

Second round (the `restart` verb):

```
bun run typecheck                                    → clean (no output)
bun test tests/service/launchd-repair.test.ts        → 54 pass, 0 fail, 195 expect()
bun test tests/service/service.test.ts               → 205 pass, 0 fail, 674 expect()
bun test tests/cli/cli-version-skew.test.ts          → 29 pass, 0 fail
bun test tests/cli/cli-help.test.ts                  → 17 pass, 0 fail
bun run privacy:scan                                 → Privacy scan passed
```

Host state re-verified afterwards, read-only: plist 1985 bytes / state 320 bytes (both
unchanged, same mtime), `/healthz` on 10100 → 200. No `launchctl` mutation of the live label at
any point — `kickstart` included.

First round:

```
bun run typecheck                                    → clean (no output)
bun test tests/service/launchd-repair.test.ts        → 46 pass, 0 fail, 169 expect()
bun test tests/service/service.test.ts               → 205 pass, 0 fail, 668 expect()
bun test tests/service/launchd-repair.test.ts \
  tests/service/service.test.ts \
  tests/test-layout.test.ts tests/test-layout-tooling.test.ts
                                                     → 268 pass, 0 fail, 1388 expect()
bun test tests/service tests/update \
  tests/cli/uninstall.test.ts                        → 765 pass, 9 fail
bun run privacy:scan                                 → Privacy scan passed
```

Those 9 failures are pre-existing: 8 `winsw` cases plus `xAI API-key runtime injects priority
while OAuth does not`. They are cross-file `OPENCODEX_HOME` pollution inside a single
domain-wide `bun test` invocation — each file passes alone (`bun test
tests/service/winsw.test.ts` → 25 pass) — and the same 9 failed on `dev` before this branch
existed. **The full suite was NOT run** (focused files plus typecheck, per the lane
instruction); hosted CI on the pushed head is the proof.

Host state after the run: `~/Library/LaunchAgents/com.opencodex.proxy.plist` 1985 bytes,
0600, `plutil -lint` OK, command and `EnvironmentVariables` identical to
`launchctl print gui/501/com.opencodex.proxy`; `~/.opencodex/service-state.json` 320 bytes with
the real homes; `~/.opencodex/service-api-token` untouched; `/healthz` on 10100 → 200; no
`*.prev` file left behind. No `launchctl bootout`/`bootstrap`/`kickstart`/`enable` was run
against the live label at any point in this round — only `print`.

Both real files had to be restored TWICE during this round, and neither time by this branch's
tests — every `installLaunchd` write here is refused by `assertNotRealLaunchAgentsUnderTest`,
and the only other writer of that path (`uninstallLaunchd`) is guarded the same way.
Concurrent sessions in OTHER worktrees ran the unguarded suite and rewrote the live plist with
`/var/folders/.../opencodex-test-*` homes plus the live state record with their own sandbox
paths. The damaged state file names its writer in `cliPath`: once
`.claude/worktrees/agent-ae68eb45f20e1f3c6`, once a scratchpad worktree belonging to a sibling
agent of this very task. launchd keeps serving from its cached definition, so nothing breaks —
which is exactly why it goes unnoticed until the next restart. Restored both times from the
running job's own `launchctl print` output (plist 1985 bytes / state 320 bytes, verified).

That is the strongest argument for the two guards in this PR, and also its limit: a guard only
protects the branch that has it. Until this lands, any worktree's `bun test tests/service` can
do this again — including after this round was verified, so the live files are worth re-checking
once the concurrent sessions are finished.
