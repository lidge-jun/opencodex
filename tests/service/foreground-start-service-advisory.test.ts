import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { startForegroundAdvisory } from "../../src/service/foreground-advisory-process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { installIsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeAfterBackgroundWork } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";
import { describe, expect, test } from "bun:test";
import { deriveLaunchdServiceDiagnostic, foregroundStartServiceAdvisoryLines, warnForegroundStartService } from "../../src/service/diagnostics";
import type { ServiceDiagnostic } from "../../src/service/diagnostics";

const diagnostic = (overrides: Partial<ServiceDiagnostic> = {}): ServiceDiagnostic => ({
  supported: true,
  installed: true,
  enabled: false,
  running: false,
  viable: false,
  startable: true,
  stale: false,
  conflict: false,
  backend: "launchd",
  summary: "installed, not loaded (launchd; ok)",
  confirmedStopped: true,
  ...overrides,
});

describe("foregroundStartServiceAdvisoryLines", () => {
  test("advises when the managed service is installed but not serving", () => {
    const lines = foregroundStartServiceAdvisoryLines(diagnostic());
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("not loaded");
    expect(lines[0]).toContain("installed, not loaded");
    expect(lines[1]).toContain("'ocx service repair'");
  });

  test("stays silent when the service is serving", () => {
    const service = diagnostic({ running: true, enabled: true, viable: true, summary: "installed and loaded (launchd; ok)" });
    expect(foregroundStartServiceAdvisoryLines(service)).toEqual([]);
  });

  test("stays silent when no service is installed", () => {
    const service = diagnostic({ installed: false, startable: false, backend: null, summary: "not installed (launchd; ok)" });
    expect(foregroundStartServiceAdvisoryLines(service)).toEqual([]);
  });

  test("stays silent when another manager holds a conflict", () => {
    const service = diagnostic({ conflict: true, summary: "conflicting manager (launchd; ok)" });
    expect(foregroundStartServiceAdvisoryLines(service)).toEqual([]);
  });

  test("stays silent on unsupported platforms", () => {
    const service = diagnostic({ supported: false, startable: false, summary: "unsupported on freebsd" });
    expect(foregroundStartServiceAdvisoryLines(service)).toEqual([]);
  });

  test("advises on a stale registration that is not serving", () => {
    const service = diagnostic({ stale: true, startable: false, summary: "installed, but stale (launchd; baked paths moved)" });
    const lines = foregroundStartServiceAdvisoryLines(service);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("'ocx service repair'");
  });

  test("does not treat launchd unknown as stopped, whether or not paths are stale", () => {
    for (const stale of [false, true]) {
      const result = deriveLaunchdServiceDiagnostic({
        installed: true, stale, load: { state: "unknown" }, diagnostics: "fixture",
      });
      const lines = foregroundStartServiceAdvisoryLines(result).join("\n");
      expect(lines).toContain("Could not confirm");
      expect(lines).toContain("ocx status");
      expect(lines.includes("ocx service repair")).toBe(false);
    }
  });

  test("derives confirmation from verified launchd not-loaded, not summary text", () => {
    const result = deriveLaunchdServiceDiagnostic({
      installed: true, stale: false, load: { state: "not-loaded" }, diagnostics: "fixture",
    });
    expect(foregroundStartServiceAdvisoryLines({ ...result, summary: "changed wording" })).toHaveLength(2);
  });

  test("keeps status guidance across unknown and non-launchd backends without copying repair hints", () => {
    for (const backend of ["systemd", "native", "scheduler", null] as const) {
      const lines = foregroundStartServiceAdvisoryLines(diagnostic({
        backend, confirmedStopped: undefined, summary: "stale assets — run ocx service repair",
      })).join("\n");
      expect(lines).toContain("Could not confirm");
      expect(lines).toContain("ocx status");
      expect(lines.includes("ocx service repair")).toBe(false);
    }
  });

  test("probe or warning exceptions cannot escape the advisory", () => {
    const fail = (): never => { throw new Error("fixture"); };
    expect(() => warnForegroundStartService(fail, fail)).not.toThrow();
    expect(() => warnForegroundStartService(() => diagnostic(), fail)).not.toThrow();
  });
});

