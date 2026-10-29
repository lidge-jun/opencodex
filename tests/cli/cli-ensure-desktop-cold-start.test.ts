import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import {
  acquireDesktopLaunchLease,
  DESKTOP_COLD_START_TIMEOUT_MS,
  inspectDesktopProcess,
  launchDesktopApp,
  planEnsureColdStart,
  runDesktopColdStart,
  procfsHidesProcesses,
  scanLinuxExecutables,
  type DesktopColdStartDeps,
  type DesktopOwnershipState,
  type DesktopProcessState,
} from "../../src/cli/ensure-desktop-cold-start";
import type { ServiceOwnershipResolution } from "../../src/service/state";
import { removeTreeWithRetry } from "../helpers/remove-tree";

interface Calls { launches: number; waits: number[]; released: number }

function deps(options: {
  ownership: DesktopOwnershipState;
  process: DesktopProcessState;
  platform?: NodeJS.Platform;
  live?: boolean;
  launchOk?: boolean;
  leaseHeld?: boolean;
}, calls: Calls): DesktopColdStartDeps<{ port: number }> {
  return {
    platform: options.platform ?? "darwin",
    ownership: () => options.ownership,
    desktopProcess: () => options.process,
    launchDesktop: () => { calls.launches++; return options.launchOk ?? true; },
    acquireLaunchLease: () => options.leaseHeld ? null : () => { calls.released++; },
    waitForProxy: async timeoutMs => { calls.waits.push(timeoutMs); return options.live === false ? null : { port: 10100 }; },
  };
}

const fresh = (): Calls => ({ launches: 0, waits: [], released: 0 });

