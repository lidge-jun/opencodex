import { expect, test } from "bun:test";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyOrchestratedOutcome, type OutcomeInput } from "../../src/update/orchestrated-outcome.mjs";
import { verifyOrchestratedInstall } from "../../src/update/orchestrated-tree.mjs";

const base: OutcomeInput = {
  fromVersion: "2.0.0", toVersion: "2.1.0", installer: "npm", childExited: true,
  childExitCode: 1, outcome: { phase: "preflight" }, previousVerified: true,
  targetVerified: false, runtimeHealthy: true, restarted: false,
};

test("exit classification requires confirmed termination and independently verified active state", () => {
  expect(classifyOrchestratedOutcome({ ...base, outcome: { phase: "refused", error: "plan-changed" } })).toMatchObject({ exitCode: 10, result: { applied: false, error: "plan-changed", rolledBack: false } });
  expect(classifyOrchestratedOutcome(base)).toMatchObject({ exitCode: 11, result: { applied: false, rolledBack: false } });
  expect(classifyOrchestratedOutcome({ ...base, outcome: { phase: "failed", rollbackPerformed: true } })).toMatchObject({ exitCode: 11, result: { rolledBack: true } });
  expect(classifyOrchestratedOutcome({ ...base, outcome: { phase: "failed", rollbackPerformed: false } })).toMatchObject({ exitCode: 11, result: { rolledBack: false } });
  expect(classifyOrchestratedOutcome({ ...base, previousVerified: false })).toMatchObject({ exitCode: 12 });
  expect(classifyOrchestratedOutcome({ ...base, childExited: false })).toMatchObject({ exitCode: 12 });
  expect(classifyOrchestratedOutcome({ ...base, outcome: null })).toMatchObject({ exitCode: 12 });
  expect(classifyOrchestratedOutcome({ ...base, outcome: { phase: "overrun" } })).toMatchObject({ exitCode: 12 });
  expect(classifyOrchestratedOutcome({ ...base, childExitCode: 0, outcome: { phase: "installed" }, targetVerified: true })).toMatchObject({ exitCode: 0, result: { applied: true, healthy: true } });
  expect(classifyOrchestratedOutcome({ ...base, childExitCode: 0, outcome: { phase: "installed" }, targetVerified: true, runtimeHealthy: false })).toMatchObject({ exitCode: 12, result: { applied: true, healthy: false, error: "runtime-unhealthy" } });
  expect(classifyOrchestratedOutcome({ ...base, childExitCode: 0, outcome: { phase: "installed" }, targetVerified: false })).toMatchObject({ exitCode: 12, result: { applied: false, error: "install-unverified" } });
});

test("passive install verification rejects a damaged tree and permits a retained backup", () => {
  const parent = mkdtempSync(join(tmpdir(), "ocx-update-tree-")), root = join(parent, "package");
  try {
    for (const dir of ["bin", "src/cli", "node_modules/bun/bin", "node_modules/zod"]) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2.1.0", dependencies: { bun: "1", zod: "1" } }));
    writeFileSync(join(root, "bin/ocx.mjs"), "x".repeat(1024));
    writeFileSync(join(root, "src/cli/index.ts"), "export {};\n");
    writeFileSync(join(root, "node_modules/bun/package.json"), "{}");
    writeFileSync(join(root, "node_modules/zod/package.json"), "{}");
    const bun = join(root, "node_modules/bun/bin/bun");
    closeSync(openSync(bun, "w")); truncateSync(bun, 10 * 1024 * 1024);
    mkdirSync(join(parent, ".ocx-backup-retained"));
    expect(verifyOrchestratedInstall(root, "2.1.0", "npm")).toBe(true);
    truncateSync(bun, 10);
    expect(verifyOrchestratedInstall(root, "2.1.0", "npm")).toBe(false);
    truncateSync(bun, 10 * 1024 * 1024);
    rmSync(join(root, "src/cli/index.ts"));
    expect(verifyOrchestratedInstall(root, "2.1.0", "npm")).toBe(false);
    writeFileSync(join(root, "src/cli/index.ts"), "export {};\n");
    rmSync(join(root, "node_modules/zod/package.json"));
    expect(verifyOrchestratedInstall(root, "2.1.0", "npm")).toBe(false);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
