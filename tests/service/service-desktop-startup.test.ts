import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPidPath, getRuntimePortPath } from "../../src/config/process-state";
import { deriveDesktopStartup, diagnoseMacDesktopStartup, desktopStartupOwnership } from "../../src/service/desktop-startup";
import { createSupervisionLatch, desktopSupervisionPaths, inspectDesktopSupervision, type SupervisionEvidence } from "../../src/service/desktop-supervision.mjs";
import type { ServiceOwnershipResolution } from "../../src/service/state";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ocx-desktop-startup-")));
  roots.push(home);
  const app = join(home, "OpenCodex.app", "Contents", "MacOS", "opencodex-desktop").replaceAll("\\", "/");
  const proxy = join(home, "OpenCodex.app", "Contents", "MacOS", "ocx").replaceAll("\\", "/");
  const idPath = join(home, "Library", "Application Support", "com.opencodex.desktop", "install-id");
  const plistPath = join(home, "Library", "LaunchAgents", "OpenCodex.plist");
  for (const path of [app, proxy, idPath, plistPath]) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, path === idPath ? "installation-a" : "fixture");
    chmodSync(path, 0o700);
  }
  const owner: ServiceOwnershipResolution = { kind: "owned", revision: 1,
    ownership: { owner: "desktop", installId: "installation-a", consentGeneration: 1 } };
  const state = {
    owner, plist: { Label: "OpenCodex", RunAtLoad: true, ProgramArguments: [app, "--autostart"] },
    disabled: 'disabled services = { "OpenCodex" => enabled }',
    loaded: `program = ${app}\npath = ${plistPath}`,
    child: `200 ${proxy}`, parent: `1 ${app}`, pid: 100 as number | null,
    fail: "", ownerReads: 0, pidReads: 0, changedPid: false, changedOwner: false,
  };
  const deps = {
    platform: "darwin" as const, home, uid: 501,
    ownership: (): ServiceOwnershipResolution => {
      state.ownerReads++;
      return state.changedOwner && state.ownerReads > 1 ? { kind: "none", revision: 2 } : state.owner;
    },
    readPid: () => { state.pidReads++; return state.changedPid && state.pidReads > 1 ? 101 : state.pid; },
    readRuntimePortPid: () => null,
    run: (command: string, args: string[]) => {
      if (command === state.fail) throw new Error("unavailable evidence");
      if (command === "/usr/bin/plutil") return JSON.stringify(state.plist);
      if (command === "/bin/launchctl") return args[0] === "print-disabled" ? state.disabled : state.loaded;
      if (command === "/bin/ps") return args[1] === "100" ? state.child : state.parent;
      throw new Error(`unexpected command: ${command}`);
    },
  };
  return { state, deps, idPath, proxy, app, plistPath };
}

test("matching install, loaded login item and exact supervisor paths grant desktop protection", () => {
  const { deps } = fixture();
  expect(diagnoseMacDesktopStartup(deps)).toEqual({ owned: true, loginEnabled: true, running: true, viable: true });
});

test("failed identity and login/process evidence retain the durable desktop claim", () => {
  const mutations = [
    (f: ReturnType<typeof fixture>) => writeFileSync(f.idPath, "different-install"),
    (f: ReturnType<typeof fixture>) => rmSync(f.idPath),
    (f: ReturnType<typeof fixture>) => { f.state.plist.RunAtLoad = false; },
    (f: ReturnType<typeof fixture>) => { f.state.plist.ProgramArguments[1] = "--wrong"; },
    (f: ReturnType<typeof fixture>) => { f.state.disabled = 'disabled services = { "OpenCodex" => disabled }'; },
    (f: ReturnType<typeof fixture>) => { f.state.disabled = 'disabled services = { "OpenCodex" => true }'; },
    (f: ReturnType<typeof fixture>) => { f.state.disabled = "unreadable output"; },
    (f: ReturnType<typeof fixture>) => { f.state.loaded = `program = ${f.proxy}\npath = ${f.plistPath}`; },
    (f: ReturnType<typeof fixture>) => { f.state.loaded = `program = ${f.app}\npath = ${f.idPath}`; },
    (f: ReturnType<typeof fixture>) => { f.state.child = `200 ${f.app}`; },
    (f: ReturnType<typeof fixture>) => { f.state.child = `1 ${f.proxy}`; },
    (f: ReturnType<typeof fixture>) => { f.state.parent = `1 ${f.proxy}`; },
    (f: ReturnType<typeof fixture>) => { f.state.pid = null; },
    (f: ReturnType<typeof fixture>) => { f.state.changedPid = true; },
    (f: ReturnType<typeof fixture>) => { f.state.changedOwner = true; },
    ...["/usr/bin/plutil", "/bin/launchctl", "/bin/ps"].map(command =>
      (f: ReturnType<typeof fixture>) => { f.state.fail = command; }),
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    expect(diagnoseMacDesktopStartup(f.deps)).toMatchObject({ owned: true, viable: false });
  }
});

