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
import { foreignServiceOwnerRefusal, repairService } from "../../src/service/repair";
import type { ServiceDiagnostic } from "../../src/service/diagnostics";

const INSTALLED: ServiceDiagnostic = {
  supported: true, installed: true, enabled: true, running: true, viable: true,
  startable: true, stale: false, conflict: false, backend: "launchd", summary: "installed",
};

const DESKTOP_CLAIM = { owner: "desktop", installId: "app-install-a", consentGeneration: 2 } as const;

describe("repair under a foreign owner", () => {
  test("refuses before it asserts, writes, stops or starts anything", async () => {
    const touched: string[] = [];
    await expect(repairService({
      platform: "darwin",
      diagnose: () => INSTALLED,
      readOwnership: () => DESKTOP_CLAIM,
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
      readOwnership: () => DESKTOP_CLAIM,
      repairLaunchd: () => { throw new Error("must not run"); },
      restartLaunchd: () => { throw new Error("must not run"); },
    })).rejects.toThrow(/desktop app owns the runtime/);
  });

  test("the refusal names the claim, the untouched registration and the way back", () => {
    const message = foreignServiceOwnerRefusal(DESKTOP_CLAIM);
    expect(message).toContain("app-install-a");
    expect(message).toContain("consent generation 2");
    expect(message).toContain("not re-enabled, not rewritten and not restarted");
    expect(message).toContain("ocx service install");
  });

  test("a CLI owner repairs normally, and so does a record with no claim at all", async () => {
    for (const ownership of [null, { owner: "cli" as const, installId: "npm-install", consentGeneration: 4 }]) {
      let repaired = false;
      await repairService({
        platform: "darwin",
        diagnose: () => INSTALLED,
        readOwnership: () => ownership,
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
      readOwnership: () => DESKTOP_CLAIM,
    })).rejects.toThrow(/not installed/);
  });
});

describe("install is the verb that takes the runtime back", () => {
  const cli = readFileSync(repoPath("src", "service", "cli.ts"), "utf8");
  const installCase = cli.slice(cli.indexOf("case \"install\":"), cli.indexOf("case \"start\":"));

  test("the install path releases a recorded owner before it registers anything", () => {
    expect(installCase).toContain("releaseServiceOwner()");
    expect(installCase.indexOf("releaseServiceOwner()")).toBeLessThan(installCase.indexOf("installServiceSafely"));
  });

  test("no other subcommand releases it, so an incidental run cannot undo consent", () => {
    const rest = cli.slice(cli.indexOf("case \"start\":"));
    expect(rest).not.toContain("releaseServiceOwner");
    expect(readFileSync(repoPath("src", "service", "repair.ts"), "utf8")).not.toContain("releaseServiceOwner");
  });
});

