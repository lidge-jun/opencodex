# 001 — GUI update worker restart path, line by line

Trace of what the dashboard update button actually executes on macOS with a
launchd service installed. Line numbers re-derived with `grep -n` against the
working tree after the round-1 audit found the original citations off by 5-370
lines.

> **Scope note (R2).** This document traces the *worker*. The root cause lives one
> layer below it, in `launchctl load`'s exit convention — see `000_plan.md` §D1 and
> `003_audit_round1_correction.md`. The defects described here are what turn that
> silent load failure into "update failed, proxy gone".

## Entry

`runGuiUpdateWorker(jobId, channel, restart)` — `src/update/job.ts:1299`.

The worker runs as a detached child with `OCX_SERVICE: "1"` and stdio ignored
(`src/update/job.ts:408`), which matters twice later: it is why the worker's own
output is invisible to the user, and why `updateChildStdio()`
(`src/update/index.ts:74`) switches package-manager children to `pipe`.

Pre-update capture at `src/update/job.ts:1306-1317` records the live listen
target before anything is stopped:

```
const rt = readRuntimePort();
const livePid = readPid();
const runtimeTrusted = !!(rt && livePid && rt.pid === livePid);
captured = { port: runtimeTrusted ? rt.port : configPort, hostname: ..., oldPid }
```

This is correct and not implicated. On the reported machine it captures
`{ port: 10100, hostname: "127.0.0.1", oldPid: <service child> }`.

## Install

`runLoggedCommand(job, cmd.bin, cmd.args, UPDATE_TIMEOUT_MS)` at
`src/update/job.ts:1391`. `cmd` comes from `updateExecutionCommand()`, which for
the npm installer resolves to `npm install -g @bitkyc08/opencodex@<resolved>`
(`src/update/index.ts` `updateCommand`). A non-zero exit fails the job and
returns — so a *failed* install is not this bug. The user confirms 2.9.1 landed,
so the worker reached the restart branch with `status === 0`.

## Restart branch

`src/update/job.ts:1414-1418`:

```
if (restart) {
  job = updateJob(job, { status: "restarting" }, "Update installed. Restarting proxy...");
  if (!(await finishGuiUpdateRestart(job, captured, check.installer))) return;
  updateJob(job, { status: "succeeded", restarted: true }, "Restart requested and proxy is healthy.");
```

`finishGuiUpdateRestart` (`:1183`) for `installer === "npm"` with a service
installed scans for live listeners on the captured port. After a stop-first
update nothing is live, so it logs *"npm self-update did not leave a live
listener; performing explicit restart..."* and falls through to
`restartAfterUpdate`.

## restartAfterUpdate — the three defects

`src/update/job.ts:671`.

### D2: macOS always re-registers the service

`:733-737`:

```
if (process.platform === "win32" && process.env.OCX_SERVICE === "1") {
  updateJob(job, {}, "Skipping service reinstall from the non-elevated update worker; ...");
  skipServiceInstall = true;
}
```

The guard is Windows-only by construction — the comment says *"Keep
systemd/launchd reinstall on non-Windows supervisors."* So on macOS the worker
proceeds to `:761`:

```
const run = io.runService ?? ((j, bin, args) => runLoggedCommand(j, bin, args, RESTART_TIMEOUT_MS));
const result = run(job, cmd.bin, cmd.args);
serviceOk = result.status === 0;
```

where `cmd` is `restartCommand(true, "npm", launcher, port, svcArgs)` =
`node <pkg>/bin/ocx.mjs service install`.

That reinstall re-derives `cliEntry()` (`src/service.ts:46`) from the tree npm
just wrote, and `installLaunchd()` (`src/service.ts:1282`) writes the plist and
`launchctl load -w`s it. **Nothing between those two points asks whether the
baked command can execute.** `installLaunchd` returns void; the only failure
signal is a thrown `execSync`, and `launchctl load -w` succeeds for a plist whose
`ProgramArguments` point at a broken binary — launchd does not validate the
target at load time.

### D3: `viable` short-circuits the safety net

`:778-792`:

