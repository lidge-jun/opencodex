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
    expect(src).toContain("reinstalling service with pinned --port");
    expect(src).toContain("runtimeTrusted");
    expect(read("src/cli/index.ts")).toContain("allowEphemeralFallback: !hardPin");
    expect(read("src/cli/index.ts")).toContain("Not opening the GUI");
    expect(read("src/server/ports.ts")).toContain("allowEphemeralFallback");
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
    expect(src).toContain('/^localhost$/i.test(config.hostname ?? "") ? "127.0.0.1"');
    expect(src).toContain("hostname: bindHost,");
    // Must not blanket-rewrite the bind host (that would break intentional 0.0.0.0 exposure).
    expect(src).not.toContain('hostname: "127.0.0.1",');
  });
});
