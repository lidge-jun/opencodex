import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultProbeRunner,
  inspectServiceManagerInstallation,
  type ProbeRunner,
} from "../src/service-manager-probe";
import { inspectNativeCodexOwnership } from "../src/integrations/native/ownership-preflight";

function failedSystemctl(
  spawnErrorCode: string | undefined,
  timedOut = false,
): ProbeRunner {
  return () => ({
    status: null,
    stdout: "",
    stderr: spawnErrorCode ? `spawn systemctl ${spawnErrorCode}` : "spawn systemctl failed",
    timedOut,
    spawnFailed: !timedOut,
    spawnErrorCode,
  });
}

test("Linux reports systemd absent when systemctl is missing and no unit exists", () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-probe-docker-"));

  try {
    expect(inspectServiceManagerInstallation({
      run: failedSystemctl("ENOENT"),
      platform: "linux",
      home,
    })).toEqual({
      kind: "absent",
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the default probe preserves a missing executable's structured error code", () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-probe-runner-"));
  try {
    expect(defaultProbeRunner(join(home, "missing-systemctl"), [])).toMatchObject({
      timedOut: false,
      spawnFailed: true,
      spawnErrorCode: "ENOENT",
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the default probe classifies a spawnSync timeout as a timeout", () => {
  const result = defaultProbeRunner(process.execPath, ["-e", "await Bun.sleep(10_000)"]);
  expect(result.timedOut).toBe(true);
  expect(result.spawnFailed).toBe(false);
});

test.each([
  ["ETIMEDOUT", "ETIMEDOUT", true],
  ["EACCES", "EACCES", false],
  ["missing-code", undefined, false],
] as const)("Linux does not treat a %s systemctl failure as absent", (_label, spawnErrorCode, timedOut) => {
  const home = mkdtempSync(join(tmpdir(), "ocx-probe-failure-"));
  try {
    expect(inspectServiceManagerInstallation({
      run: failedSystemctl(spawnErrorCode, timedOut),
      platform: "linux",
      home,
    }).kind).toBe("unknown");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Linux ownership remains unknown when systemctl cannot be executed", () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-probe-ownership-"));
  const codexHome = join(home, ".codex");
  const opencodexHome = join(home, ".opencodex");
  try {
    const result = inspectNativeCodexOwnership({
      run: failedSystemctl("EACCES"),
      platform: "linux",
      home,
      statePaths: [],
      currentHomes: { codexHome, opencodexHome },
    });
    expect(result.ownership).toBe("unknown");
    expect(result.reason).toContain("EACCES");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a staged unit remains visible when systemctl is missing", () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-probe-staged-"));
  const codexHome = join(home, ".codex");
  const opencodexHome = join(home, ".opencodex");
  const definitionPath = join(home, ".config", "systemd", "user", "opencodex-proxy.service");
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(definitionPath, [
    "[Service]",
    `Environment=\"CODEX_HOME=${codexHome}\"`,
    `Environment=\"OPENCODEX_HOME=${opencodexHome}\"`,
  ].join("\n"));

  try {
    expect(inspectServiceManagerInstallation({
      run: failedSystemctl("ENOENT"),
      platform: "linux",
      home,
    })).toEqual({
      kind: "present",
      claims: [{
        backend: "systemd",
        definitionPath,
        homes: { codexHome, opencodexHome },
        registration: "absent",
      }],
    });

    const ownership = inspectNativeCodexOwnership({
      run: failedSystemctl("ENOENT"),
      platform: "linux",
      home,
      statePaths: [],
      currentHomes: { codexHome, opencodexHome },
    });
    expect(ownership.ownership).toBe("unknown");
    expect(ownership.reason).toContain("no service state file");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an unreadable staged unit is unknown when systemctl is missing", () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-probe-unreadable-"));
  const definitionPath = join(home, ".config", "systemd", "user", "opencodex-proxy.service");
  mkdirSync(definitionPath, { recursive: true });

  try {
    expect(inspectServiceManagerInstallation({
      run: failedSystemctl("ENOENT"),
      platform: "linux",
      home,
    }).kind).toBe("unknown");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
