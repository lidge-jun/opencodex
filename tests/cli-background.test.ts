import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli.ts");

describe("CLI background flag", () => {
  test("start --help advertises --background option", () => {
    const result = spawnSync(process.execPath, [cliPath, "start", "--help"], {
      cwd: repoRoot,
      env: { ...process.env },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[-b|--background]");
    expect(result.stdout).toContain("Use --background to detach from the terminal");
    expect(result.stderr).toBe("");
  });

  test("main help advertises background flag for start", () => {
    const result = spawnSync(process.execPath, [cliPath, "--help"], {
      cwd: repoRoot,
      env: { ...process.env },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ocx start [--port <port>] [-b|--background]");
    expect(result.stderr).toBe("");
  });
});
