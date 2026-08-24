import { describe, expect, test } from "bun:test";
import { createCliCoordinator } from "../../scripts/fork/sync/coordinators/cli";
import type { CommandResult, SyncEvent } from "../../scripts/fork/sync/types";

function event(kind: SyncEvent["kind"] = "pin-updated"): SyncEvent {
  return {
    kind,
    upstreamRepo: "upstream",
    latestTag: "v2.29.0",
    latestTagSha: "1111111111111111111111111111111111111111",
    vendorMainSha: "2222222222222222222222222222222222222222",
    vendorDevSha: "3333333333333333333333333333333333333333",
    detectedAt: "2026-08-22T18:00:00.000Z",
  };
}

describe("generic CLI coordinator", () => {
  test("spawns the configured command and sends the event as JSON stdin", async () => {
    let received: { args: readonly string[]; stdin: string } | undefined;
    const runner = async (args: readonly string[], stdin: string): Promise<CommandResult> => {
      received = { args, stdin };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await createCliCoordinator({
      command: "nanobot trigger fork-sync",
      runner,
    }).start(event());
    expect(received).toEqual({
      args: ["nanobot", "trigger", "fork-sync"],
      stdin: JSON.stringify(event()),
    });
  });

  test("can send a readable summary to stdin", async () => {
    let stdin = "";
    await createCliCoordinator({
      command: "hermes",
      input: "summary",
      runner: async (_args, value) => {
        stdin = value;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    }).start(event());
    expect(stdin).toContain("pin-updated");
    expect(stdin).toContain("v2.29.0");
  });

  test("spawns for all actionable lane events", async () => {
    const postedKinds: string[] = [];
    for (const kind of ["pin-updated", "main-behind", "history-diverged"] as const) {
      await createCliCoordinator({
        command: "agent trigger fork-sync",
        runner: async (_args, stdin) => {
          postedKinds.push((JSON.parse(stdin) as SyncEvent).kind);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      }).start(event(kind));
    }
    expect(postedKinds).toEqual(["pin-updated", "main-behind", "history-diverged"]);
  });

  test("does not spawn for issue-only events or without a command", async () => {
    let calls = 0;
    const runner = async (): Promise<CommandResult> => {
      calls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await createCliCoordinator({ command: "nanobot", runner }).start(event("pin-diverged"));
    await createCliCoordinator({ runner }).start(event());
    expect(calls).toBe(0);
  });

  test("throws when the command fails", async () => {
    await expect(createCliCoordinator({
      command: "zeroclaw agent -a main",
      runner: async () => ({ exitCode: 7, stdout: "", stderr: "failed" }),
    }).start(event())).rejects.toThrow("7");
  });
});
