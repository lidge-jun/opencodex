/**
 * A runtime the desktop app spawned hands its restarts to the app instead of spawning past it.
 *
 * Before this, a join into a Child, a memory restart and the recycle after a disconnect each spawned
 * a detached `ocx start` grandchild and exited. The app only recorded its own child's exit, so the
 * replacement was a process it could not see, stop or quit, and one that failed to start left no
 * proxy until somebody relaunched the app. Under the marker the desktop sets on its sidecar
 * (`desktop/src-tauri/src/sidecar.rs`), the runtime marks recycling and exits 75, and the app's
 * supervisor (`desktop/src-tauri/src/supervisor.rs`) starts the replacement itself.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takeRestartHandoffMarkers } from "../../src/cli/restart-handoff";
import {
  LINK_PORT_WAIT_MS,
  PINNED_PREFER_RETRY_MS,
  linkPortWaitMs,
  recycleStandalone,
  standaloneRecycleEnv,
} from "../../src/client/runtime";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import {
  DESKTOP_RESTART_EXIT_CODE,
  DESKTOP_SUPERVISED_ENV,
  DESKTOP_SUPERVISED_PORT_WAIT_MS,
  isDesktopSupervised,
  resetDesktopSupervisionForTests,
  takeDesktopSupervisedMarker,
} from "../../src/lib/system-restart-contract";
import { resetLifecycleDrainStateForTests } from "../../src/server/lifecycle";
import {
  MEMORY_DRAIN_RESTART_MS,
  acceptSystemRestart,
  replacementStartEnvironment,
  setSystemRestartIoForTests,
  type SystemRestartIo,
} from "../../src/server/management/system-restart";
import { desktopSupervisedStopRefusal } from "../../src/server/stop-teardown";
import type { OcxClientConnectionConfig } from "../../src/types";
import { repoPath } from "../helpers/repo-root";

afterEach(() => {
  setSystemRestartIoForTests();
  resetLifecycleDrainStateForTests();
  resetDesktopSupervisionForTests();
});

/** One accepted restart, driven to its terminal step; `deadline` never lets the drain settle. */
async function restartUnder(io: Partial<SystemRestartIo>, deadline: boolean): Promise<string[]> {
  const calls: string[] = [];
  let scheduled: (() => void | Promise<void>) | null = null;
  let fireDeadline: (() => void) | null = null;
  let now = 1_000;
  acceptSystemRestart({
    isDraining: () => false,
    getActiveTurnCount: () => 0,
    isSupervisedServiceChild: () => false,
    listenPort: () => 10123,
    schedule: (fn) => { scheduled = fn; },
    scheduleDeadline: (fn) => { fireDeadline = fn; return () => {}; },
    now: () => now,
    setDraining: () => { calls.push("latched"); },
    drainAndShutdown: deadline
      ? () => { calls.push("drain"); return new Promise<void>(() => {}); }
      : async () => { calls.push("drain"); },
    stopListener: () => { calls.push("stop"); },
    spawnStart: (port) => { calls.push(`start:${port}`); },
    markRecycling: () => { calls.push("recycle"); },
    exitProcess: (code) => { calls.push(`exit:${code}`); },
    ...io,
  });
  const running = scheduled!();
  if (deadline) {
    await Promise.resolve();
    await Promise.resolve();
    now += MEMORY_DRAIN_RESTART_MS;
    fireDeadline?.();
  }
  await running;
  return calls;
}

describe("a desktop-supervised drain-and-restart exits to the app", () => {
  test("the completed drain marks recycling and exits 75 without spawning a replacement", async () => {
    const calls = await restartUnder({ isDesktopSupervised: () => true }, false);
    expect(calls).toEqual(["latched", "drain", "recycle", `exit:${DESKTOP_RESTART_EXIT_CODE}`]);
    expect(DESKTOP_RESTART_EXIT_CODE).toBe(75);
  });

  test("the deadline path does the same instead of a parent-exit handoff", async () => {
    const calls = await restartUnder({ isDesktopSupervised: () => true }, true);
    expect(calls).toEqual(["latched", "drain", "recycle", "exit:75"]);
  });

  test("the app that spawned the process wins over a service marker", async () => {
    const calls = await restartUnder({ isDesktopSupervised: () => true, isSupervisedServiceChild: () => true }, false);
    expect(calls).toEqual(["latched", "drain", "recycle", "exit:75"]);
  });

  test("without the app the detached replacement is unchanged", async () => {
    const calls = await restartUnder({ isDesktopSupervised: () => false }, false);
    expect(calls).toEqual(["latched", "drain", "stop", "start:10123", "recycle", "exit:0"]);
  });

  test("the marker handleStart took is what the default check reads", async () => {
    // The test runner's parent is alive, so a marker taken against it reads as supervised.
    const env: Record<string, string | undefined> = { [DESKTOP_SUPERVISED_ENV]: "1" };
    expect(takeDesktopSupervisedMarker(env)).toBe(true);
    expect(env[DESKTOP_SUPERVISED_ENV]).toBeUndefined();
    const calls = await restartUnder({}, false);
    expect(calls).toEqual(["latched", "drain", "recycle", "exit:75"]);
  });
});

