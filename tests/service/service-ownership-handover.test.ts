/**
 * Who may hand the runtime back, and what refuses to take it.
 *
 * The maintainer decision behind this: the user's npm service registration is KEPT, never
 * deleted. So the recorded owner is the only thing standing between a takeover the user
 * consented to and the next `ocx service repair` — which runs incidentally, from a tray
 * helper, from `ocx update`, from a doctor suggestion — re-enabling and restarting the npm
 * launcher without saying a word about it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";
import { foreignServiceOwnerRefusal, repairService, unknownServiceOwnerRefusal } from "../../src/service/repair";
import type { ServiceDiagnostic } from "../../src/service/diagnostics";
import type { ServiceOwnershipResolution } from "../../src/service/state";

const INSTALLED: ServiceDiagnostic = {
  supported: true, installed: true, enabled: true, running: true, viable: true,
  startable: true, stale: false, conflict: false, backend: "launchd", summary: "installed",
};

const DESKTOP_CLAIM = { owner: "desktop", installId: "app-install-a", consentGeneration: 2 } as const;
const DESKTOP: ServiceOwnershipResolution = { kind: "owned", ownership: DESKTOP_CLAIM, revision: 4 };
const UNKNOWN: ServiceOwnershipResolution = { kind: "unknown", reason: "a service state path could not be read (EACCES)" };

describe("repair under an owner that is not this CLI", () => {
  test("refuses before it asserts, writes, stops or starts anything", async () => {
    const touched: string[] = [];
    await expect(repairService({
      platform: "darwin",
      diagnose: () => INSTALLED,
      readOwnership: () => DESKTOP,
      assertEnv: () => { touched.push("assertEnv"); },
      assertAuth: () => { touched.push("assertAuth"); },
      repairLaunchd: () => { touched.push("repairLaunchd"); },
      restartLaunchd: () => { touched.push("restartLaunchd"); },
    })).rejects.toThrow(/desktop app owns the runtime/);
    // A repair that has already rewritten the assets has changed the thing it was
    // supposed to leave alone, so the gate has to sit in front of every seam.
    expect(touched).toEqual([]);
  });

  test("restart refuses on the same terms", async () => {
    await expect(repairService({
      platform: "darwin",
      verb: "restart",
      diagnose: () => INSTALLED,
      readOwnership: () => DESKTOP,
      repairLaunchd: () => { throw new Error("must not run"); },
      restartLaunchd: () => { throw new Error("must not run"); },
    })).rejects.toThrow(/desktop app owns the runtime/);
  });

  /**
   * Collapsing "I could not read the claim" into "there is no claim" is how a permissions
   * error reactivates a consented takeover. Only true absence may mean nobody owns it.
   */
  test("an unreadable or contradictory record refuses too, rather than reading as CLI-owned", async () => {
    const touched: string[] = [];
    await expect(repairService({
      platform: "darwin",
      diagnose: () => INSTALLED,
      readOwnership: () => UNKNOWN,
      assertEnv: () => { touched.push("assertEnv"); },
      repairLaunchd: () => { touched.push("repairLaunchd"); },
    })).rejects.toThrow(/could not be determined/);
    expect(touched).toEqual([]);
  });

  test("both refusals name the untouched registration and the way back", () => {
    const foreign = foreignServiceOwnerRefusal(DESKTOP_CLAIM);
    expect(foreign).toContain("app-install-a");
    expect(foreign).toContain("consent generation 2");
    expect(foreign).toContain("not re-enabled, not rewritten and not restarted");
    expect(foreign).toContain("ocx service install");

    const unknown = unknownServiceOwnerRefusal("a service state path could not be read (EACCES)");
    expect(unknown).toContain("EACCES");
    expect(unknown).toContain("ocx service install");
    // Both take the verb, so `start` does not report itself as a repair.
    expect(foreignServiceOwnerRefusal(DESKTOP_CLAIM, "start")).toContain("Background service start stopped");
    expect(unknownServiceOwnerRefusal("nothing parsed", "start")).toContain("Background service start stopped");
  });

  test("a CLI owner repairs normally, and so does a record with no claim at all", async () => {
    const resolutions: ServiceOwnershipResolution[] = [
      { kind: "none", revision: 0 },
      { kind: "owned", ownership: { owner: "cli", installId: "npm-install", consentGeneration: 4 }, revision: 8 },
    ];
    for (const resolution of resolutions) {
      let repaired = false;
      await repairService({
        platform: "darwin",
        diagnose: () => INSTALLED,
        readOwnership: () => resolution,
        assertEnv: () => {},
        assertAuth: () => {},
        repairLaunchd: () => { repaired = true; },
      });
      expect(repaired).toBe(true);
    }
  });

  test("an uninstalled service still reports that first", async () => {
    await expect(repairService({
      platform: "darwin",
      diagnose: () => ({ ...INSTALLED, installed: false }),
      readOwnership: () => DESKTOP,
    })).rejects.toThrow(/not installed/);
  });
});

describe("which service verbs are gated", () => {
  const cli = readFileSync(repoPath("src", "service", "cli.ts"), "utf8");
  const between = (from: string, to: string): string => cli.slice(cli.indexOf(from), cli.indexOf(to));
  const installCase = between("case \"install\":", "case \"start\":");
  const startCase = between("case \"start\":", "case \"stop\"");

  /**
   * Releasing first meant a cancelled UAC prompt, a failed registration or an aborted
   * cleanup left the retained npm registration looking CLI-owned, so the next incidental
   * repair would reactivate it.
   */
  test("install releases the marker only after the registration succeeded", () => {
    expect(installCase).toContain("releaseServiceOwner(ownershipBeforeInstall");
    expect(installCase.indexOf("installServiceSafely")).toBeLessThan(installCase.indexOf("releaseServiceOwner(ownershipBeforeInstall"));
    // The failure branch leaves before the release.
    expect(installCase.indexOf("Service install cleanup failed")).toBeLessThan(installCase.indexOf("releaseServiceOwner(ownershipBeforeInstall"));
  });

  test("start refuses on the same terms, because it activates the registration", () => {
    expect(startCase).toContain("resolveServiceOwnership()");
    expect(startCase).toContain("foreignServiceOwnerRefusal");
    expect(startCase).toContain("unknownServiceOwnerRefusal");
    // Reported, not thrown: the Windows tray drives this through a caller that does not catch.
    expect(startCase).toContain("process.exitCode = 1;");
  });

  test("stop and uninstall stay ungated, and nothing else releases the marker", () => {
    const deactivating = cli.slice(cli.indexOf("case \"stop\""));
    expect(deactivating).not.toContain("resolveServiceOwnership");
    expect(deactivating).not.toContain("releaseServiceOwner");
    expect(startCase).not.toContain("releaseServiceOwner");
    expect(readFileSync(repoPath("src", "service", "repair.ts"), "utf8")).not.toContain("releaseServiceOwner");
  });
});