test("other platforms and CLI or unknown ownership cannot grant desktop protection", () => {
  const f = fixture();
  expect(diagnoseMacDesktopStartup({ ...f.deps, platform: "linux" })).toBeUndefined();
  expect(f.state.ownerReads).toBe(0);
  for (const owner of [
    { kind: "unknown", reason: "unreadable" },
    { kind: "owned", revision: 1, ownership: { owner: "cli", installId: "installation-a", consentGeneration: 1 } },
  ] as ServiceOwnershipResolution[]) {
    f.state.owner = owner;
    expect(diagnoseMacDesktopStartup(f.deps)).toBeUndefined();
    expect(f.state.pidReads).toBe(0);
  }
});

test("ownership-only fallback does not run external probes", () => {
  const f = fixture();
  expect(desktopStartupOwnership({ ...f.deps, run: () => { throw new Error("must not probe"); } })).toEqual({
    owned: true, loginEnabled: false, running: false, viable: false,
  });
  expect(f.state.pidReads).toBe(0);
});

test("an unowned Desktop supervisor receives login credit without install-id matching", () => {
  const f = fixture(); f.state.owner = { kind: "none", revision: 0 };
  rmSync(f.idPath);
  expect(inspectDesktopSupervision(f.deps)).toEqual({
    kind: "desktop", runtimePid: 100, supervisorPid: 200, app: realpathSync(f.app), proxy: realpathSync(f.proxy),
  });
  expect(diagnoseMacDesktopStartup(f.deps)).toEqual({
    owned: false, loginEnabled: true, running: true, viable: true,
    supervisor: { supervisorPid: 200, runtimePid: 100, app: realpathSync(f.app) },
  });
  expect(desktopStartupOwnership(f.deps)).toBeUndefined();
});

test("unowned login failures retain the supervisor but revoke restart viability", () => {
  const changes = [
    (f: ReturnType<typeof fixture>) => { f.state.disabled = 'disabled services = { "OpenCodex" => disabled }'; },
    (f: ReturnType<typeof fixture>) => { f.state.plist.RunAtLoad = false; },
    (f: ReturnType<typeof fixture>) => { f.state.loaded = `program = ${f.proxy}\npath = ${f.plistPath}`; },
    (f: ReturnType<typeof fixture>) => { f.state.fail = "/bin/launchctl"; },
    (f: ReturnType<typeof fixture>) => { f.state.fail = "/usr/bin/plutil"; },
    (f: ReturnType<typeof fixture>) => { f.state.plist.ProgramArguments[0] = f.proxy; },
  ];
  for (const change of changes) {
    const f = fixture(); f.state.owner = { kind: "none", revision: 0 }; change(f);
    expect(diagnoseMacDesktopStartup(f.deps)).toEqual({
      owned: false, loginEnabled: false, running: true, viable: false,
      supervisor: { supervisorPid: 200, runtimePid: 100, app: realpathSync(f.app) },
    });
  }
});

test("a login registration for another app cannot credit the observed supervisor", () => {
  const f = fixture(); const other = fixture(); f.state.owner = { kind: "none", revision: 0 };
  f.state.plist.ProgramArguments[0] = other.app;
  f.state.loaded = `program = ${other.app}\npath = ${f.plistPath}`;
  expect(diagnoseMacDesktopStartup(f.deps)).toMatchObject({ loginEnabled: false, viable: false, supervisor: { app: realpathSync(f.app) } });
});

const loginSupervisionChanges: [string, (f: ReturnType<typeof fixture>) => void][] = [
  ["runtime PID", f => { f.state.pid = 101; }],
  ["supervisor PID", f => { f.state.child = `300 ${f.proxy}`; }],
  ["supervisor app", f => {
    const other = fixture(); f.state.child = `200 ${other.proxy}`; f.state.parent = `1 ${other.app}`;
  }],
  ["foreign parent", f => { f.state.parent = `1 ${f.proxy}`; }],
  ["unreadable process", f => { f.state.fail = "/bin/ps"; }],
];
for (const [name, change] of loginSupervisionChanges) {
  test(`unowned macOS supervision is discarded when ${name} changes during login verification`, () => {
    const f = fixture(); f.state.owner = { kind: "none", revision: 0 };
    const original = f.deps.run; let loginRead = false;
    f.deps.run = (command, args) => {
      if (command === "/usr/bin/plutil") { loginRead = true; change(f); }
      return original(command, args);
    };
    expect(diagnoseMacDesktopStartup(f.deps)).toBeUndefined();
    expect(loginRead).toBe(true);
  });
}

