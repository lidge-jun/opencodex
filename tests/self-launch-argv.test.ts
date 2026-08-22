import { describe, expect, test } from "bun:test";
import { selfLaunchArgv } from "../src/lib/self-launch-argv";

describe("selfLaunchArgv", () => {
  test("uses command arguments directly for a standalone executable", () => {
    const args = ["start", "--port", "10100"];

    expect(selfLaunchArgv(args, {
      isStandaloneExecutable: true,
      sourceEntrypoint: "/repo/src/cli/index.ts",
    })).toEqual(["start", "--port", "10100"]);
    expect(args).toEqual(["start", "--port", "10100"]);
  });

  test("prepends the source entrypoint outside a standalone executable", () => {
    expect(selfLaunchArgv(["stop"], {
      isStandaloneExecutable: false,
      sourceEntrypoint: "/repo/src/cli/index.ts",
    })).toEqual(["/repo/src/cli/index.ts", "stop"]);
  });
});
