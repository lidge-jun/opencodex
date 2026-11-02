import { expect, test } from "bun:test";
import { classifyOrchestratedOutcome, type OutcomeInput } from "../../src/update/orchestrated-outcome.mjs";

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