describe("the supervision marker", () => {
  test("is consumed with the other start markers and honored only against a live parent", () => {
    const env: Record<string, string | undefined> = { [DESKTOP_SUPERVISED_ENV]: "1", PATH: "/usr/bin" };
    takeRestartHandoffMarkers(env, { path: join(tmpdir(), "unused-handoff.log") });
    expect(env).toEqual({ PATH: "/usr/bin" });
    expect(isDesktopSupervised()).toBe(true);

    expect(takeDesktopSupervisedMarker({ [DESKTOP_SUPERVISED_ENV]: "1" }, 4242)).toBe(true);
    expect(isDesktopSupervised({ parentPid: () => 4242, isAlive: () => true })).toBe(true);
    // A crashed app re-parents the runtime (POSIX) or leaves its parent dead (Windows): the
    // restart falls back to the detached replacement rather than exiting into nothing.
    expect(isDesktopSupervised({ parentPid: () => 1, isAlive: () => true })).toBe(false);
    expect(isDesktopSupervised({ parentPid: () => 4242, isAlive: () => false })).toBe(false);

    for (const raw of [undefined, "", "0", "true", " 2"]) {
      expect(takeDesktopSupervisedMarker({ [DESKTOP_SUPERVISED_ENV]: raw }, 4242)).toBe(false);
      expect(isDesktopSupervised({ parentPid: () => 4242, isAlive: () => true })).toBe(false);
    }
    // No parent to be supervised by: init, or nothing at all.
    expect(takeDesktopSupervisedMarker({ [DESKTOP_SUPERVISED_ENV]: "1" }, 1)).toBe(false);
  });

  test("never reaches a detached replacement's environment", () => {
    const prev = process.env[DESKTOP_SUPERVISED_ENV];
    process.env[DESKTOP_SUPERVISED_ENV] = "1";
    try {
      expect(replacementStartEnvironment(true)[DESKTOP_SUPERVISED_ENV]).toBeUndefined();
      expect(replacementStartEnvironment(false)[DESKTOP_SUPERVISED_ENV]).toBeUndefined();
      const recycled = standaloneRecycleEnv(
        { [DESKTOP_SUPERVISED_ENV]: "1", OPENCODEX_API_AUTH_TOKEN: "operator-token", PATH: "/usr/bin" },
        serviceApiTokenFingerprint("disconnected-hub-token"),
      );
      expect(recycled).toEqual({ OPENCODEX_API_AUTH_TOKEN: "operator-token", PATH: "/usr/bin" });
    } finally {
      if (prev === undefined) delete process.env[DESKTOP_SUPERVISED_ENV];
      else process.env[DESKTOP_SUPERVISED_ENV] = prev;
    }
  });
});

