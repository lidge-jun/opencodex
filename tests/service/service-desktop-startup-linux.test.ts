import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveStartupHealth, startupHealthSummary } from "../../src/codex/autostart-health";
import { desktopStartupOwnership, diagnoseDesktopStartup, diagnoseLinuxDesktopStartup } from "../../src/service/desktop-startup";
import type { ServiceOwnershipResolution } from "../../src/service/state";

// Fixtures use POSIX paths, execute bits and symlinks, and the diagnostic only runs on Linux.
const linuxTest = test.skipIf(process.platform === "win32");
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

linuxTest("matching install, XDG login entry and the app supervising its sidecar grant desktop protection on Linux", () => {
  const { deps } = fixture();
  const desktop = diagnoseLinuxDesktopStartup(deps);
  expect(desktop).toEqual({ owned: true, loginEnabled: true, running: true, viable: true });
  expect(diagnoseDesktopStartup(deps)).toEqual(desktop);
  const health = deriveStartupHealth({ ...healthBase, desktop });
  expect(health).toMatchObject({ status: "protected", rebootSafe: true, protection: "desktop", recommendedCommand: null });
  expect(startupHealthSummary(health)).toBe("protected by desktop app at login and its proxy supervisor");
});

linuxTest("a relocated XDG_CONFIG_HOME is not credited: the HOME-based entry is outside its autostart path", () => {
  const f = fixture();
  const moved = join(f.home, "xdg");
  mkdirSync(join(moved, "com.opencodex.desktop"), { recursive: true });
  writeFileSync(join(moved, "com.opencodex.desktop", "install-id"), "installation-a");
  expect(diagnoseLinuxDesktopStartup({ ...f.deps, env: { XDG_CONFIG_HOME: moved } })).toMatchObject({ viable: false });
  mkdirSync(join(moved, "autostart"), { recursive: true });
  writeFileSync(join(moved, "autostart", "OpenCodex.desktop"), `[Desktop Entry]
Type=Application
Exec=${f.app} --autostart
`);
  expect(diagnoseLinuxDesktopStartup({ ...f.deps, env: { XDG_CONFIG_HOME: moved } })).toMatchObject({ viable: false });
  expect(diagnoseLinuxDesktopStartup({ ...f.deps, env: { XDG_CONFIG_HOME: join(f.home, ".config") } })).toMatchObject({ viable: true });
  expect(diagnoseLinuxDesktopStartup({ ...f.deps, env: { XDG_CONFIG_HOME: `${join(f.home, ".config")}/` } })).toMatchObject({ viable: true });
});

for (const field of ["OnlyShowIn=GNOME;", "NotShowIn=GNOME;", "TryExec=/missing", "OnlyShowIn=", "NotShowIn=", "TryExec="]) {
  linuxTest(`conditional autostart entry is not credited: ${field}`, () => {
    const f = fixture(); f.entry(`${f.app} --autostart`, `\n${field}`);
    expect(diagnoseLinuxDesktopStartup(f.deps)).toMatchObject({ owned: true, loginEnabled: false, viable: false });
  });
}

