import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handoffWindowsTrayForUpdate, planWindowsTrayUpdate, windowsTrayStopConfirmed } from "../../src/update/tray-update-plan.mjs";
import { repoRoot } from "../helpers/repo-root";

describe("Windows tray update handoff contract", () => {
  test("preserves an installed, running tray across replacement", () => {
    expect(planWindowsTrayUpdate({ installed: true, running: true })).toEqual({
      installed: true,
      running: true,
      stopBeforeReplacement: true,
      restoreOnFailure: true,
      refreshAfterReplacement: true,
      installArgs: ["tray", "install"],
    });
  });

  test("refreshes an installed, idle tray without starting it", () => {
    expect(planWindowsTrayUpdate({ installed: true, running: false })).toMatchObject({
      stopBeforeReplacement: false,
      restoreOnFailure: false,
      refreshAfterReplacement: true,
      installArgs: ["tray", "install", "--no-start"],
    });
  });

  test("does nothing for an absent tray and fails closed on incomplete stop", () => {
    expect(planWindowsTrayUpdate({ installed: false, running: false })).toMatchObject({
      stopBeforeReplacement: false,
      restoreOnFailure: false,
      refreshAfterReplacement: false,
    });
    expect(windowsTrayStopConfirmed(0, false)).toBe(true);
    expect(windowsTrayStopConfirmed(1, false)).toBe(false);
    expect(windowsTrayStopConfirmed(0, true)).toBe(false);
  });

  test("restores a previously running tray when stop throws or remains live", () => {
    const calls: string[] = [];
    expect(() => handoffWindowsTrayForUpdate({ installed: true, running: true }, {
      stop: () => { calls.push("stop-throw"); throw new Error("registry status failed"); },
      start: () => { calls.push("restore-after-throw"); },
    })).toThrow("registry status failed");
    expect(calls).toEqual(["stop-throw", "restore-after-throw"]);

    expect(() => handoffWindowsTrayForUpdate({ installed: true, running: true }, {
      stop: () => ({ exitStatus: 0, running: true }),
      start: () => { calls.push("restore-still-live"); },
    })).toThrow("still reports running");
    expect(calls).toContain("restore-still-live");
  });

  test("all three updater lanes consume the same tested plan", () => {
    const root = repoRoot();
    for (const path of ["src/update/index.ts", "src/update/job.ts", "bin/ocx.mjs"]) {
      const source = readFileSync(join(root, path), "utf8");
      expect(source).toContain("planWindowsTrayUpdate");
      expect(source).toContain("handoffWindowsTrayForUpdate");
      expect(source).toContain("installArgs");
    }
  });
});