describe("ocx ensure cold start under OpenCodex Desktop (#6971)", () => {
  test("an unclaimed machine gets a CLI proxy while unknown evidence refuses", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(planEnsureColdStart({ ownership: "other", desktopProcess: "absent", platform })).toEqual({ kind: "spawn-cli" });
      expect(planEnsureColdStart({ ownership: "other", desktopProcess: "running", platform })).toEqual({ kind: "spawn-cli" });
      expect(planEnsureColdStart({ ownership: "desktop", desktopProcess: "running", platform })).toEqual({ kind: "wait-desktop" });
      expect(planEnsureColdStart({ ownership: "unknown", desktopProcess: "running", platform })).toEqual({ kind: "refuse", reason: "unverified" });
      for (const ownership of ["other", "desktop", "unknown"] as const) {
        expect(planEnsureColdStart({ ownership, desktopProcess: "unknown", platform })).toEqual({ kind: "refuse", reason: "unverified" });
      }
      expect(planEnsureColdStart({ ownership: "unknown", desktopProcess: "absent", platform })).toEqual({ kind: "refuse", reason: "unverified" });
    }
    expect(planEnsureColdStart({ ownership: "desktop", desktopProcess: "absent", platform: "darwin" })).toEqual({ kind: "launch-desktop" });
    expect(planEnsureColdStart({ ownership: "desktop", desktopProcess: "absent", platform: "linux" })).toEqual({ kind: "refuse", reason: "desktop-unlaunchable" });
    expect(planEnsureColdStart({ ownership: "desktop", desktopProcess: "absent", platform: "win32" })).toEqual({ kind: "refuse", reason: "desktop-unlaunchable" });
  });

  test("a claimed Desktop restart gap waits for Desktop's proxy instead of starting one", async () => {
    const calls = fresh();
    expect(await runDesktopColdStart(deps({ ownership: "desktop", process: "running" }, calls))).toEqual({ kind: "live", live: { port: 10100 } });
    expect(calls).toEqual({ launches: 0, waits: [DESKTOP_COLD_START_TIMEOUT_MS], released: 0 });
  });

  test("an unclaimed process named like Desktop cannot suppress the CLI cold start", async () => {
    const calls = fresh();
    expect(await runDesktopColdStart(deps({ ownership: "other", process: "running" }, calls))).toEqual({ kind: "cli" });
    expect(calls).toEqual({ launches: 0, waits: [], released: 0 });
  });

  test("verified unclaimed Desktop recovery keeps its supervised replacement during the restart gap", async () => {
    const calls = fresh();
    const result = await runDesktopColdStart({
      ...deps({ ownership: "other", process: "running" }, calls),
      desktopRecovery: async () => ({ kind: "recovering" as const }),
    });
    expect(result).toEqual({ kind: "live", live: { port: 10100 } });
    expect(calls).toEqual({ launches: 0, waits: [DESKTOP_COLD_START_TIMEOUT_MS], released: 0 });
  });

  test("a verified Desktop that stopped or cannot finish its recovery proof never falls back to CLI", async () => {
    for (const kind of ["stopped", "unknown"] as const) {
      const calls = fresh();
      const result = await runDesktopColdStart({
        ...deps({ ownership: "other", process: "running" }, calls),
        desktopRecovery: async () => ({ kind }),
      });
      expect(result.kind).toBe("failed");
      expect(calls).toEqual({ launches: 0, waits: [], released: 0 });
    }
  });

  test("a structurally unsupported verdict keeps a claimed running Desktop's wait; conflicting evidence still refuses", async () => {
    const calls = fresh();
    const result = await runDesktopColdStart({
      ...deps({ ownership: "desktop", process: "running", platform: "win32" }, calls),
      desktopRecovery: async () => ({ kind: "unknown" as const, unsupported: true }),
    });
    expect(result).toEqual({ kind: "live", live: { port: 10100 } });
    expect(calls).toEqual({ launches: 0, waits: [DESKTOP_COLD_START_TIMEOUT_MS], released: 0 });

    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(planEnsureColdStart({ ownership: "desktop", desktopProcess: "running", platform, recovery: { kind: "unknown", unsupported: true } }))
        .toEqual({ kind: "wait-desktop" });
      expect(planEnsureColdStart({ ownership: "desktop", desktopProcess: "running", platform, recovery: { kind: "unknown" } }))
        .toEqual({ kind: "refuse", reason: "unverified" });
      expect(planEnsureColdStart({ ownership: "desktop", desktopProcess: "absent", platform, recovery: { kind: "unknown", unsupported: true } }))
        .toEqual({ kind: "refuse", reason: "unverified" });
      expect(planEnsureColdStart({ ownership: "other", desktopProcess: "running", platform, recovery: { kind: "unknown", unsupported: true } }))
        .toEqual({ kind: "refuse", reason: "unverified" });
      expect(planEnsureColdStart({ ownership: "unknown", desktopProcess: "running", platform, recovery: { kind: "unknown", unsupported: true } }))
        .toEqual({ kind: "refuse", reason: "unverified" });
      expect(planEnsureColdStart({ ownership: "desktop", desktopProcess: "running", platform, recovery: { kind: "stopped" } }))
        .toEqual({ kind: "refuse", reason: "desktop-stopped" });
      expect(planEnsureColdStart({ ownership: "other", desktopProcess: "absent", platform, recovery: { kind: "unknown", unsupported: true } }))
        .toEqual({ kind: "refuse", reason: "unverified" });
    }
    expect(planEnsureColdStart({ ownership: "desktop", desktopProcess: "absent", platform: "win32", recovery: { kind: "none" } }))
      .toEqual({ kind: "refuse", reason: "desktop-unlaunchable" });
  });

  test("ownership is observed after asynchronous native evidence, so a new claim still governs startup", async () => {
    let ownership: DesktopOwnershipState = "other";
    const calls = fresh();
    const result = await runDesktopColdStart({
      ...deps({ ownership, process: "absent" }, calls), ownership: () => ownership,
      desktopRecovery: async () => { ownership = "desktop"; return { kind: "none" }; },
    });
    expect(result.kind).toBe("live");
    expect(calls.launches).toBe(1);
  });

  test("a Desktop that never brings its proxy back fails without a CLI fallback", async () => {
    const calls = fresh();
    const result = await runDesktopColdStart(deps({ ownership: "desktop", process: "running", live: false }, calls));
    expect(result.kind === "failed" && result.message).toContain("Start Proxy");
    expect(calls.launches).toBe(0);
  });

  test("a quit Desktop with its claim is started once, then awaited", async () => {
    const calls = fresh();
    expect((await runDesktopColdStart(deps({ ownership: "desktop", process: "absent" }, calls))).kind).toBe("live");
    expect(calls).toEqual({ launches: 1, waits: [DESKTOP_COLD_START_TIMEOUT_MS], released: 1 });
  });

  test("a concurrent ensure joins the launch in progress instead of starting Desktop again", async () => {
    const calls = fresh();
    expect((await runDesktopColdStart(deps({ ownership: "desktop", process: "absent", leaseHeld: true }, calls))).kind).toBe("live");
    expect(calls).toEqual({ launches: 0, waits: [DESKTOP_COLD_START_TIMEOUT_MS], released: 0 });
  });

  test("a failed or unanswered Desktop launch is an explicit failure", async () => {
    const refused = fresh();
    const notStarted = await runDesktopColdStart(deps({ ownership: "desktop", process: "absent", launchOk: false }, refused));
    expect(notStarted.kind === "failed" && notStarted.message).toContain("could not be started");
    expect(refused.waits).toEqual([]);
    expect(refused.released).toBe(1);

    const silent = fresh();
    const timedOut = await runDesktopColdStart(deps({ ownership: "desktop", process: "absent", live: false }, silent));
    expect(timedOut.kind === "failed" && timedOut.message).toContain("did not answer");
    expect(silent.released).toBe(1);
  });

  test("where Desktop cannot be started for the user, a claimed proxy is refused outright", async () => {
    for (const platform of ["linux", "win32"] as const) {
      const calls = fresh();
      const result = await runDesktopColdStart(deps({ ownership: "desktop", process: "absent", platform }, calls));
      expect(result.kind === "failed" && result.message).toContain("Open OpenCodex");
      expect(calls).toEqual({ launches: 0, waits: [], released: 0 });
    }
  });

  test("unreadable ownership or process state never reaches a CLI proxy", async () => {
    for (const facts of [{ ownership: "unknown" as const, process: "absent" as const }, { ownership: "other" as const, process: "unknown" as const }]) {
      const calls = fresh();
      const result = await runDesktopColdStart(deps(facts, calls));
      expect(result.kind === "failed" && result.message).toContain("Could not verify");
      expect(calls).toEqual({ launches: 0, waits: [], released: 0 });
    }
  });

  test("an unclaimed machine keeps the CLI cold start untouched", async () => {
    const calls = fresh();
    expect(await runDesktopColdStart(deps({ ownership: "other", process: "absent" }, calls))).toEqual({ kind: "cli" });
    expect(calls).toEqual({ launches: 0, waits: [], released: 0 });
  });
});

