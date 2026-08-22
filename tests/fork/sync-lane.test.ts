import { describe, expect, test } from "bun:test";
import { annotateMainLane } from "../../scripts/fork/sync/lane";
import type {
  CommandResult,
  CommandRunner,
  SyncEvent,
  SyncEventKind,
} from "../../scripts/fork/sync/types";

function event(kind: SyncEventKind): SyncEvent {
  return {
    kind,
    upstreamRepo: "upstream",
    latestTag: "v1.2.3",
    latestTagSha: "tag-sha",
    vendorMainSha: "vendor-sha",
    vendorDevSha: "dev-sha",
    detectedAt: "2026-08-22T00:00:00.000Z",
  };
}

function queuedRunner(
  results: CommandResult[],
): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runner: async args => {
      calls.push([...args]);
      const result = results.shift();
      if (!result) throw new Error("queued git result missing");
      return result;
    },
  };
}

function gitResult(
  stdout: string,
  exitCode = 0,
): CommandResult {
  return { exitCode, stdout, stderr: exitCode === 0 ? "" : "git failed" };
}

describe("annotateMainLane", () => {
  test("marks an already-current event as a contained no-op", async () => {
    const queued = queuedRunner([
      gitResult("vendor-sha\n"),
      gitResult("base-sha\n"),
    ]);

    const result = await annotateMainLane(event("already-current"), {
      runner: queued.runner,
    });

    expect(result).toEqual({
      ...event("already-current"),
      vendorContainedInMain: true,
      mergeBaseCount: 1,
      recommendedLane: "noop",
    });
    expect(queued.calls).toEqual([
      ["merge-base", "--is-ancestor", "vendor-sha", "HEAD"],
      ["merge-base", "--all", "HEAD", "vendor-sha"],
    ]);
  });

  test("reclassifies an uncontained already-current event as main-behind", async () => {
    const queued = queuedRunner([
      gitResult("", 1),
      gitResult("base-sha\n"),
    ]);

    const result = await annotateMainLane(event("already-current"), {
      mainRef: "refs/remotes/origin/main",
      runner: queued.runner,
    });

    expect(result.kind).toBe("main-behind");
    expect(result.vendorContainedInMain).toBe(false);
    expect(result.mergeBaseCount).toBe(1);
    expect(result.recommendedLane).toBe("daily-merge");
  });

  test("keeps pin-updated and recommends a daily merge", async () => {
    const queued = queuedRunner([
      gitResult("", 1),
      gitResult("base-sha\n"),
    ]);

    const result = await annotateMainLane(event("pin-updated"), {
      runner: queued.runner,
    });

    expect(result.kind).toBe("pin-updated");
    expect(result.vendorContainedInMain).toBe(false);
    expect(result.mergeBaseCount).toBe(1);
    expect(result.recommendedLane).toBe("daily-merge");
  });

  test("reclassifies multiple merge bases as an emergency rebuild", async () => {
    const queued = queuedRunner([
      gitResult("", 1),
      gitResult("base-a\n\nbase-b\n"),
    ]);

    const result = await annotateMainLane(event("already-current"), {
      runner: queued.runner,
    });

    expect(result.kind).toBe("history-diverged");
    expect(result.vendorContainedInMain).toBe(false);
    expect(result.mergeBaseCount).toBe(2);
    expect(result.recommendedLane).toBe("emergency-rebuild");
  });

  test("does not reclassify non-lane events", async () => {
    const queued = queuedRunner([
      gitResult("vendor-sha\n"),
      gitResult("base-sha\n"),
    ]);

    const result = await annotateMainLane(event("pin-diverged"), {
      runner: queued.runner,
    });

    expect(result).toEqual({
      ...event("pin-diverged"),
      vendorContainedInMain: true,
      mergeBaseCount: 1,
    });
  });

  test("leaves lane fields unset when vendor or main is missing", async () => {
    const missingVendor = event("already-current");
    missingVendor.vendorMainSha = "";
    const missingVendorRunner = queuedRunner([]);
    expect(await annotateMainLane(missingVendor, {
      runner: missingVendorRunner.runner,
    })).toEqual(missingVendor);
    expect(missingVendorRunner.calls).toEqual([]);

    const missingMainRunner = queuedRunner([
      gitResult("fatal: bad revision", 128),
    ]);
    const unchanged = event("pin-updated");
    expect(await annotateMainLane(unchanged, {
      runner: missingMainRunner.runner,
    })).toEqual(unchanged);
  });
});
