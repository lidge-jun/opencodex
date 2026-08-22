import { describe, expect, test } from "bun:test";
import type { CommandResult, CommandRunner } from "../../scripts/fork/sync/types";
import {
  isAncestor,
  uncontained,
} from "../../scripts/fork/sync/contained";

function result(
  exitCode = 0,
  stdout = "",
  stderr = "",
): CommandResult {
  return { exitCode, stdout, stderr };
}

function queuedRunner(
  results: CommandResult[],
  calls: string[][],
): CommandRunner {
  return async args => {
    calls.push([...args]);
    return results.shift() ?? result(1, "", "unexpected command");
  };
}

describe("fork sync containment", () => {
  test("reports a commit contained by a ref", async () => {
    const calls: string[][] = [];

    const contained = await isAncestor(
      queuedRunner([result()], calls),
      "commit-a",
      "main",
    );

    expect(contained).toBe(true);
    expect(calls).toEqual([
      ["merge-base", "--is-ancestor", "commit-a", "main"],
    ]);
  });

  test("reports a commit that is not contained by a ref", async () => {
    const contained = await isAncestor(
      queuedRunner([result(1)], []),
      "commit-a",
      "main",
    );

    expect(contained).toBe(false);
  });

  test("returns only commits that are not contained, preserving order", async () => {
    const calls: string[][] = [];

    const commits = await uncontained(
      queuedRunner([result(), result(1), result(1)], calls),
      ["commit-a", "commit-b", "commit-c"],
      "main",
    );

    expect(commits).toEqual(["commit-b", "commit-c"]);
    expect(calls).toEqual([
      ["merge-base", "--is-ancestor", "commit-a", "main"],
      ["merge-base", "--is-ancestor", "commit-b", "main"],
      ["merge-base", "--is-ancestor", "commit-c", "main"],
    ]);
  });

  test("rejects unexpected git failures", async () => {
    await expect(
      isAncestor(
        queuedRunner([result(2, "", "fatal: invalid revision")], []),
        "commit-a",
        "main",
      ),
    ).rejects.toThrow("fatal: invalid revision");
  });
});