describe("Desktop process detection by executable identity", () => {
  test("Linux reads this user's process executables, so arguments naming Desktop do not count", () => {
    const seen: number[] = [];
    const scan = (paths: string[] | "unverified") => (uid: number) => { seen.push(uid); return paths; };
    expect(inspectDesktopProcess({ platform: "linux", uid: 1000, linuxExecutables: scan(["/usr/bin/tail", "/usr/lib/opencodex-desktop/opencodex-desktop"]) })).toBe("running");
    expect(seen).toEqual([1000]);
    const visible = { procfsHidesProcesses: () => false, desktopInstalled: () => true };
    expect(inspectDesktopProcess({ platform: "linux", uid: 1000, ...visible, linuxExecutables: scan(["/usr/bin/tail", "/usr/bin/bash"]) })).toBe("absent");
    // A filtered procfs proves no absence where Desktop is installed; without an install there is nothing to hide.
    expect(inspectDesktopProcess({ platform: "linux", uid: 1000, procfsHidesProcesses: () => true, desktopInstalled: () => true, linuxExecutables: scan(["/usr/bin/bash"]) })).toBe("unknown");
    expect(inspectDesktopProcess({ platform: "linux", uid: 1000, procfsHidesProcesses: () => true, desktopInstalled: () => false, linuxExecutables: scan(["/usr/bin/bash"]) })).toBe("absent");
    expect(inspectDesktopProcess({ platform: "linux", uid: 1000, linuxExecutables: scan("unverified") })).toBe("unknown");
    expect(inspectDesktopProcess({ platform: "linux", uid: 1000, linuxExecutables: () => { throw new Error("no /proc"); } })).toBe("unknown");
  });

  test.skipIf(process.platform !== "linux" && process.platform !== "darwin")("the real process scan answers on this host", () => {
    // An unanswerable scan would refuse every plain CLI cold start, so it must not be the norm.
    expect(["running", "absent"]).toContain(inspectDesktopProcess());
  });

  test("macOS lists this user's executables and requires an app bundle", () => {
    const seen: string[][] = [];
    const ps = (out: string) => (command: string, args: string[]) => { seen.push([command, ...args]); return out; };
    expect(inspectDesktopProcess({ platform: "darwin", uid: 501, run: ps("/usr/sbin/cfprefsd\n/Applications/OpenCodex.app/Contents/MacOS/opencodex-desktop\n") })).toBe("running");
    expect(seen[0]).toEqual(["/bin/ps", "-U", "501", "-o", "comm="]);
    expect(inspectDesktopProcess({ platform: "darwin", uid: 501, run: ps("/usr/bin/tail\n/tmp/opencodex-desktop\n") })).toBe("absent");
    expect(inspectDesktopProcess({ platform: "darwin", uid: 501, run: () => { throw new Error("ps failed"); } })).toBe("unknown");
  });

  test("Windows filters tasklist by image and current user", () => {
    const env = { SystemRoot: "C:\\Windows", USERNAME: "me" };
    let args: string[] = [];
    const tasklist = (out: string) => (_command: string, given: string[]) => { args = given; return out; };
    expect(inspectDesktopProcess({ platform: "win32", env, run: tasklist("\"opencodex-desktop.exe\",\"4242\",\"Console\",\"1\",\"80,000 K\"\r\n") })).toBe("running");
    expect(args).toContain("USERNAME eq me");
    expect(inspectDesktopProcess({ platform: "win32", env, run: tasklist("INFO: No tasks are running which match the specified criteria.\r\n") })).toBe("absent");
    expect(inspectDesktopProcess({ platform: "win32", env, run: () => { throw new Error("denied"); } })).toBe("unknown");
  });

  const owned = {
    kind: "owned" as const,
    ownership: { owner: "desktop" as const, installId: "install-a", consentGeneration: 1 },
    revision: 3,
  };
  /** A fake consented install: app-local install-id, a LaunchAgent plist, and a bundle on disk. */
  function fakeDesktopHome(options: {
    installId?: string; args?: unknown; bareArgs?: boolean; label?: string; identifier?: string;
    plist?: "present" | "absent"; executable?: "present" | "absent" | "directory"; bundleName?: string;
    bundleExecutable?: unknown; program?: unknown; relativeProgram?: boolean; runAtLoad?: unknown;
  } = {}) {
    // Keep the bundle on cwd's drive: Windows relative() returns an absolute path across drives.
    const fixtureRoot = join(process.cwd(), ".tmp");
    mkdirSync(fixtureRoot, { recursive: true });
    const home = mkdtempSync(join(fixtureRoot, "ocx-desktop-home-"));
    const bundle = join(home, "Applications", options.bundleName ?? "OpenCodex.app");
    const executable = join(bundle, "Contents", "MacOS", "opencodex-desktop");
    mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
    if (options.executable === "directory") mkdirSync(executable);
    else if (options.executable !== "absent") { writeFileSync(executable, ""); chmodSync(executable, 0o755); }
    const info = { CFBundleIdentifier: options.identifier ?? "com.opencodex.desktop",
      CFBundleExecutable: "bundleExecutable" in options ? options.bundleExecutable : "opencodex-desktop" };
    writeFileSync(join(bundle, "Contents", "Info.plist"), JSON.stringify(info));
    const store = join(home, "Library", "Application Support", "com.opencodex.desktop");
    mkdirSync(store, { recursive: true });
    if (options.installId !== undefined) writeFileSync(join(store, "install-id"), `${options.installId}\n`);
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    // A root-relative POSIX spelling also reaches this same-drive fixture on Windows.
    const absoluteProgram = process.platform === "win32" ? executable.slice(2).replaceAll("\\", "/") : executable;
    const program = options.relativeProgram ? relative(process.cwd(), executable) : absoluteProgram;
    const registration = { Label: options.label ?? "OpenCodex", RunAtLoad: "runAtLoad" in options ? options.runAtLoad : true,
      ProgramArguments: options.bareArgs ? [program] : (options.args ?? [program, "--autostart"]),
      ...("program" in options ? { Program: options.program } : {}) };
    if (options.plist !== "absent") writeFileSync(join(home, "Library", "LaunchAgents", "OpenCodex.plist"), JSON.stringify(registration));
    const seen: string[][] = [];
    const run = (command: string, args: string[]) => {
      seen.push([command, ...args]);
      const target = args[args.length - 1] ?? "";
      if (command !== "/usr/bin/plutil") return "";
      return readFileSync(target, "utf8");
    };
    return { home, bundle, executable, program, seen, run };
  }
  const launch = (fixture: ReturnType<typeof fakeDesktopHome>, ownership: () => ServiceOwnershipResolution = () => owned) =>
    launchDesktopApp({ platform: "darwin", home: fixture.home, ownership, run: fixture.run });

  test("a Desktop claim launches the app its own login registration recorded, never a bundle-id lookup", () => {
    const fixture = fakeDesktopHome({ installId: "install-a" });
    try {
      expect(launch(fixture)).toBe(true);
      expect(fixture.seen.at(-1)).toEqual(["/usr/bin/open", "-g", realpathSync(fixture.bundle), "--args", "--autostart"]);
      expect(fixture.seen.flat().includes("-b")).toBe(false);
    } finally { removeTreeWithRetry(fixture.home); }
  });

  test("the registration shape auto-launch writes without --autostart is still the consented path", () => {
    const fixture = fakeDesktopHome({ installId: "install-a", bareArgs: true });
    try {
      expect(launch(fixture)).toBe(true);
      expect(fixture.seen.at(-1)).toEqual(["/usr/bin/open", "-g", realpathSync(fixture.bundle), "--args", "--autostart"]);
    } finally { removeTreeWithRetry(fixture.home); }
  });

  test("a false or missing RunAtLoad refuses launch without waiting or falling back to a CLI proxy", async () => {
    for (const runAtLoad of [false, undefined]) {
      const fixture = fakeDesktopHome({ installId: "install-a", runAtLoad });
      try {
        expect(launch(fixture)).toBe(false);
        const calls = fresh();
        const dependencies = deps({ ownership: "desktop", process: "absent" }, calls);
        dependencies.launchDesktop = () => launch(fixture);
        const result = await runDesktopColdStart(dependencies);
        let cliFallbacks = 0;
        if (result.kind === "cli") cliFallbacks++;
        expect(result.kind === "failed" && result.message).toContain("Open OpenCodex manually");
        expect(calls.waits).toEqual([]);
        expect(calls.released).toBe(1);
        expect(cliFallbacks).toBe(0);
        expect(fixture.seen.filter(call => call[0] === "/usr/bin/open")).toHaveLength(0);
      } finally { removeTreeWithRetry(fixture.home); }
    }
  });

  test("a non-app directory refuses the launch without reading its Info.plist or waiting for a proxy", async () => {
    for (const bundleName of ["OpenCodex", "OpenCodex.app.backup"]) {
      const fixture = fakeDesktopHome({ installId: "install-a", bundleName });
      try {
        const calls = fresh();
        const dependencies = deps({ ownership: "desktop", process: "absent" }, calls);
        dependencies.launchDesktop = () => launch(fixture);
        const result = await runDesktopColdStart(dependencies);
        expect(result.kind === "failed" && result.message).toContain("Open OpenCodex manually");
        expect(calls.waits).toEqual([]);
        expect(calls.released).toBe(1);
        expect(fixture.seen).toHaveLength(1);
        expect(fixture.seen[0]?.[0]).toBe("/usr/bin/plutil");
        expect(fixture.seen[0]?.at(-1)).toEndWith("OpenCodex.plist");
      } finally { removeTreeWithRetry(fixture.home); }
    }
  });

  test("an existing relative registration path cannot select a bundle from the caller's working directory", () => {
    const fixture = fakeDesktopHome({ installId: "install-a", relativeProgram: true });
    try {
      expect(isAbsolute(fixture.program)).toBe(false);
      expect(realpathSync(fixture.program)).toBe(realpathSync(fixture.executable));
      expect(launch(fixture)).toBe(false);
      expect(fixture.seen.some(call => call[0] === "/usr/bin/open")).toBe(false);
    } finally { removeTreeWithRetry(fixture.home); }
  });

  test("bundle launch requires the declared main executable to match the registered regular file", () => {
    for (const options of [{ bundleExecutable: "other" }, { bundleExecutable: undefined },
      { bundleExecutable: "../opencodex-desktop" }, { bundleExecutable: ["opencodex-desktop"] },
      { executable: "directory" as const }, { executable: "absent" as const }]) {
      const fixture = fakeDesktopHome({ installId: "install-a", ...options });
      try {
        expect(launch(fixture)).toBe(false);
        expect(fixture.seen.some(call => call[0] === "/usr/bin/open")).toBe(false);
      } finally { removeTreeWithRetry(fixture.home); }
    }
  });

  test("malformed registration arguments and a conflicting Program never launch", () => {
    for (const options of [{ args: [] }, { args: [123] }, { args: "opencodex-desktop" },
      { args: ["/some/app", "--other"] }, { args: ["/some/app", "--autostart", "extra"] },
      { args: ["C:\\OpenCodex.app\\Contents\\MacOS\\opencodex-desktop"] },
      { args: ["C:OpenCodex.app\\Contents\\MacOS\\opencodex-desktop"] },
      { program: "/another/app" }, { program: null }]) {
      const fixture = fakeDesktopHome({ installId: "install-a", ...options });
      try { expect(launch(fixture)).toBe(false); expect(fixture.seen).toHaveLength(1); }
      finally { removeTreeWithRetry(fixture.home); }
    }
  });

  test("a matching optional Program is accepted, and conversion or open failures refuse", () => {
    const fixture = fakeDesktopHome({ installId: "install-a" });
    try {
      const plist = join(fixture.home, "Library", "LaunchAgents", "OpenCodex.plist");
      const registration = JSON.parse(readFileSync(plist, "utf8"));
      writeFileSync(plist, JSON.stringify({ ...registration, Program: fixture.program }));
      expect(launch(fixture)).toBe(true);
      for (const failingCommand of ["/usr/bin/plutil", "/usr/bin/open"]) {
        expect(launchDesktopApp({ platform: "darwin", home: fixture.home, ownership: () => owned,
          run: (command, args) => { if (command === failingCommand) throw new Error("fixture failure"); return fixture.run(command, args); },
        })).toBe(false);
      }
      writeFileSync(plist, "malformed plist");
      expect(launch(fixture)).toBe(false);
    } finally { removeTreeWithRetry(fixture.home); }
  });

  test.skipIf(process.platform === "win32")("a non-executable registered file refuses launch", () => {
    const fixture = fakeDesktopHome({ installId: "install-a" });
    try {
      chmodSync(fixture.executable, 0o644);
      expect(launch(fixture)).toBe(false);
      expect(fixture.seen.some(call => call[0] === "/usr/bin/open")).toBe(false);
    } finally { removeTreeWithRetry(fixture.home); }
  });

  test.skipIf(process.platform !== "darwin")("native plutil decodes the producer's XML registration and bundle selector", () => {
    const fixture = fakeDesktopHome({ installId: "install-a" });
    try {
      const plist = join(fixture.home, "Library", "LaunchAgents", "OpenCodex.plist");
      for (const path of [plist, join(fixture.bundle, "Contents", "Info.plist")]) {
        execFileSync("/usr/bin/plutil", ["-convert", "xml1", path]);
      }
      const seen: string[][] = [];
      const run = (command: string, args: string[]) => {
        seen.push([command, ...args]);
        if (command === "/usr/bin/open") return "";
        return execFileSync(command, args, { encoding: "utf8" });
      };
      expect(launchDesktopApp({ platform: "darwin", home: fixture.home, ownership: () => owned, run })).toBe(true);
      expect(seen.at(-1)).toEqual(["/usr/bin/open", "-g", realpathSync(fixture.bundle), "--args", "--autostart"]);
      writeFileSync(join(fixture.bundle, "Contents", "Info.plist"), JSON.stringify({
        CFBundleIdentifier: "com.opencodex.desktop", CFBundleExecutable: "other",
      }));
      seen.length = 0;
      expect(launchDesktopApp({ platform: "darwin", home: fixture.home, ownership: () => owned, run })).toBe(false);
      expect(seen.some(call => call[0] === "/usr/bin/open")).toBe(false);
    } finally { removeTreeWithRetry(fixture.home); }
  });

  test("a claim without matching install-id, registration or Desktop executable refuses the launch", () => {
    for (const fixture of [
      fakeDesktopHome({ installId: "other-install" }),
      fakeDesktopHome({ installId: "install-a", plist: "absent" }),
      fakeDesktopHome({ installId: "install-a", label: "OtherApp" }),
      fakeDesktopHome({ installId: "install-a", args: [join(tmpdir(), "elsewhere", "opencodex-desktop")] }),
      fakeDesktopHome({ installId: "install-a", args: ["executable-only-name"] }),
      fakeDesktopHome({ installId: "install-a", identifier: "com.example.fake" }),
    ]) {
      try {
        expect(launch(fixture)).toBe(false);
        expect(fixture.seen.flat().includes("com.opencodex.desktop")).toBe(false);
        expect(fixture.seen[0]?.[0]).not.toBe("/usr/bin/open");
      } finally { removeTreeWithRetry(fixture.home); }
    }
    // install-id store absent entirely.
    const noId = fakeDesktopHome();
    try { expect(launch(noId)).toBe(false); } finally { removeTreeWithRetry(noId.home); }
  });

  test("a claim that is not a recorded Desktop owner, or a failing lookup, never launches", () => {
    const fixture = fakeDesktopHome({ installId: "install-a" });
    try {
      expect(launch(fixture, () => ({ kind: "none", revision: 2 }))).toBe(false);
      expect(launch(fixture, () => ({ kind: "owned", ownership: { owner: "cli", installId: "install-a", consentGeneration: 1 }, revision: 2 }))).toBe(false);
      expect(fixture.seen).toEqual([]);
    } finally { removeTreeWithRetry(fixture.home); }
    for (const platform of ["linux", "win32"] as const) {
      const commands: string[] = [];
      expect(launchDesktopApp({ platform, run: command => { commands.push(command); return ""; } })).toBe(false);
      expect(commands).toEqual([]);
    }
  });
});

