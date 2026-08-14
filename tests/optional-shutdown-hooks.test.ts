import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setLabAutomationDispatchDeps,
  startLabAutomationScheduler,
  stopLabAutomationScheduler,
  isLabAutomationSchedulerRunning,
} from "../src/lab/automation/orchestrator";
import {
  registerOptionalShutdownHook,
  runOptionalShutdownHooks,
  resetOptionalShutdownHooksForTests,
} from "../src/lib/optional-shutdown-hooks";

describe("optional shutdown hooks", () => {
  beforeEach(() => resetOptionalShutdownHooksForTests());

  test("running with nothing registered is a no-op", () => {
    expect(() => runOptionalShutdownHooks()).not.toThrow();
  });

  test("a registered hook runs once per invocation", () => {
    let calls = 0;
    registerOptionalShutdownHook("subsystem", () => { calls += 1; });
    runOptionalShutdownHooks();
    expect(calls).toBe(1);
    runOptionalShutdownHooks();
    expect(calls).toBe(2);
  });

  test("re-registering the same key replaces instead of accumulating", () => {
    const seen: string[] = [];
    registerOptionalShutdownHook("subsystem", () => seen.push("first"));
    registerOptionalShutdownHook("subsystem", () => seen.push("second"));
    runOptionalShutdownHooks();
    expect(seen).toEqual(["second"]);
  });

  test("distinct keys both run", () => {
    const seen: string[] = [];
    registerOptionalShutdownHook("a", () => seen.push("a"));
    registerOptionalShutdownHook("b", () => seen.push("b"));
    runOptionalShutdownHooks();
    expect(seen.sort()).toEqual(["a", "b"]);
  });

  // Shutdown runs under an absolute deadline: one failing subsystem must not strand
  // another subsystem's teardown, nor prevent server.stop.
  test("a throwing hook does not prevent a sibling from running", () => {
    let sibling = 0;
    registerOptionalShutdownHook("throws", () => { throw new Error("boom"); });
    registerOptionalShutdownHook("sibling", () => { sibling += 1; });
    expect(() => runOptionalShutdownHooks()).not.toThrow();
    expect(sibling).toBe(1);
  });

  test("detach removes the hook", () => {
    let calls = 0;
    const detach = registerOptionalShutdownHook("subsystem", () => { calls += 1; });
    detach();
    runOptionalShutdownHooks();
    expect(calls).toBe(0);
  });

  // A stale detach belongs to a replaced registration and must not remove the live one.
  test("a stale detach after replacement is inert", () => {
    let live = 0;
    const staleDetach = registerOptionalShutdownHook("subsystem", () => {});
    registerOptionalShutdownHook("subsystem", () => { live += 1; });
    staleDetach();
    runOptionalShutdownHooks();
    expect(live).toBe(1);
  });
});

// Regression: the management API (lab-automation-routes.ts applySchedulerPolicy) and the
// CLI can start a scheduler WITHOUT ever calling setLabAutomationDispatchDeps. Registering
// teardown only in setLabAutomationDispatchDeps left such a scheduler running past
// drainAndShutdown, because core no longer imports the orchestrator to stop it. Proven by
// driving this test red before the fix.
describe("lab automation scheduler teardown registration", () => {
  test("a scheduler started without dispatch deps is still stopped by shutdown", () => {
    resetOptionalShutdownHooksForTests();
    const configDir = mkdtempSync(join(tmpdir(), "ocx-shutdown-hook-"));
    try {
      startLabAutomationScheduler(configDir);
      expect(isLabAutomationSchedulerRunning(configDir)).toBe(true);
      runOptionalShutdownHooks();
      expect(isLabAutomationSchedulerRunning(configDir)).toBe(false);
    } finally {
      stopLabAutomationScheduler(configDir);
    }
  });
});

// Outcome-level coverage the plan called for (010): assert a REAL Lab scheduler is stopped
// through the registry, not just an inline closure. These are the exact cases an
// independent review reproduced, each driven red before the scheduler-side registration.
describe("lab automation scheduler teardown — reviewer-reproduced cases", () => {
  // Case D: startup activates, its ownership lease is released, then the management API
  // (PUT /api/lab/automation) restarts the scheduler with no deps installed. Needs no
  // unusual setup, which makes it the most likely path in production.
  test("case D: scheduler restarted by the management API after release is stopped", () => {
    resetOptionalShutdownHooksForTests();
    const configDir = mkdtempSync(join(tmpdir(), "ocx-shutdown-case-d-"));
    try {
      const release = setLabAutomationDispatchDeps({
        configDir,
        loadConfig: () => ({}) as never,
        routeExecutor: undefined as never,
      });
      release();
      startLabAutomationScheduler(configDir);
      expect(isLabAutomationSchedulerRunning(configDir)).toBe(true);
      runOptionalShutdownHooks();
      expect(isLabAutomationSchedulerRunning(configDir)).toBe(false);
    } finally {
      stopLabAutomationScheduler(configDir);
    }
  });

  // Case B: an empty-deps call early-returns a no-op release without registering anything.
  test("case B: empty-deps no-op still leaves a stoppable scheduler", () => {
    resetOptionalShutdownHooksForTests();
    const configDir = mkdtempSync(join(tmpdir(), "ocx-shutdown-case-b-"));
    try {
      setLabAutomationDispatchDeps({} as never);
      startLabAutomationScheduler(configDir);
      expect(isLabAutomationSchedulerRunning(configDir)).toBe(true);
      runOptionalShutdownHooks();
      expect(isLabAutomationSchedulerRunning(configDir)).toBe(false);
    } finally {
      stopLabAutomationScheduler(configDir);
    }
  });

  // Case C: the ordinary activation path must keep working.
  test("case C: normal activation path is stopped by shutdown", () => {
    resetOptionalShutdownHooksForTests();
    const configDir = mkdtempSync(join(tmpdir(), "ocx-shutdown-case-c-"));
    try {
      setLabAutomationDispatchDeps({
        configDir,
        loadConfig: () => ({}) as never,
        routeExecutor: undefined as never,
      });
      startLabAutomationScheduler(configDir);
      expect(isLabAutomationSchedulerRunning(configDir)).toBe(true);
      runOptionalShutdownHooks();
      expect(isLabAutomationSchedulerRunning(configDir)).toBe(false);
    } finally {
      stopLabAutomationScheduler(configDir);
    }
  });

  // Shutdown may run twice (drain called again, or a lease release after drain).
  test("double shutdown is safe and leaves the scheduler stopped", () => {
    resetOptionalShutdownHooksForTests();
    const configDir = mkdtempSync(join(tmpdir(), "ocx-shutdown-double-"));
    try {
      startLabAutomationScheduler(configDir);
      expect(() => { runOptionalShutdownHooks(); runOptionalShutdownHooks(); }).not.toThrow();
      expect(isLabAutomationSchedulerRunning(configDir)).toBe(false);
    } finally {
      stopLabAutomationScheduler(configDir);
    }
  });
});
