import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createTempHome } from "../helpers/temp-home";
import { automaticUpdateLauncherSupported, packageOnlyUpdateSucceeded, prepareWorkerUpdateHome } from "../../src/update/job-update-home";
import { join } from "node:path";
import { readUpdateJob, runGuiUpdateWorker } from "../../src/update/job";
import type { UpdateServiceHomeAuthority } from "../../src/update/service-home-policy.mjs";

test("an old delegated launcher is refused before automatic update starts", async () => {
  const box = createTempHome("ocx-update-home-worker-");
  const priorHome = process.env.HOME;
  process.env.HOME = box.root;
  mkdirSync(box.codexHome, { recursive: true });
  try {
    const events: string[] = [];
    await runGuiUpdateWorker("old-launcher", "latest", false, {
      checkForUpdateFn: () => ({ currentVersion: "2.7.40", latestVersion: "2.7.41", channel: "latest",
        installer: "npm", updateAvailable: true, canUpdate: true, command: "fixture", releaseNotesUrl: "fixture" }),
      integrityFn: () => ({ ok: true, integrity: "sha512-testfixturevalue000000000" }),
      cachePreflightFn: () => ({ ok: true, reason: "ok" }),
      serviceHomeAuthorityFn: () => ({ kind: "same" }),
      launcherSupportsUpdateHomeFn: (launcher, node) => {
        expect(launcher).toMatch(/bin[\\/]ocx\.mjs$/); expect(node).toBeTruthy(); events.push("probe"); return false;
      },
      runCommandFn: () => { events.push("update"); return { status: 0, signal: null }; },
    });
    expect(events).toEqual(["probe"]);
    expect(readUpdateJob("old-launcher")?.status).toBe("failed");
    expect(readUpdateJob("old-launcher")?.error).toContain("guarded recovery protocol");
  } finally {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    box.remove();
  }
});