describe("Desktop launch lease", () => {
  const withDir = (body: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-desktop-lease-"));
    try { body(dir); } finally { removeTreeWithRetry(dir); }
  };
  const leases = (dir: string) => readdirSync(dir).sort();

  test("a live holder keeps the lease however long its launch takes; it lapses when the holder exits", () => withDir(dir => {
    let holderAlive = true;
    const alive = (pid: number) => pid === 100 ? holderAlive : true;
    const release = acquireDesktopLaunchLease(dir, { pid: 100, alive });
    expect(release).not.toBeNull();
    expect(leases(dir)).toEqual(["desktop-launch.1.lease"]);
    expect(acquireDesktopLaunchLease(dir, { pid: 200, alive })).toBeNull();
    // Release keeps the newest generation so numbering can never restart below a stale contender.
    release!();
    expect(leases(dir)).toEqual(["desktop-launch.1.lease"]);
    holderAlive = false;
    expect(acquireDesktopLaunchLease(dir, { pid: 200, alive })).not.toBeNull();
    expect(leases(dir)).toEqual(["desktop-launch.2.lease"]);
  }));

  test("a dead holder is superseded by the next generation, which only one contender can create", () => withDir(dir => {
    writeFileSync(join(dir, "desktop-launch.4.lease"), "100");
    const alive = (pid: number) => pid !== 100;
    const first = acquireDesktopLaunchLease(dir, { pid: 200, alive });
    expect(first).not.toBeNull();
    expect(leases(dir)).toEqual(["desktop-launch.5.lease"]);
    expect(acquireDesktopLaunchLease(dir, { pid: 300, alive })).toBeNull();
    first!();
    expect(leases(dir)).toEqual(["desktop-launch.5.lease"]);
  }));

  test("a winner that released and exited cannot let numbering restart under a stale contender", () => withDir(dir => {
    const lease = (generation: number) => join(dir, `desktop-launch.${generation}.lease`);
    writeFileSync(lease(3), "100");
    // While A checks generation 3, B takes 4 and exits, then C takes 5 and cleans up 4.
    let paused = false;
    const alive = (pid: number) => {
      if (pid === 100 && !paused) {
        paused = true;
        writeFileSync(lease(4), "200"); unlinkSync(lease(3));
        writeFileSync(lease(5), "300"); unlinkSync(lease(4));
        return false;
      }
      return pid === 300;
    };
    expect(acquireDesktopLaunchLease(dir, { pid: 400, alive })).toBeNull();
    expect(leases(dir)).toEqual(["desktop-launch.5.lease"]);
  }));

  test("a contender that loses the race for a generation joins the winner instead of launching", () => withDir(dir => {
    writeFileSync(join(dir, "desktop-launch.1.lease"), "100");
    // Between this caller's check of generation 1 and its publish, a peer published generation 2.
    let checked = false;
    const alive = (pid: number) => {
      if (pid === 100 && !checked) { checked = true; writeFileSync(join(dir, "desktop-launch.2.lease"), "999"); return false; }
      return pid !== 100;
    };
    expect(acquireDesktopLaunchLease(dir, { pid: 200, alive })).toBeNull();
    expect(readFileSync(join(dir, "desktop-launch.2.lease"), "utf8")).toBe("999");
    expect(leases(dir).filter(name => name.endsWith(".tmp"))).toEqual([]);
  }));

  test("a stale contender that publishes below the winner stands down", () => withDir(dir => {
    writeFileSync(join(dir, "desktop-launch.3.lease"), "100");
    // While this caller checks generation 3, the winner publishes generation 5 and cleans up 3 and 4.
    const alive = (pid: number) => {
      if (pid === 100) { writeFileSync(join(dir, "desktop-launch.5.lease"), "999"); return false; }
      return true;
    };
    expect(acquireDesktopLaunchLease(dir, { pid: 200, alive })).toBeNull();
    expect(leases(dir)).toEqual(["desktop-launch.3.lease", "desktop-launch.5.lease"]);
  }));

  test("an unreadable lease directory still allows the launch", () => {
    const release = acquireDesktopLaunchLease(join(tmpdir(), "ocx-desktop-lease-missing", "nested"));
    expect(release).not.toBeNull();
    release!();
  });
});

