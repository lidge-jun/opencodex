import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const guiDir = join(repoRoot, "gui");
const rootConfig = join(repoRoot, ".oxlintrc.json");

function runOxlint(path: string) {
  return spawnSync("bun", ["x", "oxlint", path, "--config", rootConfig], {
    cwd: guiDir,
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
  });
}

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

  test("Reflect escape hatches fail while a shadowed local API does not", () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "ocx-anti-slop-"));
    try {
      const globalReflect = join(fixtureDir, "global-reflect.ts");
      const localReflect = join(fixtureDir, "local-reflect.ts");
      writeFileSync(globalReflect, "export const read = (value: object) => Reflect.get(value, 'x');\n");
      writeFileSync(
        localReflect,
        "export const read = (Reflect: { get(value: object, key: string): unknown }, value: object) => Reflect.get(value, 'x');\n",
      );

      const rejected = runOxlint(globalReflect);
      if (rejected.error) throw rejected.error;
      expect(rejected.status).not.toBe(0);

      const accepted = runOxlint(localReflect);
      if (accepted.error) throw accepted.error;
      if (accepted.status !== 0) {
        console.error(accepted.stdout);
        console.error(accepted.stderr);
      }
      expect(accepted.status).toBe(0);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