const finalProbeOwnershipChanges: ServiceOwnershipResolution[] = [
  { kind: "owned", revision: 1, ownership: { owner: "cli", installId: "installation-a", consentGeneration: 1 } },
  { kind: "owned", revision: 1, ownership: { owner: "desktop", installId: "installation-a", consentGeneration: 1 } },
  { kind: "unknown", reason: "unreadable" },
  { kind: "none", revision: 1 },
];
for (const owner of finalProbeOwnershipChanges) {
  const name = owner.kind === "owned" ? owner.ownership.owner : owner.kind;
  test(`unowned macOS supervision is discarded when ownership becomes ${name} during the final probe`, () => {
    const f = fixture(); f.state.owner = { kind: "none", revision: 0 };
    const original = f.deps.run; let psReads = 0;
    f.deps.run = (command, args) => {
      if (command === "/bin/ps" && ++psReads === 5) f.state.owner = owner;
      return original(command, args);
    };
    const desktop = diagnoseMacDesktopStartup(f.deps);
    expect(psReads).toBeGreaterThanOrEqual(5);
    expect(desktop).toBeUndefined();
  });
}

test("unowned foreign parent, absent runtime and changing snapshots never receive supervision credit", () => {
  const f = fixture(); f.state.owner = { kind: "none", revision: 0 }; f.state.parent = `1 ${f.proxy}`;
  expect(inspectDesktopSupervision(f.deps)).toEqual({ kind: "none" });
  expect(diagnoseMacDesktopStartup(f.deps)).toBeUndefined();
  f.state.pid = null;
  expect(inspectDesktopSupervision(f.deps)).toEqual({ kind: "none" });
  expect(diagnoseMacDesktopStartup(f.deps)).toBeUndefined();
  const changed = fixture(); changed.state.owner = { kind: "none", revision: 0 }; changed.state.changedPid = true;
  expect(inspectDesktopSupervision(changed.deps)).toEqual({ kind: "unknown", reason: "snapshot-changed", desktopSeen: true });
  const startup = fixture(); startup.state.owner = { kind: "none", revision: 0 }; startup.state.changedPid = true;
  expect(diagnoseMacDesktopStartup(startup.deps)).toBeUndefined();
});

test("macOS rereads both child and parent identity, including the parent PID", () => {
  const f = fixture(); const original = f.deps.run; let psReads = 0;
  const run = (command: string, args: string[]) => {
    if (command === "/bin/ps" && ++psReads === 4) return `2 ${f.app}`;
    return original(command, args);
  };
  expect(inspectDesktopSupervision({ ...f.deps, run })).toEqual({ kind: "unknown", reason: "snapshot-changed", desktopSeen: true });
  expect(psReads).toBe(4);
});

test("any disagreement between target, pid file and runtime-port pid is unknown", () => {
  for (const [targetPid, portPid] of [[101, null], [100, 101], [101, 101]] as const) {
    const f = fixture();
    expect(inspectDesktopSupervision({ ...f.deps, targetPid, readRuntimePortPid: () => portPid })).toEqual({
      kind: "unknown", reason: "pid-mismatch", desktopSeen: false,
    });
  }
  const f = fixture(); f.state.owner = { kind: "none", revision: 0 };
  expect(diagnoseMacDesktopStartup({ ...f.deps, readRuntimePortPid: () => 101 })).toBeUndefined();
  expect(inspectDesktopSupervision({ ...f.deps, targetPid: 100, readRuntimePortPid: () => 100 })).toMatchObject({ kind: "desktop" });
});

test("unsupported platforms never probe; thrown ps or PID readers produce bounded unknown evidence", () => {
  const f = fixture(); f.state.fail = "/bin/ps";
  expect(inspectDesktopSupervision(f.deps)).toEqual({ kind: "unknown", reason: "probe-failed", desktopSeen: false });
  expect(inspectDesktopSupervision({ ...f.deps, readPid: () => { throw new Error("private contents"); } })).toEqual({
    kind: "unknown", reason: "probe-failed", desktopSeen: false,
  });
  for (const platform of ["win32", "freebsd"] as const) {
    expect(inspectDesktopSupervision({ platform, readPid: () => { throw new Error("must not probe"); } })).toEqual({ kind: "unsupported" });
  }
});