describe.skipIf(process.platform === "win32")("Linux procfs scan", () => {
  const uid = process.getuid?.() ?? 0;
  function fakeProc(entries: Record<string, { exe?: string; unreadableExe?: boolean; comm?: string }>, body: (proc: string) => void) {
    const proc = mkdtempSync(join(tmpdir(), "ocx-fake-proc-"));
    try {
      for (const [pid, entry] of Object.entries(entries)) {
        mkdirSync(join(proc, pid));
        // A regular file where the link should be makes readlink fail, as a non-dumpable process does.
        if (entry.unreadableExe) writeFileSync(join(proc, pid, "exe"), "");
        else if (entry.exe) symlinkSync(entry.exe, join(proc, pid, "exe"));
        if (entry.comm !== undefined) writeFileSync(join(proc, pid, "comm"), `${entry.comm}\n`);
      }
      writeFileSync(join(proc, "uptime"), "1 1\n");
      body(proc);
    } finally { removeTreeWithRetry(proc); }
  }

  test("a non-dumpable unrelated process is ruled out by its comm, so plain cold starts keep working", () => fakeProc({
    "10": { exe: "/usr/bin/bash" },
    "20": { unreadableExe: true, comm: "ssh-agent" },
  }, proc => {
    expect(scanLinuxExecutables(uid, 10, proc)).toEqual(["/usr/bin/bash"]);
  }));

  test("an unreadable process named like Desktop makes the answer unverifiable", () => fakeProc({
    "10": { exe: "/usr/bin/bash" },
    "30": { unreadableExe: true, comm: "opencodex-deskt" },
  }, proc => {
    expect(scanLinuxExecutables(uid, 10, proc)).toBe("unverified");
  }));

  test("a scan that cannot see this process is filtered and proves no absence", () => fakeProc({
    "10": { exe: "/usr/bin/bash" },
  }, proc => {
    expect(scanLinuxExecutables(uid, 99, proc)).toBe("unverified");
  }));

  test("other users' processes are skipped and Desktop is found by its executable", () => fakeProc({
    "10": { exe: "/usr/bin/bash" },
    "40": { exe: "/opt/OpenCodex/opencodex-desktop" },
  }, proc => {
    // readdir order is filesystem-defined.
    expect((scanLinuxExecutables(uid, 10, proc) as string[]).sort()).toEqual(["/opt/OpenCodex/opencodex-desktop", "/usr/bin/bash"]);
    expect(scanLinuxExecutables(uid + 1, 10, proc)).toEqual([]);
  }));
});

