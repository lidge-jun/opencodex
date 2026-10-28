// Best-effort known-pattern regression lint, not a security boundary or
// completeness proof. Runtime mutation guards enforce update authority.
// Complete expressions, never prefixes or a JavaScript argument grammar.
// Probe rows confer no update authority. Child rows retain only their own child.
export const updatePrimitiveAllowlist: readonly (readonly [string, string])[] = [
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
    "bin/ocx.mjs:<module>:child.kill(sig)",
    "only this function's exact returned child / ordinary signal relay"
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
    "src/update/index.ts:runUpdate:checkUpdatePackageIntegrity(latest, probeSpawnSync, installer, owner)",
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
