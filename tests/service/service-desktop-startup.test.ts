import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnoseMacDesktopStartup, desktopStartupOwnership } from "../../src/service/desktop-startup";
import type { ServiceOwnershipResolution } from "../../src/service/state";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ocx-desktop-startup-"));
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

test("other platforms and absent, CLI or unknown ownership cannot grant desktop protection", () => {
  const f = fixture();
  expect(diagnoseMacDesktopStartup({ ...f.deps, platform: "linux" })).toBeUndefined();
  expect(f.state.ownerReads).toBe(0);
  for (const owner of [
    { kind: "none", revision: 0 }, { kind: "unknown", reason: "unreadable" },
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
