import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

// The routing-profile config types moved out of src/types/config.ts to keep it under the
// file-size ratchet. Every import site still reads them through config.ts (and src/types.ts),
// so config.ts must keep re-exporting the full set and must not grow a second declaration.
const moduleSource = readFileSync(repoPath("src/types/routing-profile.ts"), "utf8");
const configSource = readFileSync(repoPath("src/types/config.ts"), "utf8");

const declaredNames = [...moduleSource.matchAll(/^export (?:interface|type) (\w+)/gm)].map((match) => match[1]!);

function reExportedNames(): string[] {
  const block = configSource.match(/export type \{([^}]*)\} from "\.\/routing-profile";/);
  if (!block) return [];
  return block[1]!.split(",").map((name) => name.trim()).filter(Boolean);
}

describe("routing-profile config types", () => {
  test("config.ts re-exports every declaration from routing-profile.ts", () => {
    expect(declaredNames.length).toBeGreaterThan(0);
    expect(reExportedNames().sort()).toEqual([...declaredNames].sort());
  });

  test("config.ts does not declare a second copy of any moved type", () => {
    for (const name of declaredNames) {
      expect(configSource).not.toMatch(new RegExp(`^export (?:interface|type) ${name}\\b`, "m"));
    }
  });

  test("routing-profile.ts stays self-contained", () => {
    expect(moduleSource).not.toMatch(/^import /m);
  });
});
