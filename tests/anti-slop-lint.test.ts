import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const guiDir = join(repoRoot, "gui");

describe("anti-slop lint contract", () => {
  test("runtime source and scripts have no error-level anti-slop findings", () => {
    const result = spawnSync("bun", ["run", "lint:core"], {
      cwd: guiDir,
      encoding: "utf8",
      env: {
        ...process.env,
        NO_COLOR: "1",
      },
    });

    if (result.error) throw result.error;
    if (result.status !== 0) {
      console.error(result.stdout);
      console.error(result.stderr);
    }

    expect(result.status).toBe(0);
  });
});