test("partially observed Desktop evidence fails closed when its sibling or permissions are invalid", () => {
  const f = fixture(); f.state.child = `200 ${f.app}`;
  expect(inspectDesktopSupervision(f.deps)).toEqual({ kind: "unknown", reason: "proxy-mismatch", desktopSeen: true });
  f.state.child = `200 ${f.proxy}`; chmodSync(f.proxy, 0o600);
  // Windows fixtures cannot express POSIX execute-bit denial.
  if (process.platform !== "win32") {
    expect(inspectDesktopSupervision(f.deps)).toEqual({ kind: "unknown", reason: "probe-failed", desktopSeen: true });
  }
});

test("malformed ps output cannot clear a supervision latch as positive none evidence", () => {
  const f = fixture(); f.state.child = "unparseable process row";
  expect(inspectDesktopSupervision(f.deps)).toEqual({ kind: "unknown", reason: "probe-failed", desktopSeen: false });
  f.state.child = `200 ${f.proxy}`; f.state.parent = "unparseable parent row";
  expect(inspectDesktopSupervision(f.deps)).toEqual({ kind: "unknown", reason: "probe-failed", desktopSeen: false });
});

test("a supervision latch only clears a Desktop veto on positive none evidence", () => {
  const desktop: SupervisionEvidence = { kind: "desktop", runtimePid: 100, supervisorPid: 200, app: "/app", proxy: "/ocx" };
  const latch = createSupervisionLatch();
  expect(latch.observe({ kind: "unknown", reason: "probe-failed", desktopSeen: false })).toBe(false);
  expect(latch.observe(desktop)).toBe(true);
  expect(latch.observe({ kind: "unknown", reason: "probe-failed", desktopSeen: false })).toBe(true);
  expect(latch.observe({ kind: "unsupported" })).toBe(true);
  expect(latch.observe({ kind: "none" })).toBe(false);
  expect(latch.observe({ kind: "unknown", reason: "snapshot-changed", desktopSeen: true })).toBe(true);
  expect(latch.observe({ kind: "none" })).toBe(false);
  expect(latch.observe(desktop)).toBe(true);
  expect(latch.observe({ kind: "none" })).toBe(false);
});

test("viability requires ownership or supervision, login and a running runtime", () => {
  const supervisor = { supervisorPid: 200, runtimePid: 100, app: "/app" };
  expect(deriveDesktopStartup({ owned: false, loginEnabled: true, running: true }).viable).toBe(false);
  expect(deriveDesktopStartup({ owned: false, loginEnabled: true, running: true, supervisor }).viable).toBe(true);
  expect(deriveDesktopStartup({ owned: false, loginEnabled: false, running: true, supervisor }).viable).toBe(false);
  expect(deriveDesktopStartup({ owned: false, loginEnabled: true, running: false, supervisor }).viable).toBe(false);
});

test("Node-safe pid paths match config paths, including custom-home trimming and tilde expansion", () => {
  const previous = process.env.OPENCODEX_HOME;
  try {
    for (const raw of [undefined, " ", "~", "~/test-supervision-home", "~\\test-supervision-home", "  ./test-supervision-home  "]) {
      if (raw === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = raw;
      expect(desktopSupervisionPaths()).toEqual({ pid: getPidPath(), runtimePort: getRuntimePortPath() });
    }
  } finally {
    if (previous === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previous;
  }
});

test("default readers correlate pid files and project only pid from runtime-port JSON", () => {
  const f = fixture(); const previous = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = f.deps.home;
  try {
    writeFileSync(join(f.deps.home, "ocx.pid"), "100\n");
    writeFileSync(join(f.deps.home, "runtime-port.json"), JSON.stringify({ pid: 100, attestationSecret: "fixture-private" }));
    const evidence = inspectDesktopSupervision({ platform: "darwin", run: f.deps.run });
    expect(evidence).toEqual({ kind: "desktop", runtimePid: 100, supervisorPid: 200, app: realpathSync(f.app), proxy: realpathSync(f.proxy) });
    expect(JSON.stringify(evidence)).not.toContain("fixture-private");
    writeFileSync(join(f.deps.home, "runtime-port.json"), '{"pid":101}');
    expect(inspectDesktopSupervision({ platform: "darwin", run: f.deps.run })).toEqual({ kind: "unknown", reason: "pid-mismatch", desktopSeen: false });
  } finally {
    if (previous === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previous;
  }
});
