import { describe, expect, test } from "bun:test";
import type { CommandResult, CommandRunner, SyncEvent } from "../../scripts/fork/sync/types";
import { registerCoordinator, registerNotifier } from "../../scripts/fork/sync/registry";
import { runCli } from "../../scripts/fork/sync/cli";

const TAG_SHA = "1111111111111111111111111111111111111111";
const MAIN_SHA = "2222222222222222222222222222222222222222";
const DEV_SHA = "3333333333333333333333333333333333333333";
const DEFAULT_MAIN_SHA = "4444444444444444444444444444444444444444";

function result(stdout: string, exitCode = 0, stderr = ""): CommandResult {
  return { stdout, exitCode, stderr };
}

function detectRunner(): CommandRunner {
  const results = [
    result(`${TAG_SHA} refs/tags/v2.29.0\n`),
    result(MAIN_SHA),
    result(DEV_SHA),
    result(""),
    result("", 1),
    result(""),
    result("", 1),
    result("base-sha\n"),
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
    expect(event.recommendedLane).toBe("daily-merge");
  });

  test("reclassifies an already-current event as main-behind", async () => {
    const output: string[] = [];
    const results = [
      result(`${TAG_SHA} refs/tags/v2.29.0\n`),
      result(TAG_SHA),
      result(DEV_SHA),
      result(""),
      result("", 1),
      result("base-sha\n"),
    ];

    await runCli(["detect"], {
      env: { FORK_SYNC_UPSTREAM_REPO: "upstream" },
      runner: async args => {
        return results.shift() ?? result("", 1, `unexpected command: ${args.join(" ")}`);
      },
      write: value => output.push(value),
    });

    const event = JSON.parse(output[0]!) as SyncEvent;
    expect(event.kind).toBe("main-behind");
    expect(event.vendorContainedInMain).toBe(false);
    expect(event.mergeBaseCount).toBe(1);
    expect(event.recommendedLane).toBe("daily-merge");
  });

  test("reclassifies an already-current event as a contained no-op", async () => {
    const calls: string[][] = [];
    const output: string[] = [];
    const results = [
      result(`${TAG_SHA} refs/tags/v2.29.0\n`),
      result(TAG_SHA),
      result(DEV_SHA),
      result(""),
      result(TAG_SHA),
      result("base-sha\n"),
    ];

    await runCli(["detect"], {
      env: { FORK_SYNC_UPSTREAM_REPO: "upstream" },
      runner: async args => {
        calls.push([...args]);
        return results.shift() ?? result("", 1, "unexpected command");
      },
      write: value => output.push(value),
    });

    const event = JSON.parse(output[0]!) as SyncEvent;
    expect(event.kind).toBe("already-current");
    expect(event.vendorContainedInMain).toBe(true);
    expect(event.mergeBaseCount).toBe(1);
    expect(event.recommendedLane).toBe("noop");
    expect(calls).toEqual([
      ["ls-remote", "--tags", "--refs", "upstream", "v*"],
      ["rev-parse", "refs/heads/vendor/main"],
      ["rev-parse", "refs/heads/vendor/dev"],
      ["merge-base", "--is-ancestor", TAG_SHA, "refs/remotes/upstream/main"],
      ["merge-base", "--is-ancestor", TAG_SHA, "HEAD"],
      ["merge-base", "--all", "HEAD", TAG_SHA],
    ]);
  });

  test("reclassifies multiple main merge bases as history-diverged", async () => {
    const output: string[] = [];
    const results = [
      result(`${TAG_SHA} refs/tags/v2.29.0\n`),
      result(TAG_SHA),
      result(DEV_SHA),
      result(""),
      result("", 1),
      result("base-a\nbase-b\n"),
    ];

    await runCli(["detect"], {
      env: { FORK_SYNC_UPSTREAM_REPO: "upstream" },
      runner: async () => results.shift() ?? result("", 1, "unexpected command"),
      write: value => output.push(value),
    });

    const event = JSON.parse(output[0]!) as SyncEvent;
    expect(event.kind).toBe("history-diverged");
    expect(event.mergeBaseCount).toBe(2);
    expect(event.recommendedLane).toBe("emergency-rebuild");
  });

  test("reclassifies a disconnected already-current event as history-diverged", async () => {
    const output: string[] = [];
    const results = [
      result(`${TAG_SHA} refs/tags/v2.29.0\n`),
      result(TAG_SHA),
      result(DEV_SHA),
      result(""),
      result("", 1),
      result(""),
    ];

    await runCli(["detect"], {
      env: { FORK_SYNC_UPSTREAM_REPO: "upstream" },
      runner: async () => results.shift() ?? result("", 1, "unexpected command"),
      write: value => output.push(value),
    });

    const event = JSON.parse(output[0]!) as SyncEvent;
    expect(event.kind).toBe("history-diverged");
    expect(event.mergeBaseCount).toBe(0);
    expect(event.recommendedLane).toBe("emergency-rebuild");
  });

  test("pin dispatches detection and both ff-only updates", async () => {
    const calls: string[][] = [];
    const output: string[] = [];
    const results = [
      result(`${TAG_SHA} refs/tags/v2.29.0\n`),
      result(MAIN_SHA),
      result(DEV_SHA),
      result(""),
      result("", 1),
      result(""),
      result(DEFAULT_MAIN_SHA),
      result(""),
      result(""),
      result(TAG_SHA),
      result(""),
      result(""),
      result(DEV_SHA),
      result("", 1),
      result("base-sha\n"),
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
    expect(calls).toEqual([
      ["ls-remote", "--tags", "--refs", "upstream", "v*"],
      ["rev-parse", "refs/heads/vendor/main"],
      ["rev-parse", "refs/heads/vendor/dev"],
      ["merge-base", "--is-ancestor", TAG_SHA, "refs/remotes/upstream/main"],
      ["merge-base", "--is-ancestor", TAG_SHA, MAIN_SHA],
      ["merge-base", "--is-ancestor", MAIN_SHA, TAG_SHA],
      ["rev-parse", "HEAD"],
      ["switch", "vendor/main"],
      ["merge", "--ff-only", TAG_SHA],
      ["rev-parse", "refs/heads/vendor/main"],
      ["switch", "vendor/dev"],
      ["merge", "--ff-only", "refs/remotes/upstream/dev"],
      ["rev-parse", "refs/heads/vendor/dev"],
      ["merge-base", "--is-ancestor", TAG_SHA, DEFAULT_MAIN_SHA],
      ["merge-base", "--all", DEFAULT_MAIN_SHA, TAG_SHA],
    ]);
    const event = JSON.parse(output[0]!) as SyncEvent;
    expect(event.kind).toBe("pin-updated");
    expect(event.recommendedLane).toBe("daily-merge");
  });

  test("keeps a pin-diverged event unchanged after lane annotation", async () => {
    const output: string[] = [];
    const results = [
      result(`${TAG_SHA} refs/tags/v2.29.0\n`),
      result(MAIN_SHA),
      result(DEV_SHA),
      result(""),
      result("", 1),
      result("", 1),
      result(DEFAULT_MAIN_SHA),
      result("", 1),
      result("base-sha\n"),
    ];

    await runCli(["pin"], {
      env: { FORK_SYNC_UPSTREAM_REPO: "upstream" },
      runner: async () => results.shift() ?? result("", 1, "unexpected command"),
      write: value => output.push(value),
    });

    const event = JSON.parse(output[0]!) as SyncEvent;
    expect(event.kind).toBe("pin-diverged");
    expect(event.mergeBaseCount).toBe(1);
    expect(event.recommendedLane).toBeUndefined();
  });

  test("keeps a detect failure with no vendor main unchanged", async () => {
    const calls: string[][] = [];
    const output: string[] = [];
    await runCli(["pin"], {
      env: { FORK_SYNC_UPSTREAM_REPO: "upstream" },
      runner: async args => {
        calls.push([...args]);
        if (calls.length === 1) return result(`${TAG_SHA} refs/tags/v2.29.0\n`);
        return result("", 1, "missing vendor/main");
      },
      write: value => output.push(value),
    });

    const event = JSON.parse(output[0]!) as SyncEvent;
    expect(event.kind).toBe("detect-failed");
    expect(event.vendorMainSha).toBe("");
    expect(event.vendorContainedInMain).toBeUndefined();
    expect(event.mergeBaseCount).toBeUndefined();
    expect(calls).toEqual([
      ["ls-remote", "--tags", "--refs", "upstream", "v*"],
      ["rev-parse", "refs/heads/vendor/main"],
    ]);
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

  test("emit configures generic coordinators from environment", async () => {
    let received: { args: readonly string[]; stdin: string } | undefined;
    const event: SyncEvent = {
      kind: "pin-updated",
      upstreamRepo: "upstream",
      latestTag: "v2.29.0",
      latestTagSha: TAG_SHA,
      vendorMainSha: MAIN_SHA,
      vendorDevSha: DEV_SHA,
      detectedAt: "2026-08-22T18:00:00.000Z",
    };
    await runCli(["emit"], {
      env: {
        FORK_SYNC_COORDINATORS: "cli",
        FORK_SYNC_CLI_COMMAND: "nanobot trigger fork-sync",
      },
      stdin: JSON.stringify(event),
      processRunner: async (args, stdin) => {
        received = { args, stdin };
        return result("");
      },
    });
    expect(received).toEqual({
      args: ["nanobot", "trigger", "fork-sync"],
      stdin: JSON.stringify(event),
    });
  });

  test("emit still starts coordinators when a notifier fails", async () => {
    const started: string[] = [];
    registerNotifier({
      id: "failing-notifier",
      async notify() {
        throw new Error("GitHub issues request returned HTTP 410");
      },
    });
    registerCoordinator({
      id: "surviving-coordinator",
      async start() {
        started.push("started");
      },
    });
    const event: SyncEvent = {
      kind: "pin-updated",
      upstreamRepo: "upstream",
      latestTag: "v2.29.0",
      latestTagSha: TAG_SHA,
      vendorMainSha: MAIN_SHA,
      vendorDevSha: DEV_SHA,
      detectedAt: "2026-08-22T18:00:00.000Z",
    };
    await expect(runCli(["emit"], {
      env: {
        FORK_SYNC_NOTIFIERS: "failing-notifier",
        FORK_SYNC_COORDINATORS: "surviving-coordinator",
      },
      stdin: JSON.stringify(event),
    })).rejects.toThrow("HTTP 410");
    expect(started).toEqual(["started"]);
  });

  test("rejects unknown commands", async () => {
    await expect(runCli(["unknown"], { write: () => {} }))
      .rejects.toThrow("usage");
  });
});
