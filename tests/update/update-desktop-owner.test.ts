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

describe("an unreadable record is not an unowned runtime", () => {
  test("unknown ownership vetoes both halves and points at the way back", () => {
    const plan = planUpdateRuntimeHandling({ ownership: null, ownershipUnknown: true, serviceInstalled: true });
    expect(plan.stopRuntime).toBe(false);
    expect(plan.refreshService).toBe(false);
    expect(plan.notice).toContain("could not be determined");
    expect(plan.notice).toContain("ocx service install");
  });

  test("the desktop notice also says how to clear a stale marker", () => {
    const plan = planUpdateRuntimeHandling({
      ownership: { owner: "desktop", installId: "a", consentGeneration: 1 },
      serviceInstalled: true,
    });
    expect(plan.notice).toContain("ocx service install");
  });
});

describe("every updater re-reads ownership before it starts a proxy directly", () => {
  const bunPath = readFileSync(repoPath("src", "update", "index.ts"), "utf8");
  const launcher = readFileSync(repoPath("bin", "ocx.mjs"), "utf8");
  const worker = readFileSync(repoPath("src", "update", "job.ts"), "utf8");

  /**
   * Ownership is sampled before a package install that can take minutes. If the app claims
   * the runtime during it, the post-update repair refuses — and both callers used to read
   * that refusal as a generic failure and start an npm proxy beside the app's sidecar.
   */
  test("the two package updaters re-resolve before the direct-start fallback", () => {
    for (const source of [bunPath, launcher]) {
      const fallbackAt = source.indexOf("starting the proxy directly instead");
      expect(fallbackAt).toBeGreaterThan(-1);
      const recheckAt = source.lastIndexOf("planUpdateRuntimeHandling({", fallbackAt);
      expect(recheckAt).toBeGreaterThan(-1);
      expect(source.slice(recheckAt, fallbackAt)).toContain("nowOwned.stopRuntime");
    }
  });

  /**
   * The dashboard is a third lane. It defaults to restarting, and after the package updater
   * correctly left a foreign-owned runtime alone it would reclaim the port, run the repair
   * that now refuses, and fall through to a direct start.
   */
  test("the dashboard worker checks before it restarts anything", () => {
    const restartAt = worker.indexOf("if (restart) {");
    const handoffAt = worker.indexOf("finishGuiUpdateRestart(", restartAt);
    const gateAt = worker.indexOf("updateRestartVeto(", restartAt);
    expect(gateAt).toBeGreaterThan(restartAt);
    expect(gateAt).toBeLessThan(handoffAt);
    expect(worker.slice(gateAt, handoffAt)).toContain("if (veto)");
    expect(worker.slice(gateAt, handoffAt)).toContain("restarted: false");
    // The veto is the shared rule, not a second opinion about ownership.
    const veto = readFileSync(repoPath("src", "update", "restart-ownership.ts"), "utf8");
    expect(veto).toContain("planUpdateRuntimeHandling({");
    expect(veto).toContain("resolveServiceOwnership");
  });
});
