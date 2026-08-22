import { describe, expect, test } from "bun:test";
import type { CommandResult, CommandRunner, SyncEvent } from "../../scripts/fork/sync/types";
import { registerCoordinator, registerNotifier } from "../../scripts/fork/sync/registry";
import { runCli } from "../../scripts/fork/sync/cli";

const TAG_SHA = "1111111111111111111111111111111111111111";
const MAIN_SHA = "2222222222222222222222222222222222222222";
const DEV_SHA = "3333333333333333333333333333333333333333";

function result(stdout: string, exitCode = 0, stderr = ""): CommandResult {
  return { stdout, exitCode, stderr };
}

function detectRunner(): CommandRunner {
  const results = [
    result(`${TAG_SHA} refs/tags/v2.29.0\n`),
    result(MAIN_SHA),
    result(DEV_SHA),
    result(""),
    result(""),
  ];
  return async () => results.shift() ?? result("", 1, "unexpected command");
}

describe("fork sync CLI", () => {
  test("detect prints a JSON event", async () => {
    const output: string[] = [];
    await runCli(["detect"], {
      env: { FORK_SYNC_UPSTREAM_REPO: "upstream" },
      runner: detectRunner(),
      write: value => output.push(value),
    });
    const event = JSON.parse(output[0]!) as SyncEvent;
    expect(event.kind).toBe("pin-updated");
    expect(event.latestTag).toBe("v2.29.0");
  });

  test("pin dispatches detection and both ff-only updates", async () => {
    const calls: string[][] = [];
    const output: string[] = [];
    const results = [
      result(`${TAG_SHA} refs/tags/v2.29.0\n`),
      result(MAIN_SHA),
      result(DEV_SHA),
      result(""),
      result(""),
      result(""),
      result(TAG_SHA),
      result(""),
      result(""),
      result(DEV_SHA),
      result(DEV_SHA),
    ];
    await runCli(["pin"], {
      env: { FORK_SYNC_UPSTREAM_REPO: "upstream" },
      runner: async args => {
        calls.push([...args]);
        return results.shift() ?? result("", 1, "unexpected command");
      },
      write: value => output.push(value),
    });
    expect(calls).toContainEqual(["merge", "--ff-only", TAG_SHA]);
    expect(calls).toContainEqual(["merge", "--ff-only", "refs/remotes/upstream/dev"]);
    expect((JSON.parse(output[0]!) as SyncEvent).kind).toBe("pin-updated");
  });

  test("emit selects env-registered plugins and never prints secret values", async () => {
    const seen: SyncEvent[] = [];
    const notifier = {
      id: "cli-notifier-test",
      async notify(event: SyncEvent) {
        seen.push(event);
      },
    };
    const coordinator = {
      id: "cli-coordinator-test",
      async start(event: SyncEvent) {
        seen.push(event);
      },
    };
    registerNotifier(notifier);
    registerCoordinator(coordinator);
    const event: SyncEvent = {
      kind: "pin-updated",
      upstreamRepo: "upstream",
      latestTag: "v2.29.0",
      latestTagSha: TAG_SHA,
      vendorMainSha: MAIN_SHA,
      vendorDevSha: DEV_SHA,
      detectedAt: "2026-08-22T18:00:00.000Z",
    };
    const output: string[] = [];
    await runCli(["emit"], {
      env: {
        FORK_SYNC_NOTIFIERS: "cli-notifier-test",
        FORK_SYNC_COORDINATORS: "cli-coordinator-test",
        FORK_SYNC_CURSOR_WEBHOOK_SECRET: "never-print-this",
      },
      stdin: JSON.stringify(event),
      write: value => output.push(value),
    });
    expect(seen).toEqual([event, event]);
    expect(output.join("")).not.toContain("never-print-this");
  });

  test("rejects unknown commands", async () => {
    await expect(runCli(["unknown"], { write: () => {} }))
      .rejects.toThrow("usage");
  });
});