test("foreground advisory is wired after readiness initialization and uses the final sibling decision", () => {
  const cli = readFileSync(repoPath("src/cli/index.ts"), "utf8");
  const start = cli.slice(cli.indexOf("async function handleStart("), cli.indexOf("function detachedStartEnvironment("));
  const probe = "startForegroundAdvisory(line =>";
  const probes = start.split(probe);
  expect(probes).toHaveLength(2);
  const beforeProbe = probes[0]!;
  expect(beforeProbe).toContain("await bindAndPublishStartOwnership(");
  expect(beforeProbe).toContain("await reconcileClientStartupBeforeReady(");
  expect(beforeProbe).toContain('console.log("Client startup work complete.")');
  expect(beforeProbe.slice(beforeProbe.lastIndexOf('console.log("Client startup work complete.")'))).toContain(
    "!cleaned && !shuttingDown && !siblingStart && !owner.live && !supervisedServiceChild",
  );
});

function fakeProbe(body: string) {
  return spawn(process.execPath, ["-e", body], {
    detached: process.platform !== "win32", stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
  });
}

test("the listening proxy can answer a request while the advisory child is still probing", async () => {
  const previousHome = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-advisory-"));
  const codexHome = installIsolatedCodexHome("ocx-advisory-codex-");
  process.env.OPENCODEX_HOME = home;
  let server: ReturnType<typeof startServer> | undefined;
  const warnings: string[] = [];
  let child: ChildProcess | undefined;
  let cancel: (() => void) | undefined;
  try {
    saveConfig({
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "mock",
      providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:9/v1", allowPrivateNetwork: true, liveModels: false, models: ["m"] } },
      clientIntegrations: { codex: false },
      webSearchSidecar: { enabled: false },
    });
    server = startServer(0);
    cancel = startForegroundAdvisory(line => warnings.push(line), {
      launch: () => (child = fakeProbe("console.log('pending'); for (;;) {}")),
      timeoutMs: 4_000,
    });
    expect(child).toBeDefined();
    const ready = new AbortController();
    const deadline = setTimeout(() => ready.abort(), 2_000);
    try {
      await Promise.race([
        once(child!.stdout!, "data", { signal: ready.signal }),
        once(child!, "close", { signal: ready.signal }).then(() => { throw new Error("probe exited before starting"); }),
      ]);
    } finally {
      clearTimeout(deadline);
      ready.abort();
    }
    const response = await fetch(new URL("/healthz", server.url), { signal: AbortSignal.timeout(1_500) });
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("status");
    expect(child!.exitCode).toBeNull();
    expect(child!.signalCode).toBeNull();
    expect(warnings).toEqual([]);
  } finally {
    const exited = child && child.exitCode === null && child.signalCode === null ? once(child, "close") : undefined;
    cancel?.();
    try { await server?.stop(true); await exited; } finally {
      codexHome.restore();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeAfterBackgroundWork(home);
    }
  }
});

test("a completed probe publishes its advisory; a timed-out probe is stopped silently", async () => {
  const warnings: string[] = [];
  let child!: ChildProcess;
  const onWarning = (line: string) => warnings.push(line);
  const cancel = startForegroundAdvisory(onWarning, {
    launch: () => (child = fakeProbe('console.log(JSON.stringify(["status guidance"]))')),
  });
  try {
    await once(child, "close");
    expect(warnings).toEqual(["status guidance"]);
  } finally { cancel(); }

  const cancelSlow = startForegroundAdvisory(onWarning, {
    launch: () => (child = fakeProbe('setTimeout(() => console.log(JSON.stringify(["too late"])), 2000)')),
    timeoutMs: 100,
  });
  try {
    const [code] = await once(child, "close");
    expect(code).not.toBe(0);
    expect(warnings).toEqual(["status guidance"]);
  } finally { cancelSlow(); }
});
