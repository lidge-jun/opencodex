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
import { resolveCompatibilityEvidenceProvider } from "../src/routing/compatibility/provider-slot";
import { hasPassiveRouteLinker } from "../src/server/passive-route-linker";
import type { OcxConfig } from "../src/types";

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-activation-"));
  mkdirSync(join(dir, "lab"), { recursive: true });
  return dir;
}
const withProfile = { providers: {}, routingProfiles: { p: { candidates: [] } } } as unknown as OcxConfig;
const bare = { providers: {} } as unknown as OcxConfig;

describe("lab activation gate", () => {
  beforeEach(() => resetLabActivationForTests());

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
  beforeEach(() => resetLabActivationForTests());

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
