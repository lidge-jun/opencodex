import { describe, expect, test } from "bun:test";
import type { CommandResult, CommandRunner, SyncEvent } from "../../scripts/fork/sync/types";
import {
  isAllowedVendorRef,
  pinVendorRef,
  pinVendorRefs,
} from "../../scripts/fork/sync/pin";

const TAG_SHA = "1111111111111111111111111111111111111111";
const DEV_SHA = "3333333333333333333333333333333333333333";

function event(kind: SyncEvent["kind"] = "pin-updated"): SyncEvent {
  return {
    kind,
    upstreamRepo: "upstream",
    latestTag: "v2.29.0",
    latestTagSha: TAG_SHA,
    vendorMainSha: "2222222222222222222222222222222222222222",
    vendorDevSha: "4444444444444444444444444444444444444444",
    detectedAt: "2026-08-22T18:00:00.000Z",
  };
}

function queuedRunner(results: CommandResult[], calls: string[][]): CommandRunner {
  return async args => {
    calls.push([...args]);
    return results.shift() ?? { exitCode: 1, stdout: "", stderr: "unexpected command" };
  };
}

const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });

describe("fork sync pinning", () => {
  test("allows only vendor/main and vendor/dev", () => {
    expect(isAllowedVendorRef("vendor/main")).toBe(true);
    expect(isAllowedVendorRef("vendor/dev")).toBe(true);
    expect(isAllowedVendorRef("main")).toBe(false);
    expect(isAllowedVendorRef("refs/heads/vendor/main")).toBe(false);
  });

  test("uses ff-only merges for both allowlisted refs", async () => {
    const calls: string[][] = [];
    const pinned = await pinVendorRefs(event(), {
      runner: queuedRunner([
        ok(),
        ok(),
        ok(`${TAG_SHA}\n`),
        ok(),
        ok(),
        ok(`${DEV_SHA}\n`),
      ], calls),
      upstreamDevRef: "refs/remotes/upstream/dev",
    });

    expect(calls).toEqual([
      ["switch", "vendor/main"],
      ["merge", "--ff-only", TAG_SHA],
      ["rev-parse", "refs/heads/vendor/main"],
      ["switch", "vendor/dev"],
      ["merge", "--ff-only", "refs/remotes/upstream/dev"],
      ["rev-parse", "refs/heads/vendor/dev"],
    ]);
    expect(pinned.kind).toBe("pin-updated");
    expect(pinned.vendorMainSha).toBe(TAG_SHA);
    expect(pinned.vendorDevSha).toBe(DEV_SHA);
  });

  test("does not chase vendor/dev on an already-current poll", async () => {
    const calls: string[][] = [];
    const unchanged = await pinVendorRefs(event("already-current"), {
      runner: queuedRunner([], calls),
    });

    expect(calls).toEqual([]);
    expect(unchanged.kind).toBe("already-current");
  });

  test("returns pin-diverged and stops when an ff-only merge fails", async () => {
    const calls: string[][] = [];
    const diverged = await pinVendorRefs(event(), {
      runner: queuedRunner([
        ok(),
        { exitCode: 1, stdout: "", stderr: "Not possible to fast-forward" },
      ], calls),
    });

    expect(diverged.kind).toBe("pin-diverged");
    expect(diverged.error).toContain("fast-forward");
    expect(calls).toEqual([
      ["switch", "vendor/main"],
      ["merge", "--ff-only", TAG_SHA],
    ]);
  });

  test("rejects an unallowlisted ref before running git", async () => {
    const calls: string[][] = [];
    await expect(pinVendorRef("main", TAG_SHA, queuedRunner([], calls)))
      .rejects.toThrow("not allowlisted");
    expect(calls).toEqual([]);
  });
});
