import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertUpdateRestartHome, readUpdateRestartHome, type UpdateRestartHomeDeps } from "../../src/cli/update-restart-home";
import { runUpdateRestart, standalone, type UpdateRestartIo } from "../../src/cli/update-restart";
import type { UpdateRestartCandidate } from "../../src/cli/update-restart-candidate";
import type { UpdateRestartSupervisionDeps } from "../../src/cli/update-restart-supervision";

const roots: string[] = [];
const saved = { ocx: process.env.OPENCODEX_HOME, codex: process.env.CODEX_HOME };
afterEach(() => {
  if (saved.ocx === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = saved.ocx;
  if (saved.codex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved.codex;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(platform: "darwin" | "linux") {
  const root = mkdtempSync(join(tmpdir(), "ocx-desktop-service-")); roots.push(root);
  const config = join(root, "ocx"), codex = join(root, "codex");
  mkdirSync(config); mkdirSync(codex);
  process.env.OPENCODEX_HOME = config; process.env.CODEX_HOME = codex;
  writeFileSync(join(config, "config.json"), JSON.stringify({ hostname: "127.0.0.1" }));
  const record = join(config, "service-state.json"), definition = join(root, "definition");
  writeFileSync(record, JSON.stringify({ version: 2, backend: "scheduler", codexHome: codex,
    opencodexHome: config, revision: 1, bunPath: "/fixture/bun" }));
  writeFileSync(definition, platform === "darwin"
    ? '<plist version="1.0"><dict><key>Label</key><string>com.opencodex.proxy</string></dict></plist>'
    : '[Unit]\nDescription=fixture\n[Service]\nExecStart=/fixture/ocx start --port 23456\n');
  const supervision: UpdateRestartSupervisionDeps = { platform, now: () => 1000,
    stat: () => ({ isFile: () => true, mode: 0o100755 }),
    run: () => platform === "darwin" ? { status: 113, stdout: "", stderr: "" }
      : { status: 0, stdout: "LoadState=loaded\nActiveState=inactive\nMainPID=0\n", stderr: "" } };
  const homeDeps: UpdateRestartHomeDeps = {
    record: { platform, paths: () => [record], definitionPath: () => definition }, supervision,
  };
  const home = readUpdateRestartHome(homeDeps);
  const target: UpdateRestartCandidate["target"] = {
    pid: 123, port: 23456, hostname: "127.0.0.1", source: "runtime", version: "2.76.0",
  };
  const candidate: UpdateRestartCandidate = { home, target, cliVersion: "2.77.0",
    runtime: { pid: 123, port: 23456, hostname: "127.0.0.1", attestationSecret: "a".repeat(43) } };
  const live = { ...target, pid: 456, version: "2.77.0" };
  const calls = { checks: 0, stopAttempts: 0, stopPosts: 0, spawns: 0, releases: 0 };
  let desktop = false;
  const io: UpdateRestartIo = {
    inspectSupervision: deps => {
      expect(deps?.targetPid).toBe(target.pid);
      return desktop ? { kind: "desktop", runtimePid: target.pid, supervisorPid: 321,
        app: "/fixture/opencodex-desktop", proxy: "/fixture/ocx" } : { kind: "none" };
    },
    now: () => 1000, acquire: () => ({ release: () => { calls.releases++; } }),
    home: () => readUpdateRestartHome(homeDeps),
    checkHome: expected => { calls.checks++; assertUpdateRestartHome(expected, 5000, homeDeps); },
    runtime: () => candidate.runtime,
    standalone: selected => standalone(selected, 5000, {
      platform, expectedHome: home, home: homeDeps, supervision,
      command: () => "bun /fixture/opencodex/src/cli/index.ts start --port 23456", parent: () => "1",
      manager: { verifyPid: pid => pid, expectedCommand: () => "fixture" },
    }),
    runtimeReady: () => true,
    stop: async (_candidate, _deadline, beforeStop) => { calls.stopAttempts++; beforeStop(); calls.stopPosts++; },
    stopped: async () => true,
    start: () => { calls.spawns++; return { pid: live.pid, exitCode: null, signalCode: null }; },
    observe: async () => live, wait: async () => {},
  };
  return { candidate, homeDeps, calls, io, desktopAppears: () => { desktop = true; } };
}

test("same-PID Desktop appearing before final stop revalidation vetoes an unchanged inactive service", async () => {
  for (const platform of ["darwin", "linux"] as const) {
    const s = fixture(platform), stop = s.io.stop;
    s.io.stop = async (...args) => { s.desktopAppears(); await stop(...args); };
    expect(await runUpdateRestart(s.candidate, 5000, s.io)).toEqual({
      ok: false, code: "update_restart_stop_failed", reason: "desktop",
    });
    expect(readUpdateRestartHome(s.homeDeps)).toEqual(s.candidate.home);
    expect(s.calls).toEqual({ checks: 2, stopAttempts: 1, stopPosts: 0, spawns: 0, releases: 1 });
  }
});

test("Desktop present initially vetoes an inactive installed service before any stop", async () => {
  for (const platform of ["darwin", "linux"] as const) {
    const s = fixture(platform); s.desktopAppears();
    expect(await runUpdateRestart(s.candidate, 5000, s.io)).toEqual({
      ok: false, code: "update_restart_eligibility_failed", reason: "desktop",
    });
    expect(readUpdateRestartHome(s.homeDeps)).toEqual(s.candidate.home);
    expect(s.calls).toEqual({ checks: 1, stopAttempts: 0, stopPosts: 0, spawns: 0, releases: 1 });
  }
});

test("an inactive installed service without Desktop still admits one stop and one replacement", async () => {
  for (const platform of ["darwin", "linux"] as const) {
    const s = fixture(platform);
    expect(await runUpdateRestart(s.candidate, 5000, s.io)).toMatchObject({ ok: true, live: { pid: 456 } });
    expect(readUpdateRestartHome(s.homeDeps)).toEqual(s.candidate.home);
    expect(s.calls).toEqual({ checks: 6, stopAttempts: 1, stopPosts: 1, spawns: 1, releases: 1 });
  }
});
