// Best-effort known-pattern regression lint, not a security boundary or
// completeness proof. Runtime mutation guards enforce update authority.
// Complete expressions, never prefixes or a JavaScript argument grammar.
// Probe rows confer no update authority. Child rows retain only their own child.
import { orchestratedChildReview } from "./update-review-orchestrated-child";
import { orchestratedEntryReview } from "./update-review-orchestrated-entry";
import { signedSupplyReview } from "./update-review-signed-supply";

const basePrimitiveAllowlist: readonly (readonly [string, string])[] = [
  ["src/update/config-preflight.ts:<module>:import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from \"node:fs\";", "read-only config preflight: open with O_RDONLY | O_NONBLOCK, inspect and read the fd, then close it"],
  ["src/update/config-preflight.ts:runConfigPreflight:openSync", "read-only config preflight default opener; called with O_RDONLY | O_NONBLOCK"],
  ["src/update/config-preflight.ts:runConfigPreflight:closeSync", "read-only config preflight default descriptor closer"],
  ["bin/ocx.mjs:runPackageManagerSelfUpdate:probeSpawnSync(bun.path, [\"--no-env-file\", join(here, \"../src/update/orchestrated-identity-probe-entry.ts\"), \"__update-orchestrated-identity\"], { encoding: \"utf8\", timeout: 8000, maxBuffer: 8192, windowsHide: true, stdio: [\"ignore\", \"pipe\", \"ignore\"], env: { ...updateHomeProbeEnvironment(process.env, { codexHome: process.env.CODEX_HOME ?? \"\", opencodexHome: configDir() }), OCX_IDENTITY_CLI_ROOT: resolve(here, \"..\"), OCX_IDENTITY_INSTALLER: manager, OCX_IDENTITY_TARGET: child.version }, })","read-only: verify child identity before mutation"],
  ["bin/ocx.mjs:<module>:probeSpawnSync(bun.path, [\"--no-env-file\", join(here, \"../src/update/orchestrated-identity-probe-entry.ts\"), process.argv[2]], { stdio: \"inherit\", timeout: 8000, windowsHide: true, env: { ...process.env, OCX_IDENTITY_CLI_ROOT: resolve(here, \"..\"), OCX_IDENTITY_INSTALLER: \"\", OCX_IDENTITY_TARGET: \"\" }, })","read-only: identity probe before launcher mutation"],
  ["bin/ocx.mjs:<module>:probeSpawnSync(bun.path, [\"--no-env-file\", cliPath, \"update\", \"--plan\", \"--json\", ...(version ? [\"--version\", version] : tag ? [\"--tag\", tag] : [])], { encoding: \"utf8\", maxBuffer: 65536, timeout: 60000, windowsHide: true, stdio: [\"ignore\", \"pipe\", 2], env: process.env })","read-only: orchestrated plan probe"],
  ["bin/ocx.mjs:<module>:probeSpawnSync(bun.path, [\"--no-env-file\", join(here, \"../src/update/orchestrated-identity-probe-entry.ts\"), \"__update-orchestrated-identity\"], { encoding: \"utf8\", maxBuffer: 8192, timeout: 8000, windowsHide: true, stdio: [\"ignore\", \"pipe\", 2], env: { ...updateHomeProbeEnvironment(process.env, { codexHome: process.env.CODEX_HOME ?? \"\", opencodexHome: configDir() }), OCX_IDENTITY_CLI_ROOT: resolve(here, \"..\"), OCX_IDENTITY_INSTALLER: \"\", OCX_IDENTITY_TARGET: \"\" }, })","read-only: orchestrated identity probe"],
  ["bin/ocx.mjs:<module>:probeSpawnSync(invocation.file, invocation.args, { stdio: capture ? \"pipe\" : \"ignore\", encoding: \"utf8\", timeout: 20000, windowsHide: true, cwd: PNPM_READ_CWD, env: pnpmReadEnvironment(unprivilegedOwnershipMutationEnvironment(process.env)), ...invocation.options })","read-only: pnpm ownership query"],
  ["bin/ocx.mjs:<module>:spawn: probeSpawn","pre-mutation: orchestrator spawns an independently admitted update child"],
  ["src/update/index.ts:runPnpmCandidate:probeSpawn(invocation.file, invocation.args, { stdio: capture ? \"pipe\" : \"ignore\", encoding: \"utf8\", timeout: 20_000, windowsHide: true, cwd: PNPM_READ_CWD, env: pnpmReadEnvironment(unprivilegedOwnershipMutationEnvironment(probeEnv)), ...invocation.options, })","read-only: pass probe to pnpm ownership or registry inspection"],
  ["src/update/index.ts:resolveCurrentPnpmGlobalOwner:runPnpmCandidate(commandPath, args, capture, probeSpawn, deps.env)","read-only: pass probe to pnpm ownership or registry inspection"],
  ["src/update/index.ts:selectedPnpmOwner:spawn: probeSpawn","read-only: pass probe to pnpm ownership or registry inspection"],
  ["src/update/index.ts:latestVersion:selectedPnpmOwner(owner, probeSpawn, probeEnv)","read-only: pass probe to pnpm ownership or registry inspection"],
  ["src/update/index.ts:latestVersion:probeSpawn(manager.bin, manager.args, { encoding: \"utf8\", timeout: 12000, windowsHide: true, cwd: installer === \"pnpm\" ? PNPM_READ_CWD : undefined, env: installer === \"pnpm\" ? pnpmReadEnvironment(unprivilegedOwnershipMutationEnvironment(manager.env ?? probeEnv ?? process.env)) : unprivilegedOwnershipMutationEnvironment(manager.env ?? probeEnv ?? process.env), ...manager.options, })","read-only: pass probe to pnpm ownership or registry inspection"],
  ["src/update/index.ts:runUpdateWithSession:runOwnedPnpm( owner!, args, capture, capture ? \"pipe\" : installStdio, probeSpawnSync, homePolicy.authorizeMutation, session, )","guarded: pnpm update callback authorizes package dispatch"],
  ["bin/ocx.mjs:<module>:process.stdout.write(`${JSON.stringify(result.result)}\\n`, resolveOutput)","read-only: report the orchestrated result returned by the independently admitted child"],
  ["src/update/posix-install-supervisor.mjs:<module>:import { spawn } from \"node:child_process\";","supervisor child: spawns only the installer its stdin caller names, with the invoking user's authority; reviewed caller runPosixInstallerSync launches this entry via guardedSpawnSync(authorizeMutation, 'package') at posix-install-supervisor.mjs:18"],
  ["src/update/posix-install-supervisor.mjs:<module>:import { readFileSync, renameSync, unlinkSync, writeFileSync } from \"node:fs\";","supervisor child: marker publication below; reviewed caller runPosixInstallerSync launches this entry via guardedSpawnSync(authorizeMutation, 'package') at posix-install-supervisor.mjs:18"],
  ["src/update/sync-update-mutex.mjs:<module>:import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync } from \"node:fs\";","pre-mutation: admission home creation and read-only marker inspection"],
  ["src/update/sync-update-mutex.ts:<module>:export * from \"./sync-update-mutex.mjs\";","pre-mutation: re-export admission mutex and read-only inspection"],
  ["src/update/test-home-guard.mjs:isTestHomeGuardArmed:globalThis.Bun","read-only: detect Bun test entry path"],
  ["src/update/posix-install-supervisor.mjs:publish:writeFileSync(temp, JSON.stringify({ ...marker, installerPid: pid, installerPgid: pid }), { flag: \"wx\", mode: 0o600 })","supervisor child: replaces only an existing marker in phase mutating with an integer pid (exclusive 0600 temp then rename); every reviewed caller passes join(configDir(), update-orchestrated.json)"],
  ["src/update/posix-install-supervisor.mjs:publish:renameSync(temp, path)","supervisor child: replaces only an existing marker in phase mutating with an integer pid; every reviewed caller passes join(configDir(), update-orchestrated.json)"],
  ["src/update/posix-install-supervisor.mjs:publish:unlinkSync(temp)","supervisor child: removes only its own unrenamed temp file"],
  ["src/update/windows-installer-marker.mjs:<module>:import { readFileSync, renameSync, unlinkSync, writeFileSync } from \"node:fs\";","Windows installer witness: marker publication below; reviewed callers runNpmInstall and the runWindowsInstallerSync bridge pass join(configDir(), update-orchestrated.json)"],
  ["src/update/windows-installer-marker.mjs:publishWindowsInstallerPid:writeFileSync(temp, JSON.stringify({ ...marker, installerPid: pid }), { flag: \"wx\", mode: 0o600 })","Windows installer witness: replaces only a marker awaiting an installer with the supervisor pid (exclusive 0600 temp then rename)"],
  ["src/update/windows-installer-marker.mjs:publishWindowsInstallerPid:renameSync(temp, markerPath)","Windows installer witness: replaces only a marker awaiting an installer with the supervisor pid"],
  ["src/update/windows-installer-marker.mjs:publishWindowsInstallerPid:unlinkSync(temp)","Windows installer witness: removes only its own unrenamed temp file"],
  ["src/update/posix-install-supervisor.mjs:alive:process.kill(-pgid, 0)","supervisor child: signal-zero probe of the installer group this supervisor spawned"],
  ["src/update/posix-install-supervisor.mjs:supervise:spawn(process.execPath, [entry, \"install\"], { detached: true, stdio: [\"pipe\", \"ignore\", \"inherit\"], cwd: config.cwd, env: process.env })","supervisor child: starts its own detached installer group; reviewed caller runPosixInstallerSync launches this entry via guardedSpawnSync(authorizeMutation, 'package') at posix-install-supervisor.mjs:18"],
  ["src/update/posix-install-supervisor.mjs:runPosixInstallerSupervisorMain:spawn(input.file, input.args, { cwd: input.cwd, env: process.env, stdio: [\"ignore\", \"inherit\", \"inherit\"] })","supervisor child: runs exactly the installer its stdin caller supplied, with the invoking user's authority; reviewed caller runPosixInstallerSync launches this entry via guardedSpawnSync(authorizeMutation, 'package') at posix-install-supervisor.mjs:18"],
  ["src/update/posix-install-supervisor.mjs:runPosixInstallerSupervisorMain:process.kill(process.pid, signal)","supervisor child: re-raises the installer's terminating signal on itself"],
  ["src/update/sync-update-mutex.mjs:ensureHome:mkdirSync(home, { mode: 0o700 })","pre-mutation: admission home creation"],
  ["src/update/sync-update-mutex.mjs:inspectUpdateMarker:openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))","read-only: bounded marker inspection and liveness probe"],
  ["src/update/sync-update-mutex.mjs:inspectUpdateMarker:readSync(fd, buffer, 0, buffer.length, 0)","read-only: bounded marker inspection and liveness probe"],
  ["src/update/sync-update-mutex.mjs:inspectUpdateMarker:process.kill(id, 0)","read-only: bounded marker inspection and liveness probe"],
  ["src/update/sync-update-mutex.mjs:inspectUpdateMarker:closeSync(fd)","read-only: bounded marker inspection and liveness probe"],
  ["bin/ocx.mjs:<module>:import { createRequire } from \"node:module\";", "single structurally confined resolver in bunBinDir; the shared policy checks its entire body and every loader reference"],
  ["bin/ocx.mjs:<module>:process.chdir(homedir())", "recover a deleted inherited cwd before launcher initialization; no package/state mutation"],
  ["src/update/notify.ts:<module>:import { createInterface } from \"node:readline/promises\";", "existing interactive terminal prompt only; exact stream use below"],
  ["src/update/notify.ts:maybeShowUpdatePrompt:createInterface({ input: process.stdin, output: process.stdout })", "ordinary terminal update-choice prompt, no package or runtime control"],
  ["src/update/job-pinned-start.ts:<module>:import { closeSync, mkdirSync, openSync, writeSync } from \"node:fs\";", "exact append-only pinned-start diagnostic log setup/descriptor cleanup below"],
  ["src/update/job-pinned-start.ts:spawnWorkerPinnedStart:mkdirSync(getConfigDir(), { recursive: true })", "ensure the private diagnostic log directory; never replace live files"],
  ["src/update/job-pinned-start.ts:spawnWorkerPinnedStart:openSync(logPath, \"a\")", "append-only update-pinned-start.log descriptor captured by this function"],
  ["src/update/job-pinned-start.ts:spawnWorkerPinnedStart:writeSync(logFd, `\\n--- ${new Date().toISOString()} ---\\n$ ${cmd.display}\\n`)", "append diagnostic header only to this function's log descriptor"],
  ["src/update/job-pinned-start.ts:spawnWorkerPinnedStart:closeSync(logFd)", "close only this function's diagnostic log descriptor on refusal or after spawn"],
  ["src/update/job.ts:<module>:import { existsSync, mkdirSync, readFileSync } from \"node:fs\";", "only ensureJobDir creates the private job-state directory"],
  ["src/update/job.ts:ensureJobDir:mkdirSync(dir, { recursive: true, mode: 0o700 })", "create missing job-state directory; job success publication remains guarded"],
  ["src/update/pnpm-read-policy.mjs:withPnpmCommandCwd:mkdtempSync(join(tmpdir(), \"ocx-pnpm-command-\"))", "exclusive disposable pnpm read-policy cwd under OS temp"],
  ["src/update/transactional-install.mjs:createOwnedStage:mkdir = deps.mkdir ?? mkdirSync", "private stage mkdir alias; only the two exact stage paths below"],
  ["src/update/transactional-install.mjs:createOwnedStage:mkdir(stageRoot)", "exclusive new randomly named private stage; existing directory fails"],
  ["src/update/transactional-install.mjs:createOwnedStage:mkdir(join(stageRoot, \"lib\"))", "npm layout inside the exclusively owned stage"],
  ["src/update/transactional-install.mjs:npmUpdateTransaction:mkdirSync(backupRoot, { recursive: true })", "empty backup container only; moving live package into it is separately guarded"],
  ["src/update/transactional-install.mjs:removeOwnedStage:rm = deps.rm", "injected private-stage removal forwarded only to ownedArtifactRm"],
  ["src/update/transactional-install.mjs:bootRestoreProbe:rename = deps.rename", "injected boot-recovery rename forwarded only to guardedRenameSync"],
  ["src/update/transactional-install.mjs:npmUpdateTransaction:rename = deps.rename", "injected package rename forwarded only to guardedRenameSync"],
  [
    "bin/ocx.mjs:readNodeUpdateHome:probeUpdateServiceHome(probeSpawnSync, bun.path, [\"--no-env-file\", join(dirname(launcherPath), \"..\", \"src\", \"update\", \"service-home-probe-entry.ts\")], { env })",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "bin/ocx.mjs:runPackageManagerSelfUpdate:probeSpawnSync(invocation.file, invocation.args, { stdio: capture ? \"pipe\" : \"ignore\", encoding: \"utf8\", timeout: 20_000, windowsHide: true, cwd: PNPM_READ_CWD, env: pnpmReadEnvironment(unprivilegedOwnershipMutationEnvironment(process.env)), ...invocation.options, })",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "bin/ocx.mjs:runPackageManagerSelfUpdate:probeSpawnSync(latestInvocation.file, latestInvocation.args, readProbeOptions(latestInvocation))",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "bin/ocx.mjs:runPackageManagerSelfUpdate:probeSpawnSync(invocation.file, invocation.args, readProbeOptions(invocation))",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "bin/ocx.mjs:readServiceInstalledFromStatus:probeSpawnSync(process.execPath, [launcherPath, \"status\", \"--json\"], { encoding: \"utf8\", timeout: 20_000, windowsHide: true, })",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "bin/ocx.mjs:refreshBackgroundServiceOrStartDirect:probeSpawnSync(process.execPath, [postUpdateLauncher, \"status\", \"--json\"], { encoding: \"utf8\", timeout: 20_000, windowsHide: true, })",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "bin/ocx.mjs:resolveBun:probeSpawnSync(process.execPath, [installJs], { stdio: \"inherit\" })",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "bin/ocx.mjs:<module>:probeSpawn(bun, [cliPath, `${NODE_LAUNCH_PROOF_PREFIX}${launchProof}`, ...process.argv.slice(2).filter(arg => !arg.startsWith(NODE_LAUNCH_PROOF_PREFIX))], { stdio: \"inherit\", // A headless Windows parent (Task Scheduler, dashboard restart, shortcut) has no // console to inherit. Without this flag Windows allocates a visible console for // the long-running Bun child, and closing that window kills the proxy (#1236). windowsHide: true, env: { // A cache shared with another Bun version (the CI test runner's) is evicted on every start. ...scopeTranspilerCacheToRuntime(inheritedEnv, bunRuntime.version, join), [NODE_LAUNCH_CONTEXT_ENV]: launchContext, [BUN_RUNTIME_SOURCE_ENV]: bunRuntime.source, [BUN_RUNTIME_PATH_ENV]: bunRuntime.path, }, })",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "src/update/async-check.ts:<module>:defaultDeps: AsyncLookupDeps = { ownerFn: pnpmOwner, spawnFn: probeSpawn }",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "src/update/async-check.ts:latestVersionAsync:child.kill()",
    "only this function's exact returned child / ordinary signal relay"
  ],
  [
    "src/update/bind-probe.ts:spawnBindProbe:probeSpawnSync(bin, [\"-e\", script], { windowsHide: true, timeout: 4000, stdio: \"ignore\", })",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "src/update/index.ts:runPnpmCandidate:probeSpawn: typeof probeSpawnSync = probeSpawnSync",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "src/update/index.ts:runPnpmCandidate:probeSpawn(invocation.file, invocation.args, { stdio: capture ? \"pipe\" : \"ignore\", encoding: \"utf8\", timeout: 20_000, windowsHide: true, cwd: PNPM_READ_CWD, env: pnpmReadEnvironment(unprivilegedOwnershipMutationEnvironment(process.env)), ...invocation.options, })",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "src/update/index.ts:resolveCurrentPnpmGlobalOwner:probeSpawn = deps.spawn ?? probeSpawnSync",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "src/update/index.ts:resolveCurrentPnpmGlobalOwner:runPnpmCandidate(commandPath, args, capture, probeSpawn)",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "src/update/index.ts:runOwnedPnpm:probeSpawn: typeof probeSpawnSync = probeSpawnSync",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "src/update/index.ts:runOwnedPnpm:guardedSpawnSync(authorizeMutation, \"package\", target.bin, target.args, { stdio, encoding: \"utf8\", timeout: 180_000, windowsHide: true, // Reads probe from the package dir; `add -g`/rollback children run from a neutral // directory so a Windows cwd handle never pins open the package pnpm is replacing. cwd, env: pnpmReadEnvironment(unprivilegedOwnershipMutationEnvironment(target.env)), ...target.options, }, probeSpawn)",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "src/update/index.ts:latestVersion:probeSpawn: typeof probeSpawnSync = probeSpawnSync",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "src/update/index.ts:latestVersion:probeSpawn(manager.bin, manager.args, { encoding: \"utf8\", timeout: 12000, windowsHide: true, cwd: installer === \"pnpm\" ? PNPM_READ_CWD : undefined, env: installer === \"pnpm\" ? pnpmReadEnvironment(unprivilegedOwnershipMutationEnvironment(manager.env ?? process.env)) : unprivilegedOwnershipMutationEnvironment(manager.env ?? process.env), ...manager.options, })",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "src/update/index.ts:checkUpdatePackageIntegrity:probeSpawn: typeof probeSpawnSync = probeSpawnSync",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "src/update/index.ts:checkUpdatePackageIntegrity:probeSpawn(target.bin, target.args, { encoding: \"utf8\", timeout: 12000, windowsHide: true, cwd: installer === \"pnpm\" ? PNPM_READ_CWD : undefined, env: installer === \"pnpm\" ? pnpmReadEnvironment(unprivilegedOwnershipMutationEnvironment(target.env ?? process.env)) : unprivilegedOwnershipMutationEnvironment(target.env ?? process.env), ...target.options, })",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "src/update/index.ts:runUpdateWithSession:checkUpdatePackageIntegrity(latest, probeSpawnSync, installer, owner)",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "src/update/index.ts:runUpdate:runOwnedPnpm( owner!, args, capture, capture ? \"pipe\" : installStdio, probeSpawnSync, homePolicy.authorizeMutation, )",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "src/update/job-update-home.ts:automaticUpdateLauncherSupported:probeUpdatePackageOnlyLauncher(launcher, probeSpawnSync, node, env)",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "src/update/job.ts:spawnGuiUpdateWorker:probeSpawn(launch.command, launch.argv, { detached: true, stdio: \"ignore\", windowsHide: true, env: { ...process.env, OCX_SERVICE: \"1\" }, })",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "src/update/job.ts:spawnGuiUpdateWorker:probeSpawnSync( resolveTrustedWindowsPowerShellExe(), [\"-NoProfile\", \"-NoLogo\", \"-NonInteractive\", \"-Command\", ps], { encoding: \"utf8\", windowsHide: true, timeout: 15_000 }, )",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "src/update/job.ts:runGuiUpdateWorker:checkUpdatePackageIntegrity(check.latestVersion, probeSpawnSync, check.installer, pnpmOwner)",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "src/update/notify.ts:triggerBackgroundRefreshIfStale:probeSpawn(process.execPath, args, { detached: true, stdio: \"ignore\", windowsHide: true, env: { ...process.env, OCX_SERVICE: \"1\" }, // never let the helper prompt })",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "src/update/npm-cache-preflight.mjs:resolveNpmCachePath:(options.spawnSyncFn ?? probeSpawnSync)(invocation.file, invocation.args, { encoding: \"utf8\", timeout: options.timeoutMs ?? NPM_CONFIG_TIMEOUT_MS, windowsHide: true, cwd: options.cwd ?? homedir(), ...invocation.options, env: invocation.options?.env ?? env, })",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "src/update/npm-cache-preflight.mjs:runPreflightWorker:probeSpawn = options.spawnSyncFn ?? probeSpawnSync",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "src/update/npm-cache-preflight.mjs:runPreflightWorker:probeSpawn( options.execPath ?? process.execPath, workerArgs, { encoding: \"utf8\", timeout: options.timeoutMs ?? WORKER_TIMEOUT_MS, windowsHide: true, env: options.env ?? process.env, }, )",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "src/update/npm-install.mjs:runNpmInstall:child.kill()",
    "only this function's exact returned child / ordinary signal relay"
  ],
  [
    "src/update/proxy-liveness-probe.mjs:probeProxyLiveness:probeSpawnSync( process.execPath, [\"-e\", script, host, String(port), String(timeoutMs)], { encoding: \"utf8\", timeout: timeoutMs + 1500, windowsHide: true }, )",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "src/update/worker-launch.ts:<module>:probeSpawnSync(path, [...SYSTEMD_SCOPE_ARGS, path, \"--version\"], { stdio: \"ignore\", timeout: 5_000, env: scopeProbeEnvironment() })",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "src/update/worker-launch.ts:<module>:probeSpawn(path, [...SYSTEMD_SCOPE_ARGS, path, \"--version\"], { stdio: \"ignore\", env: scopeProbeEnvironment() })",
    "bounded probe or ordinary launcher; no update control"
  ],
  [
    "src/update/worker-launch.ts:<module>:probe.kill(\"SIGKILL\")",
    "only this function's exact returned child / ordinary signal relay"
  ],
  ["src/update/async-check.ts:pnpmOwner:new Worker((deps.workerUrl ?? new URL(\"./pnpm-owner-worker.ts\", import.meta.url)).href)","bounded owner-discovery worker; no update controls"],
  ["src/update/async-check.ts:pnpmOwner:worker.terminate()","only this function's own owner-discovery worker"],
  ["src/update/pnpm-read-policy.mjs:<module>:import { mkdtempSync, lstatSync, writeFileSync, rmdirSync } from \"node:fs\";","private workspace, stage marker and committed-transaction recovery marker writes below only"],
  ["src/update/pnpm-read-policy.mjs:withPnpmCommandCwd:writeFileSync(join(cwd, files[0]), \"packages: []\\nignorePnpmfile: true\\n\", { flag: \"wx\", mode: 0o600 })","exclusive private workspace files or identity-checked empty directory"],
  ["src/update/pnpm-read-policy.mjs:withPnpmCommandCwd:writeFileSync(join(cwd, files[1]), \"ignore-pnpmfile=true\\n\", { flag: \"wx\", mode: 0o600 })","exclusive private workspace files or identity-checked empty directory"],
  ["src/update/pnpm-read-policy.mjs:withPnpmCommandCwd:rmdirSync(cwd)","exclusive private workspace files or identity-checked empty directory"],
  ["src/update/transactional-install.mjs:<module>:import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from \"node:fs\";","private workspace, stage marker and committed-transaction recovery marker writes below only"],
  ["src/update/transactional-install.mjs:createOwnedStage:writeFileSync(join(stageRoot, UPDATE_OWNER_MARKER), JSON.stringify({ schema: 1, kind: \"staging\", pkgName, pid: process.pid, createdAt: (deps.now ?? Date.now)(), }), { flag: \"wx\" })","exclusive private staging marker"],
  ["src/update/transactional-install.mjs:npmUpdateTransaction:writeFileSync(recoveryMarkerPath(scopeDir), JSON.stringify({ at: new Date().toISOString(), backup: backupPackage, live: packageDir, restore: 'move \"' + backupPackage + '\" back to \"' + packageDir + '\"', error: String(error?.message ?? error), rollbackError: String(rollbackError?.message ?? rollbackError), }, null, 2))","recovery marker for this already committed package transaction"],
  ["src/update/transactional-install.mjs:npmUpdateTransaction:writeFileSync(recoveryMarkerPath(scopeDir), JSON.stringify({ at: new Date().toISOString(), backup: backupPackage, live: packageDir, restore: 'move \"' + backupPackage + '\" back to \"' + packageDir + '\"', error: \"post-swap verification failed: \" + liveCheck.failures.join(\"; \"), rollbackError: String(rollbackError?.message ?? rollbackError), }, null, 2))","recovery marker for this already committed package transaction"],
  ["src/update/npm-cache-preflight.mjs:<module>:process.stdout.write(JSON.stringify({ protocol: PROTOCOL_VERSION, ...result }))","bounded helper protocol output; no successful update publication"],
  ["src/update/npm-install.mjs:runNpmInstall:process.stderr.write(chunk)","bounded helper protocol output; no successful update publication"],
  ["src/update/refresh-scheduler.ts:createRefreshScheduler:deps.write(tag, latest, deps.now())","version badge cache only; no runtime or install authority"]
];
export const updatePrimitiveAllowlist: readonly (readonly [string, string])[] = [...basePrimitiveAllowlist, ...orchestratedEntryReview.primitive, ...orchestratedChildReview.primitive, ...signedSupplyReview.primitive];
