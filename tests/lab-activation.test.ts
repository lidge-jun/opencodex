import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateLab,
  labActivationRequired,
  labAutomationEnabledOnDisk,
  isLabActivated,
  resetLabActivationForTests,
} from "../src/lib/lab-activation";
import {
  resolveCompatibilityEvidenceProvider,
  resetCompatibilityEvidenceProviderForTests,
} from "../src/routing/compatibility/provider-slot";
import { defaultLabAutomationPolicyV1 } from "../src/lab/automation/policy";
import { isLabAutomationSchedulerRunning, stopLabAutomationScheduler } from "../src/lab/automation/orchestrator";
import { runOptionalShutdownHooks, resetOptionalShutdownHooksForTests } from "../src/lib/optional-shutdown-hooks";
import {
  acquireServerResourceOwner,
  resetServerResourceOwnershipForTests,
} from "../src/lib/server-resource-ownership";
import { hasPassiveRouteLinker, resetPassiveRouteLinkerForTests } from "../src/server/passive-route-linker";
import type { OcxConfig } from "../src/types";

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-activation-"));
  mkdirSync(join(dir, "lab"), { recursive: true });
  return dir;
}

function writeEnabledAutomationConfig(dir: string): void {
  writeFileSync(join(dir, "lab", "automation-config.json"), JSON.stringify({
    schemaVersion: 1,
    policy: {
      ...defaultLabAutomationPolicyV1(),
      enabled: true,
    },
    routes: { schemaVersion: 1, routes: [] },
  }));
}

function profileConfig(): OcxConfig {
  return { providers: {}, routingProfiles: { p: { candidates: [] } } } as unknown as OcxConfig;
}

const withProfile = profileConfig();
const bare = { providers: {} } as unknown as OcxConfig;

describe("lab activation gate", () => {
  // Slots are process-global, so a sibling test file that registered one directly would
  // otherwise leak into the bare-install assertion below.
  beforeEach(() => {
    resetLabActivationForTests();
    resetServerResourceOwnershipForTests();
    resetCompatibilityEvidenceProviderForTests();
    resetPassiveRouteLinkerForTests();
  });

  // The property the owner asked for: an install with no profile and no automation
  // registers nothing, so the request path has no Lab code to run.
  test("a bare install requires no activation and fills no slot", () => {
    const dir = scratch();
    expect(labActivationRequired(bare, dir)).toBe(false);
    expect(resolveCompatibilityEvidenceProvider()).toBeNull();
    expect(hasPassiveRouteLinker()).toBe(false);
  });

  test("a routing profile requires activation and fills both slots", () => {
    const dir = scratch();
    expect(labActivationRequired(withProfile, dir)).toBe(true);
    activateLab(withProfile, dir);
    expect(resolveCompatibilityEvidenceProvider()).not.toBeNull();
    expect(hasPassiveRouteLinker()).toBe(true);
    expect(isLabActivated(dir)).toBe(true);
  });

  // Regression: startLabAutomationScheduler runs the full normalizer, which throws on any
  // field violation. That call is on the startup path of every install with a routing
  // profile, so an invalid automation file used to take the whole proxy down after
  // Bun.serve had already bound. Reproduced before the fix: threw "invalid policy layers",
  // slot registered, activation record absent.
  test("a parseable but non-normalizable automation config does not take startup down", () => {
    const dir = scratch();
    writeFileSync(join(dir, "lab", "automation-config.json"), JSON.stringify({
      schemaVersion: 1,
      policy: { schemaVersion: 1, enabled: true },
      routes: {},
    }));
    expect(labAutomationEnabledOnDisk(dir)).toBe(true);
    expect(() => activateLab(withProfile, dir)).not.toThrow();
    // Slots and the activation record must stay consistent even when automation fails.
    expect(resolveCompatibilityEvidenceProvider()).not.toBeNull();
    expect(isLabActivated(dir)).toBe(true);
  });

  test("activation is idempotent per configDir", () => {
    const dir = scratch();
    activateLab(withProfile, dir);
    expect(() => { activateLab(withProfile, dir); activateLab(withProfile, dir); }).not.toThrow();
    expect(isLabActivated(dir)).toBe(true);
  });

  test("same-root successor keeps automation after predecessor owner release", () => {
    const dir = scratch();
    writeEnabledAutomationConfig(dir);
    const firstOwner = acquireServerResourceOwner();
    activateLab(profileConfig(), dir);
    expect(isLabAutomationSchedulerRunning(dir)).toBe(true);

    const secondOwner = acquireServerResourceOwner();
    activateLab(profileConfig(), dir);
    firstOwner.release();
    expect(isLabAutomationSchedulerRunning(dir)).toBe(true);

    secondOwner.release();
    expect(isLabAutomationSchedulerRunning(dir)).toBe(false);
  });

  test("same-process restart reacquires automation after its prior owner ended", () => {
    const dir = scratch();
    writeEnabledAutomationConfig(dir);
    const config = profileConfig();

    const firstOwner = acquireServerResourceOwner();
    activateLab(config, dir);
    expect(isLabAutomationSchedulerRunning(dir)).toBe(true);
    firstOwner.release();
    expect(isLabAutomationSchedulerRunning(dir)).toBe(false);

    const secondOwner = acquireServerResourceOwner();
    activateLab(config, dir);
    expect(isLabAutomationSchedulerRunning(dir)).toBe(true);
    secondOwner.release();
    expect(isLabAutomationSchedulerRunning(dir)).toBe(false);
  });

  // Ordering trap: automation-only activation must not permanently satisfy a later
  // profile-driven one. Safe today only because activation is all-or-nothing; this test
  // fails the moment a registration becomes conditional on the activation reason.
  test("automation-only activation still leaves the compatibility provider installed", () => {
    const dir = scratch();
    writeFileSync(join(dir, "lab", "automation-config.json"), JSON.stringify({
      schemaVersion: 1, policy: { schemaVersion: 1, enabled: true }, routes: {},
    }));
    expect(labActivationRequired(bare, dir)).toBe(true);
    activateLab(bare, dir);
    // ...now a profile is created at runtime and the management route activates again.
    activateLab(withProfile, dir);
    expect(resolveCompatibilityEvidenceProvider()).not.toBeNull();
  });
});