describe("procfs hidepid detection", () => {
  const withMountinfo = (text: string | null, body: (path: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-mountinfo-"));
    try {
      const path = join(dir, "mountinfo");
      if (text !== null) writeFileSync(path, text);
      body(path);
    } finally { removeTreeWithRetry(dir); }
  };
  const line = (options: string) => `22 27 0:5 / /proc rw,nosuid,nodev,noexec,relatime shared:13 - proc proc ${options}\n`;

  test("hidepid=2/4 and their names hide processes; 0, 1 and plain mounts do not", () => {
    for (const options of ["rw,hidepid=2", "rw,hidepid=invisible", "rw,hidepid=4", "rw,hidepid=ptraceable,subset=pid"]) {
      withMountinfo(line(options), path => expect(procfsHidesProcesses(path)).toBe(true));
    }
    for (const options of ["rw", "rw,hidepid=0", "rw,hidepid=1", "rw,hidepid=noaccess"]) {
      withMountinfo(line(options), path => expect(procfsHidesProcesses(path)).toBe(false));
    }
  });

  test("only the /proc mount counts, and an unreadable mount table is treated as filtering", () => {
    withMountinfo("30 27 0:5 / /other/proc rw - proc proc rw,hidepid=2\n" + line("rw"), path => expect(procfsHidesProcesses(path)).toBe(false));
    withMountinfo(null, path => expect(procfsHidesProcesses(path)).toBe(true));
  });
});
