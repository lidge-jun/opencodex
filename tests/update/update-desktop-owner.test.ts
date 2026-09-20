/**
 * What an update may do to a runtime it does not own.
 *
 * Two updaters reach the same situation: the Bun path in src/update/index.ts and the npm
 * and pnpm path in bin/ocx.mjs. Both stop the proxy and then run `ocx service repair`, and
 * under a desktop owner both halves are wrong — the running server is the app's bundled
 * sidecar, and the repair re-enables the npm launcher the takeover superseded. The rule is
 * one plain-ESM module for the reason #3008 recorded: two lanes deciding separately is how
 * a fix ships on one side only.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";
import { parseRecordedOwnership, planUpdateRuntimeHandling } from "../../src/update/runtime-ownership.mjs";
import { parseServiceOwnership } from "../../src/service/state";

describe("the runtime-ownership veto", () => {
  test("a desktop owner stops both the stop and the service refresh, and says so", () => {
    const plan = planUpdateRuntimeHandling({
      ownership: { owner: "desktop", installId: "app-install-a", consentGeneration: 3 },
      serviceInstalled: true,
    });
    expect(plan.stopRuntime).toBe(false);
    expect(plan.refreshService).toBe(false);
    expect(plan.notice).toContain("app-install-a");
    expect(plan.notice).toContain("consent generation 3");
    expect(plan.notice).toContain("neither re-enabled nor restarted");
  });

  test("a CLI owner and an unowned runtime both take the ordinary path", () => {
    for (const ownership of [null, { owner: "cli", installId: "npm-install", consentGeneration: 1 }]) {
      expect(planUpdateRuntimeHandling({ ownership, serviceInstalled: true }))
        .toEqual({ stopRuntime: true, refreshService: true, notice: null });
      expect(planUpdateRuntimeHandling({ ownership, serviceInstalled: false }))
        .toEqual({ stopRuntime: true, refreshService: false, notice: null });
    }
  });

  test("an owner this version does not recognise is treated as foreign, not as our own", () => {
    const plan = planUpdateRuntimeHandling({
      ownership: { owner: "something-newer", installId: "x", consentGeneration: 1 },
      serviceInstalled: true,
    });
    expect(plan.stopRuntime).toBe(false);
  });
});

describe("the launcher's reader agrees with the authoritative one", () => {
  const accepted = [
    { owner: "desktop", installId: "a", consentGeneration: 0 },
    { owner: "cli", installId: "a", consentGeneration: 12 },
    { owner: "desktop", installId: "a", consentGeneration: 1, grantedBy: "first-launch" },
  ];
  const rejected = [
    { owner: "root", installId: "a", consentGeneration: 1 },
    { owner: "desktop", installId: "", consentGeneration: 1 },
    { owner: "desktop", installId: "a" },
    { owner: "desktop", installId: "a", consentGeneration: -1 },
    { owner: "desktop", installId: "a", consentGeneration: 1.5 },
    { owner: "desktop", installId: "a", consentGeneration: "1" },
    "desktop",
    null,
  ];

  test("both accept the same claims", () => {
    for (const ownership of accepted) {
      expect(parseServiceOwnership(ownership)).not.toBeNull();
      expect(parseRecordedOwnership(JSON.stringify({ ownership }))).toEqual(ownership);
    }
  });

  test("both reject the same claims", () => {
    for (const ownership of rejected) {
      expect(parseServiceOwnership(ownership)).toBeNull();
      expect(parseRecordedOwnership(JSON.stringify({ ownership }))).toBeNull();
    }
  });

  test("an absent, empty or unparseable record is not a claim", () => {
    expect(parseRecordedOwnership(null)).toBeNull();
    expect(parseRecordedOwnership("")).toBeNull();
    expect(parseRecordedOwnership("{")).toBeNull();
    expect(parseRecordedOwnership("[]")).toBeNull();
    expect(parseRecordedOwnership(JSON.stringify({ version: 2 }))).toBeNull();
  });
});

describe("both updaters consult the shared rule", () => {
  const bunPath = readFileSync(repoPath("src", "update", "index.ts"), "utf8");
  const launcher = readFileSync(repoPath("bin", "ocx.mjs"), "utf8");

  test("the Bun updater gates its stop, its refresh and its restart hint", () => {
    expect(bunPath).toContain("from \"./runtime-ownership.mjs\"");
    expect(bunPath).toContain("if (runtimePlan.stopRuntime && (serviceWasInstalled || readPid() || readRuntimePort() || pendingTeardownOutstanding()))");
    expect(bunPath).toContain("if (runtimePlan.refreshService) {");
    expect(bunPath).toContain("} else if (runtimePlan.stopRuntime) {");
    expect(bunPath).toContain("if (stopAttempted && runtimePlan.refreshService && postUpdateLauncherUsable)");
  });

  test("the npm launcher gates its stop, its refresh and its failure recovery", () => {
    expect(launcher).toContain("from \"../src/update/runtime-ownership.mjs\"");
    expect(launcher).toContain("if (runtimePlan.stopRuntime && (serviceWasInstalled || hasRuntimeState || hasPendingTeardown))");
    expect(launcher).toContain("if (runtimePlan.refreshService) {");
    // Nothing was stopped, so nothing is recovered: starting a proxy here would put a
    // second one beside the runtime the app is managing.
    expect(launcher).toContain("if (!runtimePlan.stopRuntime) return;");
  });

  test("neither updater reimplements the decision", () => {
    for (const source of [bunPath, launcher]) {
      expect(source).toContain("planUpdateRuntimeHandling({");
      expect(source).not.toMatch(/owner\s*!==\s*"cli"/);
    }
  });
});