describe("automation detection reads the current authority", () => {
  // Slots are process-global, so a sibling test file that registered one directly would
  // otherwise leak into the bare-install assertion below.
  beforeEach(() => {
    resetLabActivationForTests();
    resetServerResourceOwnershipForTests();
    resetCompatibilityEvidenceProviderForTests();
    resetPassiveRouteLinkerForTests();
  });

  test("combined automation-config.json wins over the legacy file", () => {
    const dir = scratch();
    writeFileSync(join(dir, "lab", "automation-config.json"), JSON.stringify({
      schemaVersion: 1, policy: { schemaVersion: 1, enabled: false }, routes: {},
    }));
    writeFileSync(join(dir, "lab", "automation-policy.json"), JSON.stringify({ enabled: true }));
    expect(labAutomationEnabledOnDisk(dir)).toBe(false);
  });

  test("legacy file is the fallback when the combined file is absent", () => {
    const dir = scratch();
    writeFileSync(join(dir, "lab", "automation-policy.json"), JSON.stringify({ enabled: true }));
    expect(labAutomationEnabledOnDisk(dir)).toBe(true);
  });

  test("a combined file without a policy key falls through to legacy", () => {
    const dir = scratch();
    writeFileSync(join(dir, "lab", "automation-config.json"), JSON.stringify({ schemaVersion: 1 }));
    writeFileSync(join(dir, "lab", "automation-policy.json"), JSON.stringify({ enabled: true }));
    expect(labAutomationEnabledOnDisk(dir)).toBe(true);
  });

  test("malformed JSON means not enabled rather than throwing", () => {
    const dir = scratch();
    writeFileSync(join(dir, "lab", "automation-config.json"), "{ not json");
    expect(() => labAutomationEnabledOnDisk(dir)).not.toThrow();
    expect(labAutomationEnabledOnDisk(dir)).toBe(false);
  });

  test("nothing on disk is not enabled", () => {
    expect(labAutomationEnabledOnDisk(scratch())).toBe(false);
  });
});

describe("failed scheduler start leaves nothing dangling", () => {
  beforeEach(() => {
    resetLabActivationForTests();
    resetServerResourceOwnershipForTests();
    resetOptionalShutdownHooksForTests();
  });

  // startLabAutomationScheduler registers its shutdown hook BEFORE it can throw, so a
  // failed start leaves a hook with no timer behind it. That must be harmless: no running
  // scheduler, and running the hooks must not surface the config error at shutdown.
  test("no timer is left running and shutdown stays safe", () => {
    const dir = scratch();
    writeFileSync(join(dir, "lab", "automation-config.json"), JSON.stringify({
      schemaVersion: 1, policy: { schemaVersion: 1, enabled: true }, routes: {},
    }));
    activateLab(withProfile, dir);
    expect(isLabAutomationSchedulerRunning(dir)).toBe(false);
    expect(() => runOptionalShutdownHooks()).not.toThrow();
    stopLabAutomationScheduler(dir);
  });
});
