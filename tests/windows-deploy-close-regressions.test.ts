import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Source-contract regressions for the final fixes that let devlog
// 260702_windows-deploy-stability close: the ocx.cmd shell-less restart (A), F9 systemd no-DBUS
// SSH detection (E), and the F4 explicit-localhost bind symmetry (D). These files run top-level or
// platform-gated logic, so guard the invariants at the source level (repo convention — see
// ocx-launcher-source.test.ts / service.test.ts).
const read = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf8");

describe("update-job restart avoids the shell-less .cmd EINVAL (Windows, bun/source)", () => {
  const src = read("src/update/job.ts");
  test("no ocx.cmd shim is spawned for restart", () => {
    expect(src).not.toContain('"ocx.cmd"');
    expect(src).not.toMatch(/function ocxBin/);
  });
  test("bun/source restart uses the runtime executable + launcher (a real .exe, no shell)", () => {
    // restartCommand's non-npm branch resolves to process.execPath + the package launcher.
    // Proxy mode may pin --port via startArgs; service mode stays install-only.
    // Service mode now uses svcArgs (which accepts a serviceArgs parameter to preserve the backend).
    expect(src).toMatch(/const bin = process\.execPath;\s*\n\s*const args = svcArgs;/);
    expect(src).toContain('? [launcher, "start", "--port", String(Math.trunc(port))]');
    expect(src).toContain(': [launcher, "start"]');
  });
  test("service update restart bakes OCX_BAKE_PORT so wrappers hard-pin the captured port", () => {
    expect(src).toContain("OCX_BAKE_PORT");
    // Service reinstall still runs (with bake) even when reclaim warns; direct start refuses to hop.
    expect(src).toContain("refusing to hop");
    expect(src).toContain("runtimeTrusted");
    expect(read("src/cli/index.ts")).toContain("allowEphemeralFallback: !hardPin");
    expect(read("src/cli/index.ts")).toContain("preferRetryMs: hardPin ? 5_000 : 750");
    expect(read("src/cli/dispatch.ts")).toContain("Not opening the GUI");
    expect(read("src/server/ports.ts")).toContain("allowEphemeralFallback");
  });
  test("Windows GUI update worker is launched without inheriting the proxy LISTEN socket", () => {
    // Direct spawn() inherits Bun.serve's LISTEN handle → ghost LISTEN with dead parent PID.
    expect(src).toContain("function spawnGuiUpdateWorker");
    expect(src).toContain("Start-Process");
    expect(src).toContain("buildWindowsElevatedArgumentList");
    expect(src).toContain("resolveTrustedWindowsPowerShellExe");
    expect(src).toContain("windowsHide: true");
    expect(src).not.toContain('["-NoProfile", "-NoLogo", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps]');
    expect(src).toContain("spawnWorkerFn: spawnGuiUpdateWorker");
    // Foreign listeners must stay fail-closed; npm rename is covered by ocx identity.
    expect(src).not.toContain("killAnyListenPidOnPort");
    // 260804 #970: this skip is now conditional on the refresh actually re-registering.
    // `service repair` needs no elevation, so skipping it would leave the dashboard
    // update — the common Windows path — with a stale service it could have refreshed.
    expect(src).toContain('process.env.OCX_SERVICE === "1" && refreshRegisters');
    expect(src).toContain('const refreshRegisters = (svcArgs ?? []).includes("install")');
    // Native WinSW installs must stop via stopWinswService, not Task Scheduler /end only.
    expect(src).toContain("readServiceBackend");
    expect(src).toContain("stopWinswService");
    // The wrapper-killer script (and its self-exclusion) moved to the shared
    // lib/windows-service-wrappers so the updater and the service teardown path
    // cannot drift apart again. Follow the invariant to where it lives; the
    // matching rules themselves are covered by windows-service-wrappers.test.ts.
    expect(src).toContain("killWindowsSchedulerWrappers");
    expect(read("src/lib/windows-service-wrappers.ts")).toContain("$_.ProcessId -eq $PID");
    expect(src).toContain("lastChild?.pid && aliveFn(lastChild.pid)");
  });
});

describe("systemd detection tolerates a no-DBUS SSH session (F9)", () => {
  const src = read("src/service.ts");
  test("isSystemd falls back to the per-user runtime dir when the user-bus probe fails", () => {
    expect(src).toContain("function userRuntimeDir()");
    expect(src).toContain("function ensureUserBusEnv()");
    // The version probe passing + a runtime dir existing is enough — not a hard fail on the --user probe.
    expect(src).toMatch(/catch \{ \/\* no user bus in this session \*\/ \}\s*\n\s*return userRuntimeDir\(\) !== null;/);
  });
  test("install ensures the user-bus env before touching systemctl --user", () => {
    expect(src).toMatch(/function installSystemd\(\): void \{\s*\n\s*ensureUserBusEnv\(\);/);
  });
});

describe("server bind canonicalizes explicit localhost but preserves wildcards (F4 symmetry)", () => {
  const src = read("src/server/index.ts");
  test("literal localhost binds to 127.0.0.1; 0.0.0.0/:: exposure is untouched", () => {
    expect(src).toContain("const configuredHost = config.hostname?.trim();");
    expect(src).toContain('!configuredHost || /^localhost$/i.test(configuredHost) ? "127.0.0.1"');
    // Must not blanket-rewrite the PUBLIC bind host — that would break intentional 0.0.0.0
    // exposure, which is the regression this guards.
    //
    // A literal "127.0.0.1" now appears once, for the separate unauthenticated loopback
    // listener (#1102). That one is a second socket whose entire purpose is to be
    // loopback-only, so a bare substring ban would forbid the fix rather than the defect.
    // Pin the assertion to the public serve call instead: it must take bindHost and nothing
    // else.
    expect(src).toContain("server = Bun.serve<WsData>({ ...serveOptions, port: listenPort, hostname: bindHost });");
    expect(src).not.toMatch(/port: listenPort,\s*\n\s*hostname: "127\.0\.0\.1"/);
    expect(src).not.toContain("port: listenPort, hostname: \"127.0.0.1\"");
  });
});
