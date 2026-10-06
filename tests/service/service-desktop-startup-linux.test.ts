import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveStartupHealth, startupHealthSummary } from "../../src/codex/autostart-health";
import { desktopStartupOwnership, diagnoseDesktopStartup, diagnoseLinuxDesktopStartup } from "../../src/service/desktop-startup";
import type { ServiceOwnershipResolution } from "../../src/service/state";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ocx-desktop-startup-linux-"));
  roots.push(home);
  const app = join(home, "usr", "bin", "opencodex-desktop");
  const proxy = join(home, "usr", "bin", "ocx");
  const idPath = join(home, ".config", "com.opencodex.desktop", "install-id");
  const entryPath = join(home, ".config", "autostart", "OpenCodex.desktop");
  for (const path of [app, proxy, idPath]) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, path === idPath ? "installation-a\n" : "fixture");
    chmodSync(path, 0o700);
  }
  mkdirSync(join(entryPath, ".."), { recursive: true });
  const entry = (exec: string, extra = "") => writeFileSync(entryPath,
    `[Desktop Entry]\nType=Application\nVersion=1.0\nName=OpenCodex\nExec=${exec}\nStartupNotify=false\nTerminal=false${extra}`);
  entry(`${app} --autostart`);
  const owner: ServiceOwnershipResolution = { kind: "owned", revision: 1,
    ownership: { owner: "desktop", installId: "installation-a", consentGeneration: 2 } };
  const state = {
    owner, exe: { 100: proxy, 200: app } as Record<number, string>, parent: { 100: 200, 200: 1 } as Record<number, number>,
    pid: 100 as number | null, ownerReads: 0, pidReads: 0, changedPid: false, changedOwner: false,
  };
  const deps = {
    platform: "linux" as const, home, env: {} as NodeJS.ProcessEnv,
    ownership: (): ServiceOwnershipResolution => {
      state.ownerReads++;
      return state.changedOwner && state.ownerReads > 1 ? { kind: "none", revision: 2 } : state.owner;
    },
    readPid: () => { state.pidReads++; return state.changedPid && state.pidReads > 1 ? 101 : state.pid; },
    proc: {
      exe: (pid: number) => { const exe = state.exe[pid]; if (!exe) throw new Error("no such process"); return exe; },
      parent: (pid: number) => { const parent = state.parent[pid]; if (parent === undefined) throw new Error("no such process"); return parent; },
    },
  };
  return { state, deps, idPath, entryPath, entry, proxy, app, home };
}

const healthBase = {
  routingKind: "opencodex-local" as const, platform: "linux" as const,
  autostartEnabled: true, serviceInstalled: true, serviceViable: false,
  serviceEnabled: true, serviceRunning: false, serviceStale: false,
  serviceConflict: false, serviceSupported: true, shimInstalled: false, shimHealthy: false,
};

test("matching install, XDG login entry and the app supervising its sidecar grant desktop protection on Linux", () => {
  const { deps } = fixture();
  const desktop = diagnoseLinuxDesktopStartup(deps);
  expect(desktop).toEqual({ owned: true, loginEnabled: true, running: true, viable: true });
  expect(diagnoseDesktopStartup(deps)).toEqual(desktop);
  const health = deriveStartupHealth({ ...healthBase, desktop });
  expect(health).toMatchObject({ status: "protected", rebootSafe: true, protection: "desktop", recommendedCommand: null });
  expect(startupHealthSummary(health)).toBe("protected by desktop app at login and its proxy supervisor");
});

test("XDG_CONFIG_HOME relocates the install id and login entry", () => {
  const f = fixture();
  const moved = join(f.home, "xdg");
  mkdirSync(join(moved, "com.opencodex.desktop"), { recursive: true });
  mkdirSync(join(moved, "autostart"), { recursive: true });
  writeFileSync(join(moved, "com.opencodex.desktop", "install-id"), "installation-a");
  expect(diagnoseLinuxDesktopStartup({ ...f.deps, env: { XDG_CONFIG_HOME: moved } })).toMatchObject({ owned: true, loginEnabled: false, viable: false });
  writeFileSync(join(moved, "autostart", "OpenCodex.desktop"), `[Desktop Entry]\nType=Application\nExec="${f.app}" --autostart\n`);
  expect(diagnoseLinuxDesktopStartup({ ...f.deps, env: { XDG_CONFIG_HOME: moved } })).toMatchObject({ viable: true });
});

test("failed identity, login entry or process evidence retains the durable desktop claim", () => {
  type F = ReturnType<typeof fixture>;
  const mutations: ((f: F) => void)[] = [
    f => writeFileSync(f.idPath, "different-install"),
    f => rmSync(f.idPath),
    f => rmSync(f.entryPath),
    f => f.entry(`${f.app} --autostart`, "\nHidden=true"),
    f => f.entry(`${f.app} --autostart`, "\nX-GNOME-Autostart-enabled=false"),
    f => f.entry(f.app),
    f => f.entry(`${f.app} --wrong`),
    f => f.entry(`${f.proxy} --autostart`),
    f => f.entry(`opencodex-desktop --autostart`),
    f => { f.state.exe[100] = f.app; },
    f => { f.state.parent[100] = 1; },
    f => { f.state.exe[200] = f.proxy; },
    f => { delete f.state.exe[100]; },
    f => { f.state.pid = null; },
    f => { f.state.changedPid = true; },
    f => { f.state.changedOwner = true; },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    expect(diagnoseLinuxDesktopStartup(f.deps)).toMatchObject({ owned: true, viable: false });
  }
});

test("Linux desktop ownership never recommends the service it superseded", () => {
  const f = fixture();
  expect(desktopStartupOwnership(f.deps)).toEqual({ owned: true, loginEnabled: false, running: false, viable: false });
  f.state.pid = null;
  const health = deriveStartupHealth({ ...healthBase, desktop: diagnoseLinuxDesktopStartup(f.deps) });
  expect(health).toMatchObject({ status: "at-risk", protection: "none", recommendedCommand: null });
  expect(startupHealthSummary(health)).toContain("Start at Login");
  expect(startupHealthSummary(health)).not.toContain("ocx service");
});

test("other platforms and absent, CLI or unknown ownership cannot grant Linux desktop protection", () => {
  const f = fixture();
  expect(diagnoseLinuxDesktopStartup({ ...f.deps, platform: "win32" })).toBeUndefined();
  expect(f.state.ownerReads).toBe(0);
  for (const owner of [
    { kind: "none", revision: 0 }, { kind: "unknown", reason: "unreadable" },
    { kind: "owned", revision: 1, ownership: { owner: "cli", installId: "installation-a", consentGeneration: 1 } },
  ] as ServiceOwnershipResolution[]) {
    f.state.owner = owner;
    expect(diagnoseLinuxDesktopStartup(f.deps)).toBeUndefined();
    expect(f.state.pidReads).toBe(0);
  }
});
