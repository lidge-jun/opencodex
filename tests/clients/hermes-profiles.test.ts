import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hermesHomeDir } from "../../src/clients/config-export";
import { hermesRootDir, listHermesProfiles, resolveHermesProfile } from "../../src/integrations/hermes-profiles";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/** Root derivation mirrors Hermes _hermes_root_of (NousResearch/hermes-agent hermes_constants.py). */
let base = "";
let home = "";
const native = () => hermesHomeDir({}, home);

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ocx-hermes-root-"));
  home = join(base, "home");
  mkdirSync(home, { recursive: true });
});

afterEach(() => removeTreeWithRetry(base));

describe("hermesRootDir", () => {
  test("no override and an override inside the platform home both mean the platform home", () => {
    expect(hermesRootDir({}, home)).toBe(native());
    expect(hermesRootDir({ HERMES_HOME: join(native(), "profiles", "coder") }, home)).toBe(native());
  });

  test("<root>/profiles/<name> names <root>; any other override is its own root", () => {
    const custom = join(base, "data", "hermes");
    expect(hermesRootDir({ HERMES_HOME: join(custom, "profiles", "coder") }, home)).toBe(custom);
    expect(hermesRootDir({ HERMES_HOME: custom }, home)).toBe(custom);
  });

  test.if(process.platform === "win32")("Windows uses %LOCALAPPDATA%\\hermes as the platform home", () => {
    const local = join(base, "LocalAppData");
    expect(hermesRootDir({ LOCALAPPDATA: local }, home)).toBe(join(local, "hermes"));
  });
});

describe("listHermesProfiles", () => {
  test("HERMES_HOME pointed at a profile makes it the default target and keeps its siblings", () => {
    for (const name of ["coder", "writer"]) {
      mkdirSync(join(native(), "profiles", name), { recursive: true });
      writeFileSync(join(native(), "profiles", name, "config.yaml"), "x: 1\n");
    }
    const env = { HERMES_HOME: join(native(), "profiles", "coder") };
    expect(listHermesProfiles(env, home).map(row => [row.name, row.home])).toEqual([
      ["default", join(native(), "profiles", "coder")],
      ["writer", join(native(), "profiles", "writer")],
    ]);
    expect(() => resolveHermesProfile("coder", env, home)).toThrow();
    expect(resolveHermesProfile("writer", env, home).configPath).toBe(join(native(), "profiles", "writer", "config.yaml"));
  });

  test("a missing Hermes home lists only the default profile", () => {
    expect(listHermesProfiles({}, home).map(row => row.name)).toEqual(["default"]);
  });
});