test("package-only capability can be verified without home or Bun inspection", () => {
  const box = createTempHome("ocx-update-home-protocol-");
  try {
    mkdirSync(join(box.root, "bin")); mkdirSync(join(box.root, "src", "update"), { recursive: true });
    writeFileSync(join(box.root, "src", "update", "service-home-protocol.json"), JSON.stringify({
      schemaVersion: 1, launcherProtocolVersion: 1, entry: "__update-home-probe",
    }));
    writeFileSync(join(box.root, "src", "update", "service-home-package-only-protocol.json"), JSON.stringify({
      schemaVersion: 1, packageOnlyProtocolVersion: 2, entry: "__update-package-only-probe",
    }));
    const launcher = join(box.root, "bin", "ocx.mjs");
    writeFileSync(launcher, 'console.log(JSON.stringify({schemaVersion:1,packageOnlyProtocolVersion:2}));');
    expect(automaticUpdateLauncherSupported(launcher, process.execPath)).toBe(true);
    // A v1 launcher cannot enforce a pinned baseline; mixed-version delegation fails closed.
    writeFileSync(launcher, 'console.log(JSON.stringify({schemaVersion:1,packageOnlyProtocolVersion:1}));');
    expect(automaticUpdateLauncherSupported(launcher, process.execPath)).toBe(false);
    writeFileSync(launcher, 'console.log("malformed");');
    expect(automaticUpdateLauncherSupported(launcher, process.execPath)).toBe(false);
    writeFileSync(join(box.root, "src", "update", "service-home-package-only-protocol.json"), JSON.stringify({
      schemaVersion: 1, packageOnlyProtocolVersion: 1, entry: "__update-package-only-probe",
    }));
    const bootMarker = join(box.root, "bootstrap-ran");
    writeFileSync(launcher, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(bootMarker)}, 'executed');`);
    expect(automaticUpdateLauncherSupported(launcher, process.execPath)).toBe(false);
    expect(existsSync(bootMarker)).toBe(false); // A v1 child's bootstrap is never executed.
  } finally { box.remove(); }
});

for (const installer of ["npm", "bun"] as const) test(`worker ${installer} installs with initial unknown but never restarts`, async () => {
  const box = createTempHome("ocx-update-home-unknown-worker-");
  mkdirSync(box.codexHome, { recursive: true });
  try {
    const events: string[] = [];
    await runGuiUpdateWorker(`unknown-${installer}`, "latest", true, {
      checkForUpdateFn: () => ({ currentVersion: "2.7.40", latestVersion: "2.7.41", channel: "latest",
        installer, updateAvailable: true, canUpdate: true, command: "fixture", releaseNotesUrl: "fixture" }),
      integrityFn: () => ({ ok: true, integrity: "sha512-testfixturevalue000000000" }),
      cachePreflightFn: () => ({ ok: true, reason: "ok" }),
      launcherSupportsUpdateHomeFn: () => true,
      serviceHomeAuthorityFn: () => ({ kind: "unknown" }),
      resolveOwnershipFn: () => { throw new Error("restart must not acquire runtime authority"); },
      runCommandFn: (_job, bin, args) => {
        expect(args).toEqual([expect.stringMatching(/bin[\\/]ocx\.mjs$/), "update", "--tag", "latest", "--update-package-only",
          "--update-worker-home", "unknown", "--update-worker-result"]);
        expect(bin).toBeTruthy(); events.push("update"); return { status: 0, signal: null };
      },
      trayHandoffFn: () => { throw new Error("package-only must never touch the tray"); },
      trayCommandFn: () => { throw new Error("package-only must never run tray commands"); },
    });
    expect(events).toEqual(["update"]);
    const job = readUpdateJob(`unknown-${installer}`);
    expect(job).toMatchObject({ status: "succeeded", restarted: false });
    // The persisted command must survive renderSafeCommand: bare node name plus the launcher
    // path placeholder, like the ordinary npm/pnpm worker display — never an ocx literal that
    // would be withheld as an unrecognized shape.
    expect(job?.command).toBe("node <path> update --tag latest --update-package-only");
    expect(JSON.stringify(job?.log)).toContain("ownership could not be verified");
    expect(JSON.stringify(job?.log)).toContain("Restart the proxy manually");
  } finally { box.remove(); }
});

test("a child package-only success vetoes parent restart even when its own home remains matching", async () => {
  const box = createTempHome("ocx-update-home-child-result-");
  mkdirSync(box.codexHome, { recursive: true });
  try {
    let restartChecks = 0;
    await runGuiUpdateWorker("child-package-only", "latest", true, {
      checkForUpdateFn: () => ({ currentVersion: "2.7.40", latestVersion: "2.7.41", channel: "latest",
        installer: "npm", updateAvailable: true, canUpdate: true, command: "fixture", releaseNotesUrl: "fixture" }),
      integrityFn: () => ({ ok: true, integrity: "sha512-testfixturevalue000000000" }),
      cachePreflightFn: () => ({ ok: true, reason: "ok" }), launcherSupportsUpdateHomeFn: () => true,
      serviceHomeAuthorityFn: () => ({ kind: "same" }),
      resolveOwnershipFn: () => { restartChecks++; throw new Error("runtime recovery forbidden"); },
      runCommandFn: (_job, _bin, args) => {
        expect(args).toContain("--update-worker-result"); return { status: 75, signal: null };
      },
    });
    expect(restartChecks).toBe(0);
    expect(readUpdateJob("child-package-only")).toMatchObject({ status: "succeeded", restarted: false });
  } finally { box.remove(); }
});

test("a spaced Windows launcher path still yields a recognizable package-only display", () => {
  // renderSafeCommand splits on \s and only accepts bare tool tokens: a raw `C:\Program Files\...`
  // display would withhold on both counts (split path, `node.exe` tool). The persisted display
  // must carry the pre-sanitized `<path>` placeholder while bin/args keep the real spaced path.
  const command = { bin: "placeholder", args: [] as string[], display: "" };
  const reports: string[] = [];
  const policy = prepareWorkerUpdateHome(command, "npm",
    "C:\\Program Files\\OpenCodex\\bin\\ocx.mjs", "node.exe", "latest",
    message => reports.push(message),
    () => ({ kind: "unknown" }),
    () => true);
  expect(policy?.packageOnly).toBe(true);
  expect(command.bin).toBe("node.exe");
  expect(command.args).toEqual([
    "C:\\Program Files\\OpenCodex\\bin\\ocx.mjs", "update", "--tag", "latest",
    "--update-package-only", "--update-worker-home", "unknown", "--update-worker-result",
  ]);
  expect(command.display).toBe("node <path> update --tag latest --update-package-only");
});

test("a home authority change after install persists the refusal as the job error", async () => {
  const box = createTempHome("ocx-update-home-late-refusal-");
  mkdirSync(box.codexHome, { recursive: true });
  try {
    let flipped = false;
    await runGuiUpdateWorker("late-refusal", "latest", true, {
      checkForUpdateFn: () => ({ currentVersion: "2.7.40", latestVersion: "2.7.41", channel: "latest",
        installer: "npm", updateAvailable: true, canUpdate: true, command: "fixture", releaseNotesUrl: "fixture" }),
      integrityFn: () => ({ ok: true, integrity: "sha512-testfixturevalue000000000" }),
      cachePreflightFn: () => ({ ok: true, reason: "ok" }),
      launcherSupportsUpdateHomeFn: () => true,
      serviceHomeAuthorityFn: () => flipped ? { kind: "foreign", subject: "b".repeat(64) } : { kind: "same" },
      runCommandFn: () => { flipped = true; return { status: 0, signal: null }; },
    });
    const job = readUpdateJob("late-refusal");
    expect(job).toMatchObject({ status: "failed", restarted: false });
    // The refusal text the policy reported must reach `error`, not only `log` — the dashboard
    // surfaces `error` as the failure reason.
    expect(job?.error).toContain("Automatic update restart refused");
    expect(job?.error).toContain("ocx service status");
  } finally { box.remove(); }
});

test("package-only success status is never accepted from an unmarked package manager", () => {
  expect(packageOnlyUpdateSucceeded({ args: ["add", "-g"] }, 75, false)).toBe(false);
  expect(packageOnlyUpdateSucceeded({ args: ["--update-worker-result"] }, 1, true)).toBe(false);
});

test("a home flip during the worker preflight refuses before any command is shaped", () => {
  const reports: string[] = [];
  let calls = 0;
  const command = { bin: "placeholder", args: [] as string[], display: "" };
  const policy = prepareWorkerUpdateHome(command, "npm", "C:\\ocx\\bin\\ocx.mjs", "node", "latest",
    message => reports.push(message),
    () => (calls++, calls === 1 ? { kind: "same" } : { kind: "foreign", subject: "b".repeat(64) }),
    () => true);
  // The first probe is the baseline; the flipped second probe already fails checkPackage
  // inside prepareWorkerUpdateHome, so this must refuse before any command is shaped.
  expect(policy).toBeNull();
  expect(reports.join()).toContain("Automatic update restart refused");
});

test("the guarded launcher argv carries the parent baseline; the raw bun lane stays raw", () => {
  const foreign = { kind: "foreign", subject: "b".repeat(64) } as const;
  const npm = { bin: "placeholder", args: ["C:\\ocx\\bin\\ocx.mjs", "update", "--tag", "latest"], display: "" };
  expect(prepareWorkerUpdateHome(npm, "npm", "C:\\ocx\\bin\\ocx.mjs", "node", "latest",
    () => {}, () => foreign, () => true)?.initial).toEqual(foreign);
  expect(npm.args).toEqual(["C:\\ocx\\bin\\ocx.mjs", "update", "--tag", "latest",
    "--update-worker-home", `foreign:${foreign.subject}`, "--update-worker-result"]);
  const bun = { bin: "bun", args: ["add", "-g", "@bitkyc08/opencodex@latest"], display: "" };
  expect(prepareWorkerUpdateHome(bun, "bun", "C:\\ocx\\bin\\ocx.mjs", "node", "latest",
    () => {}, () => ({ kind: "same" }), () => true)?.initial).toEqual({ kind: "same" });
  expect(bun.args).toEqual(["add", "-g", "@bitkyc08/opencodex@latest"]);
});

test("a home flip between the tray handoff and the update command refuses before replacement", async () => {
  // The raw package-manager lane cannot carry the baseline argv; the worker's own recheck
  // at the replacement boundary is the only gate. Failing it must not run the command.
  const box = createTempHome("ocx-update-home-boundary-");
  mkdirSync(box.codexHome, { recursive: true });
  try {
    let handedOff = false;
    const events: string[] = [];
    const trayCommands: string[][] = [];
    await runGuiUpdateWorker("boundary-refusal", "latest", false, {
      checkForUpdateFn: () => ({ currentVersion: "2.7.40", latestVersion: "2.7.41", channel: "latest",
        installer: "bun", updateAvailable: true, canUpdate: true, command: "fixture", releaseNotesUrl: "fixture" }),
      integrityFn: () => ({ ok: true, integrity: "sha512-testfixturevalue000000000" }),
      cachePreflightFn: () => ({ ok: true, reason: "ok" }),
      launcherSupportsUpdateHomeFn: () => true,
      serviceHomeAuthorityFn: () => handedOff ? { kind: "foreign", subject: "b".repeat(64) } : { kind: "same" },
      trayHandoffFn: () => { handedOff = true; return { installed: true, running: true, stopBeforeReplacement: true,
        refreshAfterReplacement: true, restoreOnFailure: true, installArgs: ["tray", "install"] }; },
      trayCommandFn: (_job, _bin, args) => { trayCommands.push(args.slice(1)); return { status: 0, signal: null }; },
      runCommandFn: () => { events.push("update"); return { status: 0, signal: null }; },
    });
    expect(events).toEqual([]);
    expect(trayCommands).toEqual([["tray", "start"]]); // Only the own stopped tray is restored.
    const job = readUpdateJob("boundary-refusal");
    expect(job).toMatchObject({ status: "failed", restarted: false });
    expect(job?.error).toContain("Automatic update restart refused");
  } finally { box.remove(); }
});

for (const wasRunning of [false, true]) test(`a home flip after a successful update installs no tray artifact (previously running: ${wasRunning})`, async () => {
  const box = createTempHome("ocx-update-home-tray-gate-");
  mkdirSync(box.codexHome, { recursive: true });
  try {
    let replaced = false;
    const trayCommands: string[][] = [];
    await runGuiUpdateWorker("tray-gate", "latest", false, {
      checkForUpdateFn: () => ({ currentVersion: "2.7.40", latestVersion: "2.7.41", channel: "latest",
        installer: "npm", updateAvailable: true, canUpdate: true, command: "fixture", releaseNotesUrl: "fixture" }),
      integrityFn: () => ({ ok: true, integrity: "sha512-testfixturevalue000000000" }),
      cachePreflightFn: () => ({ ok: true, reason: "ok" }),
      launcherSupportsUpdateHomeFn: () => true,
      serviceHomeAuthorityFn: () => replaced ? { kind: "foreign", subject: "b".repeat(64) } : { kind: "same" },
      trayHandoffFn: () => ({ installed: true, running: wasRunning, stopBeforeReplacement: wasRunning,
        refreshAfterReplacement: true, restoreOnFailure: wasRunning, installArgs: ["tray", "install"] }),
      trayCommandFn: (_job, _bin, args) => { trayCommands.push(args.slice(1)); return { status: 0, signal: null }; },
      runCommandFn: (_job, _bin, args) => {
        expect(args.slice(-3)).toEqual(["--update-worker-home", "same", "--update-worker-result"]);
        replaced = true;
        return { status: 0, signal: null };
      },
    });
    // Refusal restores only the own tray stopped before replacement — no install, no refresh.
    expect(replaced).toBe(true);
    expect(trayCommands).toEqual(wasRunning ? [["tray", "start"]] : []);
    const job = readUpdateJob("tray-gate");
    expect(job).toMatchObject({ status: "failed", restarted: false });
    expect(job?.error).toContain("Automatic update restart refused");
  } finally { box.remove(); }
});

test("a stable matching home still refreshes the own tray after the update command", async () => {
  const box = createTempHome("ocx-update-home-tray-ok-");
  mkdirSync(box.codexHome, { recursive: true });
  try {
    const trayCommands: string[][] = [];
    await runGuiUpdateWorker("tray-refresh", "latest", false, {
      checkForUpdateFn: () => ({ currentVersion: "2.7.40", latestVersion: "2.7.41", channel: "latest",
        installer: "npm", updateAvailable: true, canUpdate: true, command: "fixture", releaseNotesUrl: "fixture" }),
      integrityFn: () => ({ ok: true, integrity: "sha512-testfixturevalue000000000" }),
      cachePreflightFn: () => ({ ok: true, reason: "ok" }),
      launcherSupportsUpdateHomeFn: () => true,
      serviceHomeAuthorityFn: () => ({ kind: "same" }),
      trayHandoffFn: () => ({ installed: true, running: true, stopBeforeReplacement: true,
        refreshAfterReplacement: true, restoreOnFailure: true, installArgs: ["tray", "install"] }),
      trayCommandFn: (_job, _bin, args) => { trayCommands.push(args.slice(1)); return { status: 0, signal: null }; },
      runCommandFn: () => ({ status: 0, signal: null }),
    });
    expect(trayCommands).toEqual([["tray", "install"]]);
    expect(readUpdateJob("tray-refresh")).toMatchObject({ status: "succeeded", restarted: false });
  } finally { box.remove(); }
});

for (const initial of [{ kind: "absent" }, { kind: "foreign", subject: "a".repeat(64) }] as const) test(`the actual worker pins ${initial.kind} authority across the recovery lease boundary`, async () => {
  const box = createTempHome("ocx-worker-recovery-baseline-");
  mkdirSync(box.codexHome, { recursive: true });
  try {
    let home: UpdateServiceHomeAuthority = initial;
    const events: string[] = [];
    const controls: string[] = [];
    await runGuiUpdateWorker("recovery-baseline", "latest", true, {
      checkForUpdateFn: () => ({ currentVersion: "2.7.40", latestVersion: "2.7.41", channel: "latest",
        installer: "bun", updateAvailable: true, canUpdate: true, command: "fixture", releaseNotesUrl: "fixture" }),
      integrityFn: () => ({ ok: true, integrity: "sha512-testfixturevalue000000000" }),
      cachePreflightFn: () => ({ ok: true, reason: "ok" }),
      serviceHomeAuthorityFn: () => home,
      trayHandoffFn: () => ({ installed: false, running: false, stopBeforeReplacement: false,
        refreshAfterReplacement: false, restoreOnFailure: false, installArgs: ["tray", "install", "--no-start"] }),
      runCommandFn: () => { events.push("replacement"); return { status: 0, signal: null }; },
      // This callback runs under the restart lease, AFTER the worker's last home check,
      // immediately before finishGuiUpdateRestart calls the real restartAfterUpdate.
      resolveOwnershipFn: () => {
        events.push("restart-lease");
        home = initial.kind === "absent" ? { kind: "same" } : { kind: "foreign", subject: "b".repeat(64) };
        return { kind: "none", revision: 0 };
      },
      restartIo: {
        serviceInstalledFn: () => true, serviceViableFn: () => false,
        stopServiceWrappersFn: () => { controls.push("wrappers"); },
        waitForPort: async () => { controls.push("reclaim"); return true; },
        runService: () => { controls.push("repair"); return { status: 1 }; },
        restartServiceManagerFn: async () => { controls.push("manager"); return "failed"; },
        spawnStart: () => { controls.push("start"); }, readPidFn: () => null, listListenPidsFn: () => [],
        probeProxy: async () => false, healthTimeoutMs: 0,
      },
    });
    expect(events).toEqual(["replacement", "restart-lease"]);
    expect(controls).toEqual([]);
    expect(readUpdateJob("recovery-baseline")).toMatchObject({ status: "failed", restarted: false });
    expect(readUpdateJob("recovery-baseline")?.error).toContain("Automatic update restart refused");
  } finally { box.remove(); }
});