```
if (serviceOk) {
  const viable = (io.serviceViableFn ?? isServiceViable)();
  if (viable) return;
  updateJob(job, {}, "Service reinstall exited 0 but the background service is not viable ...");
}
```

The comment above it states the intent plainly: *"Exit 0 is not enough: a
reinstall can leave stale/missing assets ... Fall through to a direct start so
browser-dashboard updates do not require a viable Background Service for
recovery."* The intent is right; the predicate is too weak.

`isServiceViable()` → `diagnoseService()` (`src/service.ts:1591-1600`) on darwin:

```
const installed = existsSync(plistPath());
const running   = installed && Boolean(statusLaunchd());
const stale     = installed && bakedServicePathsDiagnostic() !== null;
const viable    = installed && running && !stale;
```

- `statusLaunchd()` is `launchctl list | grep com.opencodex.proxy || true`. A job
  that has crash-looped a hundred times is still listed. **`running` is true.**
- `bakedServicePathsDiagnostic()` (`:1545`) filters the baked paths by
  `!existsSync(path)`. A 450-byte placeholder exists. **`stale` is false.**

So `viable === true`, the function `return`s, and the direct-start fallback at
`:795` onward — the entire recovery path — never runs. The worker then reports
success through `confirmNpmExplicitRestart`? No: it returned from
`restartAfterUpdate` *before* that, and `finishGuiUpdateRestart` proceeds to
`confirmNpmExplicitRestart` (`:1248`), which awaits `/healthz`. That probe fails,
so the job is marked `failed` with `restartFailureHint(port)`.

**This is why the user saw "업데이트가 완료되지 않고" — the job's terminal state is
`failed` even though npm succeeded.** The install landed; the restart never did.

### RETRACTED: "nothing validates the baked runtime"

R1 claimed `isRealBunBinary()` is never consulted on the service path, making a
450-byte placeholder bakeable into the plist. **This is false.**
`bundledBunPath()` (`src/lib/bun-runtime.ts:35-46`) filters every candidate
through it before `cliEntry()` ever sees a path, and the reinstall child
(`node bin/ocx.mjs service install`) additionally routes through `resolveBun()`
(`bin/ocx.mjs:344`), which self-heals a stub. The stub cannot reach
`ProgramArguments`.

Retained as a narrow hardening item in `050_baked_runtime_hardening.md`.
Full retraction record in `003_audit_round1_correction.md`.

## Measured evidence

### The decisive measurement (macOS 27.0, real installed job)

```
$ launchctl load -w ~/Library/LaunchAgents/com.opencodex.proxy.plist
Load failed: 5: Input/output error
Try running `launchctl bootstrap` as root for richer errors.
$ echo $?
0
```

Failure on stderr, **exit 0**. `startLaunchd()` (`src/service.ts:1294`) passes
this through `sh()` (`:355` — `execSync`, throws only on non-zero), so the CLI
prints `✅ service started.` for a load that did nothing.

`launchctl print gui/501/com.opencodex.proxy` on the same host shows the live
`arguments` block, which is what makes "loaded, but from an older plist"
detectable at all.

### Supporting, non-causal

```
$ npm install bun@1.3.14
-rwxr-xr-x  63096576  bun.exe        # real Mach-O arm64, --version -> 1.3.14

$ npm install --ignore-scripts bun@1.3.14
-rwxr-xr-x       450  bun.exe        # placeholder; existsSync() true, exec bit set
```

Recorded because it establishes the 450-byte/63MB boundary that
`isRealBunBinary`'s 1MB floor encodes. It is **not** evidence for this bug: npm
11.17.0 does not block the script by default, and the validated resolution path
rejects the stub regardless.

## What is NOT the cause

- **The Bun placeholder stub.** Refuted; see the retraction above.
- **The update command itself.** Exit 0, confirmed by the user's 2.9.1 install.
- **`chooseListenPort()` reclaim tuning** (30s → 60s in 2.9.0). It only fires on a
  hard-pinned start that actually launches; a job that never loaded never reaches
  port selection. A real second-order asymmetry — see `002` — but not this.
- **The star prompt** (`OCX_SERVICE` guarded, `src/cli/star-prompt.ts:107`).
- **Management-token ACL hardening** (Windows-only `hardenSecretDir` paths).