describe("the client runtime under the desktop app", () => {
  test("the recycle back to standalone exits 75 and spawns nothing", async () => {
    const calls: string[] = [];
    await recycleStandalone(serviceApiTokenFingerprint("disconnected-hub-token"), {
      configuredPort: () => 10456,
      isDesktopSupervised: () => true,
      spawnReplacement: async () => { calls.push("spawn"); },
      exitProcess: code => { calls.push(`exit:${code}`); },
    });
    expect(calls).toEqual(["exit:75"]);
  });

  test("link mode waits for its port inside the app's 30-second startup deadline", () => {
    const startup = readFileSync(repoPath("desktop/src-tauri/src/startup.rs"), "utf8");
    const deadline = Number(/pub const DEADLINE: Duration = Duration::from_secs\((\d+)\);/.exec(startup)?.[1]);
    expect(deadline).toBe(30);
    expect(linkPortWaitMs(true)).toBe(DESKTOP_SUPERVISED_PORT_WAIT_MS);
    // The reclaim wait and the prefer-retry after it, with room left for the spawn and the health wait.
    expect(DESKTOP_SUPERVISED_PORT_WAIT_MS + PINNED_PREFER_RETRY_MS).toBeLessThanOrEqual(25_000);
    expect(linkPortWaitMs(false)).toBe(LINK_PORT_WAIT_MS);
  });

  test("publishes an attestation secret, so the app can authenticate the runtime it started", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-client-attest-"));
    const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = holder.port!;
    holder.stop(true);
    const previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    try {
      const token = `ocx_data_${"c".repeat(40)}`;
      const client: OcxClientConnectionConfig = {
        serverUrl: "http://127.0.0.1:34567",
        managementUrl: "http://127.0.0.1:34567",
        managementTransport: "direct",
        transport: "link",
        link: { tunnelPort: 34567, linkId: "lnk_0123456789abcdef" },
        selectedClients: ["codex"],
        tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
        apiKeyId: "key-1",
        tokenFingerprint: serviceApiTokenFingerprint(token),
        protocolVersion: 1,
        connectedAt: "2026-09-25T00:00:00.000Z",
      };
      const config = getDefaultConfig();
      config.port = port;
      config.runtimeRole = "client";
      config.client = client;
      saveConfig(config);
      // A real start, in its own process: it installs signal handlers and crash guards that must
      // not leak into this test runner.
      const script = [
        `const { startClientRuntime } = await import(${JSON.stringify(repoPath("src/client/runtime.ts"))});`,
        `const { readRuntimePort } = await import(${JSON.stringify(repoPath("src/config/process-state.ts"))});`,
        "await startClientRuntime({ block: false }, { portWaitMs: 5000 });",
        "console.log(JSON.stringify(readRuntimePort(process.pid)));",
        "process.exit(0);",
      ].join("\n");
      const child = Bun.spawn([process.execPath, "-e", script], {
        env: { ...process.env, OPENCODEX_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ exitCode, stderr: exitCode === 0 ? "" : stderr }).toEqual({ exitCode: 0, stderr: "" });
      const lines = stdout.trim().split("\n");
      const record = JSON.parse(lines[lines.length - 1]!) as { port: number; attestationSecret?: string };
      expect(record.port).toBe(port);
      expect(record.attestationSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("the dashboard's Stop under the desktop app", () => {
  test("a dashboard session is refused while the app supervises this process", () => {
    const refusal = desktopSupervisedStopRefusal("gui-session", () => true);
    expect(refusal).toMatchObject({ success: false, code: "desktop_supervised" });
    expect(refusal!.message).toContain("Stop proxy");
    expect(refusal!.message).toContain("Nothing was changed.");
    // `ocx stop` — what the tray's Stop, Quit and an update's drain run — keeps working.
    expect(desktopSupervisedStopRefusal("admin-token", () => true)).toBeNull();
    expect(desktopSupervisedStopRefusal(undefined, () => true)).toBeNull();
    // Outside the desktop app the dashboard's Stop is unchanged.
    expect(desktopSupervisedStopRefusal("gui-session", () => false)).toBeNull();
    // The default reads the marker handleStart took.
    expect(desktopSupervisedStopRefusal("gui-session")).toBeNull();
    takeDesktopSupervisedMarker({ [DESKTOP_SUPERVISED_ENV]: "1" });
    expect(desktopSupervisedStopRefusal("gui-session")?.code).toBe("desktop_supervised");
  });

  test("the route refuses before it touches the service manager or the teardown", () => {
    const source = readFileSync(repoPath("src/server/management-api.ts"), "utf8");
    const from = source.indexOf('url.pathname === "/api/stop"');
    const handler = source.slice(from, source.indexOf("/api/native-main-profiles", from));
    const refusal = handler.indexOf("desktopSupervisedStopRefusal(principal)");
    expect(refusal).toBeGreaterThan(-1);
    expect(handler.slice(refusal, refusal + 200)).toContain("return jsonResponse(desktopRefusal, 409, req, config)");
    for (const later of ["installedServiceRespawnRisk()", "stopServiceIfInstalledDetailed()", "noteExplicitShutdownRequested()", "performStopTeardown(url"]) {
      expect(handler.indexOf(later)).toBeGreaterThan(refusal);
    }
  });
});

describe("the desktop side speaks the same contract", () => {
  test("the sidecar sets the marker and the supervisor restarts on the same exit code", () => {
    const sidecar = readFileSync(repoPath("desktop/src-tauri/src/sidecar.rs"), "utf8");
    expect(/pub const SUPERVISED_ENV: &str = "([A-Z_]+)";/.exec(sidecar)?.[1]).toBe(DESKTOP_SUPERVISED_ENV);
    // Set on the spawned sidecar itself, next to its other environment.
    const start = sidecar.slice(sidecar.indexOf("pub fn start("), sidecar.indexOf("command.spawn()"));
    expect(/\.env\(SUPERVISED_ENV, "1"\)/.test(start)).toBe(true);
    const supervisor = readFileSync(repoPath("desktop/src-tauri/src/supervisor.rs"), "utf8");
    expect(Number(/pub const REQUESTED_RESTART_EXIT_CODE: i32 = (\d+);/.exec(supervisor)?.[1]))
      .toBe(DESKTOP_RESTART_EXIT_CODE);
  });
});
