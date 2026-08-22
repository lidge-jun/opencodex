import { describe, expect, test } from "bun:test";
import type { CommandResult, CommandRunner, SyncEvent } from "../../scripts/fork/sync/types";
import { detectLatestVTag } from "../../scripts/fork/sync/detect";

const TAG_SHA = "1111111111111111111111111111111111111111";
const MAIN_SHA = "2222222222222222222222222222222222222222";
const DEV_SHA = "3333333333333333333333333333333333333333";

function queuedRunner(results: CommandResult[]): CommandRunner {
  return async () => results.shift() ?? { exitCode: 1, stdout: "", stderr: "unexpected command" };
}

function result(stdout: string, exitCode = 0, stderr = ""): CommandResult {
  return { stdout, exitCode, stderr };
}

describe("fork sync detection", () => {
  test("selects the highest version-like v tag and returns a pin candidate", async () => {
    const event = await detectLatestVTag({
      upstreamRepo: "https://github.com/lidge-jun/opencodex.git",
      now: () => new Date("2026-08-22T18:00:00.000Z"),
      runner: queuedRunner([
        result(`${TAG_SHA} refs/tags/v2.28.0\n${TAG_SHA} refs/tags/v2.29.0\n${MAIN_SHA} refs/tags/not-a-release\n`),
        result(MAIN_SHA),
        result(DEV_SHA),
        result(""),
        result(""),
      ]),
    });

    expect(event).toEqual<SyncEvent>({
      kind: "pin-updated",
      upstreamRepo: "https://github.com/lidge-jun/opencodex.git",
      latestTag: "v2.29.0",
      latestTagSha: TAG_SHA,
      vendorMainSha: MAIN_SHA,
      vendorDevSha: DEV_SHA,
      detectedAt: "2026-08-22T18:00:00.000Z",
    });
  });

  test("returns already-current when vendor main is at the latest tag", async () => {
    const event = await detectLatestVTag({
      upstreamRepo: "upstream",
      runner: queuedRunner([
        result(`${TAG_SHA} refs/tags/v2.29.0\n`),
        result(TAG_SHA),
        result(DEV_SHA),
        result(""),
      ]),
    });

    expect(event.kind).toBe("already-current");
    expect(event.latestTagSha).toBe(TAG_SHA);
  });

  test("returns pin-diverged when vendor main cannot fast-forward to the tag", async () => {
    const event = await detectLatestVTag({
      upstreamRepo: "upstream",
      runner: queuedRunner([
        result(`${TAG_SHA} refs/tags/v2.29.0\n`),
        result(MAIN_SHA),
        result(DEV_SHA),
        result(""),
        result("", 1, "not an ancestor"),
      ]),
    });

    expect(event.kind).toBe("pin-diverged");
    expect(event.error).toContain("vendor/main");
  });

  test("returns detect-failed for a git command failure", async () => {
    const event = await detectLatestVTag({
      upstreamRepo: "upstream",
      runner: queuedRunner([result("", 1, "network unavailable")]),
    });

    expect(event.kind).toBe("detect-failed");
    expect(event.error).toContain("network unavailable");
    expect(event.error).not.toContain("upstream");
  });

  test("returns detect-failed when the tag is not on upstream main", async () => {
    const event = await detectLatestVTag({
      upstreamRepo: "upstream",
      runner: queuedRunner([
        result(`${TAG_SHA} refs/tags/v2.29.0\n`),
        result(MAIN_SHA),
        result(DEV_SHA),
        result("", 1, "not an ancestor"),
      ]),
    });

    expect(event.kind).toBe("detect-failed");
    expect(event.error).toContain("upstream/main");
  });
});