for (const command of [
  (app: string) => `"${app}" --autostart`,
  (app: string) => `'${app}' --autostart`,
  (app: string) => `${app.replace("/usr/", "/%Z/usr/")} --autostart`,
  (app: string) => `${app.replace("/usr/", "/%f/usr/")} --autostart`,
  (app: string) => `${app.replace("/usr/", "/escaped\\/usr/")} --autostart`,
  (app: string) => `${app.replace("/usr/", "/has space/usr/")} --autostart`,
  (app: string) => `${app} --autostart extra`,
]) {
  linuxTest(`ambiguous Exec is not credited: ${command("/usr/opencodex-desktop")}`, () => {
    const f = fixture();
    // Make the literal path real so rejection tests parsing, not a missing executable.
    const exec = command(f.app);
    const literal = exec.slice(0, exec.indexOf(" --autostart")).replace(/^["']|["']$/g, "");
    mkdirSync(join(literal, ".."), { recursive: true });
    writeFileSync(literal, "fixture"); chmodSync(literal, 0o700);
    if (literal !== f.app) {
      const proxy = join(literal, "..", "ocx");
      writeFileSync(proxy, "fixture"); chmodSync(proxy, 0o700);
      f.state.exe[100] = proxy; f.state.exe[200] = literal;
    }
    f.entry(exec);
    expect(diagnoseLinuxDesktopStartup(f.deps)).toMatchObject({ owned: true, loginEnabled: false, viable: false });
  });
}

linuxTest("an opencodex-desktop symlink to another executable cannot grant protection", () => {
  const f = fixture();
  const target = join(f.home, "usr", "bin", "sh");
  writeFileSync(target, "fixture"); chmodSync(target, 0o700);
  rmSync(f.app); symlinkSync(target, f.app);
  f.state.exe[200] = target;
  expect(diagnoseLinuxDesktopStartup(f.deps)).toMatchObject({ owned: true, loginEnabled: false, viable: false });
});

linuxTest("a desktop symlink uses the ocx beside its resolved executable", () => {
  const f = fixture();
  const alias = join(f.home, "alias", "opencodex-desktop");
  mkdirSync(join(alias, "..")); symlinkSync(f.app, alias); f.entry(`${alias} --autostart`);
  expect(diagnoseLinuxDesktopStartup(f.deps)).toMatchObject({ viable: true });
  const outside = join(f.home, "outside-ocx");
  writeFileSync(outside, "fixture"); chmodSync(outside, 0o700);
  rmSync(f.proxy); symlinkSync(outside, f.proxy); f.state.exe[100] = outside;
  expect(diagnoseLinuxDesktopStartup(f.deps)).toMatchObject({ owned: true, viable: false });
});

linuxTest("AppImage registration cannot credit the executable running inside its mount", () => {
  const f = fixture();
  const image = join(f.home, "OpenCodex.AppImage");
  writeFileSync(image, "fixture"); chmodSync(image, 0o700); f.entry(`${image} --autostart`);
  expect(diagnoseLinuxDesktopStartup(f.deps)).toMatchObject({ owned: true, loginEnabled: false, viable: false });
});

type F = ReturnType<typeof fixture>;
const changes: [string, (f: F) => void][] = [
  ["install-id", f => writeFileSync(f.idPath, "different-install")],
  ["Hidden=true", f => f.entry(`${f.app} --autostart`, "\nHidden=true")],
  ["valid entry contents", f => f.entry(`${f.app} --autostart`, "\n# rewritten")],
  ["desktop executable", f => {
    const target = join(f.home, "replacement", "opencodex-desktop");
    mkdirSync(join(target, "..")); writeFileSync(target, "fixture"); chmodSync(target, 0o700);
    const proxy = join(target, "..", "ocx"); writeFileSync(proxy, "fixture"); chmodSync(proxy, 0o700);
    rmSync(f.app); symlinkSync(target, f.app); f.state.exe[200] = target; f.state.exe[100] = proxy;
  }],
  ["proxy executable", f => {
    const target = join(f.home, "replacement-ocx");
    writeFileSync(target, "fixture"); chmodSync(target, 0o700);
    rmSync(f.proxy); symlinkSync(target, f.proxy); f.state.exe[100] = target;
  }],
  ["executable permission", f => chmodSync(f.app, 0o600)],
  ["proxy permission", f => chmodSync(f.proxy, 0o600)],
  ["PID", f => { f.state.pid = 101; }],
  ["parent relationship", f => { f.state.parent[100] = 300; f.state.exe[300] = f.app; }],
  ["child process executable", f => { f.state.exe[100] = f.app; }],
  ["parent process executable", f => { f.state.exe[200] = f.proxy; }],
  ["ownership", f => { f.state.owner = { kind: "none", revision: 2 }; }],
];
for (const [name, mutate] of changes) {
  linuxTest(`final evidence read fails closed after ${name} changes`, () => {
    const f = fixture();
    const original = f.deps.ownership;
    let changed = false;
    f.deps.ownership = () => {
      const result = original();
      // Change evidence after the first process/PID checks, immediately before the final read.
      if (f.state.ownerReads === 2 && !changed) { changed = true; mutate(f); }
      return result;
    };
    expect(diagnoseLinuxDesktopStartup(f.deps)).toMatchObject({ owned: true, viable: false });
    expect(changed).toBe(true);
  });
}

linuxTest("failed identity, login entry or process evidence retains the durable desktop claim", () => {
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

linuxTest("Linux desktop ownership never recommends the service it superseded", () => {
  const f = fixture();
  expect(desktopStartupOwnership(f.deps)).toEqual({ owned: true, loginEnabled: false, running: false, viable: false });
  f.state.pid = null;
  const health = deriveStartupHealth({ ...healthBase, desktop: diagnoseLinuxDesktopStartup(f.deps) });
  expect(health).toMatchObject({ status: "at-risk", protection: "none", recommendedCommand: null });
  expect(startupHealthSummary(health)).toContain("Start at Login");
  expect(startupHealthSummary(health)).not.toContain("ocx service");
});

linuxTest("other platforms and absent, CLI or unknown ownership cannot grant Linux desktop protection", () => {
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
