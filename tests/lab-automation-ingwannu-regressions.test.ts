import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OcxConfig } from "../src/types";
import { defaultLabAutomationPolicyV1 } from "../src/lab/automation/policy";
import * as persistence from "../src/lab/automation/persistence";
import {
  loadLabAutomationConfig,
  saveLabAutomationConfig,
  setLabAutomationConfigCommitFaultForTests,
} from "../src/lab/automation/config-persistence";
import {
  isLabAutomationSchedulerRunning,
  resetLabAutomationSchedulerStateForTests,
  runLabAutomationTick,
  setLabAutomationDispatchDeps,
  startLabAutomationScheduler,
} from "../src/lab/automation/orchestrator";
import {
  acquireServerResourceOwner,
  resetServerResourceOwnershipForTests,
} from "../src/lib/server-resource-ownership";

const HOMES: string[] = [];

function tempHome(): string {
  const dir = join(tmpdir(), `ocx-lab-ingwannu-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  HOMES.push(dir);
  return dir;
}

function emptyConfig(): OcxConfig {
  return { providers: {} } as OcxConfig;
}

afterEach(() => {
  setLabAutomationConfigCommitFaultForTests(null);
  resetServerResourceOwnershipForTests();
  resetLabAutomationSchedulerStateForTests();
  for (const dir of HOMES.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CL-08 Ingwannu regressions", () => {
  test("same-root successor survives predecessor server-owner release", async () => {
    const home = tempHome();
    let firstLoads = 0;
    let secondLoads = 0;

    const firstOwner = acquireServerResourceOwner();
    setLabAutomationDispatchDeps({
      configDir: home,
      loadConfig: () => {
        firstLoads += 1;
        return emptyConfig();
      },
    });
    startLabAutomationScheduler(home);
    expect(isLabAutomationSchedulerRunning(home)).toBe(true);

    const secondOwner = acquireServerResourceOwner();
    setLabAutomationDispatchDeps({
      configDir: home,
      loadConfig: () => {
        secondLoads += 1;
        return emptyConfig();
      },
    });
    startLabAutomationScheduler(home);

    firstOwner.release();
    expect(isLabAutomationSchedulerRunning(home)).toBe(true);

    await runLabAutomationTick(home);
    expect(firstLoads).toBe(0);
    expect(secondLoads).toBeGreaterThan(0);

    secondOwner.release();
    expect(isLabAutomationSchedulerRunning(home)).toBe(false);
  });

  test("failed combined automation config commit leaves the prior generation effective", async () => {
    const home = tempHome();
    const initialPolicy = {
      ...defaultLabAutomationPolicyV1(),
      enabled: true,
      layers: {
        protocolConformance: false,
        liveRouteCompatibility: true,
        taskEffectiveness: false,
      },
    };
    const initialRoutes = persistence.defaultLabAutomationRoutesV1();
    saveLabAutomationConfig(initialPolicy, initialRoutes, home);

    const nextPolicy = {
      ...initialPolicy,
      failureCooldownMs: initialPolicy.failureCooldownMs + 1,
    };
    const nextRoutes = {
      schemaVersion: 1 as const,
      routes: [{ providerName: "provider-new", modelId: "model-new" }],
    };

    setLabAutomationConfigCommitFaultForTests("before_publish");
    expect(() => saveLabAutomationConfig(nextPolicy, nextRoutes, home)).toThrow();
    setLabAutomationConfigCommitFaultForTests(null);

    const effective = loadLabAutomationConfig(home);
    expect(effective.policy).toEqual(initialPolicy);
    expect(effective.routes).toEqual(initialRoutes);

    await runLabAutomationTick(home);
    expect(persistence.loadLabAutomationState(home).runs).toHaveLength(0);
  });

  test("CL-08 plan has no trailing whitespace", () => {
    const text = readFileSync(
      join(import.meta.dir, "..", "devlog", "_fin", "260807_compatibility_lab", "008_cl08_automation.md"),
      "utf8",
    );
    const offenders = text
      .split("\n")
      .map((line, index) => ({ line, lineNumber: index + 1 }))
      .filter(({ line }) => /[ \t]+$/.test(line));
    expect(offenders).toEqual([]);
  });
});
