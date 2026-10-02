import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { omoJsoncPath, readOmoRoleModels, writeOmoRoleModel } from "../../src/clients/omo-role-models";
import { hasJsoncComments } from "../../src/lib/jsonc";

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function file(text?: string): string {
  dir = mkdtempSync(join(tmpdir(), "ocx-omo-roles-"));
  const path = join(dir, "omo.jsonc");
  if (text !== undefined) writeFileSync(path, text);
  return path;
}

describe("omo role models", () => {
  test("writes codex.agents.<role>.model and keeps sibling keys and indentation", () => {
    const path = file('{\n    "agents": { "sisyphus": { "model": "a" } },\n    "codex": { "agents": { "explorer": { "reasoningEffort": "high" } } }\n}\n');
    expect(writeOmoRoleModel("explorer", "gpt-5.6-sol", path)).toBe("written");
    const written = readFileSync(path, "utf8");
    expect(JSON.parse(written)).toEqual({
      agents: { sisyphus: { model: "a" } },
      codex: { agents: { explorer: { reasoningEffort: "high", model: "gpt-5.6-sol" } } },
    });
    expect(written.startsWith('{\n    "agents"')).toBe(true);
    expect(written.endsWith("}\n")).toBe(true);
    expect(readOmoRoleModels(path)).toEqual({ state: "present", models: { explorer: "gpt-5.6-sol" } });
    expect(writeOmoRoleModel("explorer", "gpt-5.6-sol", path)).toBe("unchanged");
  });

  test("creates the codex block in a file that has none", () => {
    const path = file("{}");
    expect(writeOmoRoleModel("librarian", "m", path)).toBe("written");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ codex: { agents: { librarian: { model: "m" } } } });
  });

  test("a file with comments is reported and left byte for byte", () => {
    const text = '{\n  // pick carefully\n  "codex": {}\n}\n';
    const path = file(text);
    expect(writeOmoRoleModel("explorer", "m", path)).toBe("skipped_comments");
    expect(readOmoRoleModels(path)).toEqual({ state: "comments" });
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  test("a missing file is reported absent and not created", () => {
    const path = file();
    expect(writeOmoRoleModel("explorer", "m", path)).toBe("absent");
    expect(readOmoRoleModels(path)).toEqual({ state: "absent" });
    expect(() => readFileSync(path)).toThrow();
  });

  test("a codex value of the wrong shape is invalid rather than overwritten", () => {
    const text = '{ "codex": { "agents": ["explorer"] } }';
    const path = file(text);
    expect(writeOmoRoleModel("explorer", "m", path)).toBe("invalid");
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  test("an explicit null codex, agents, or role entry is invalid and left byte for byte", () => {
    for (const text of ['{ "codex": null }', '{ "codex": { "agents": null } }', '{ "codex": { "agents": { "explorer": null } } }']) {
      const path = file(text);
      expect(writeOmoRoleModel("explorer", "m", path)).toBe("invalid");
      expect(readFileSync(path, "utf8")).toBe(text);
      rmSync(dir!, { recursive: true, force: true });
    }
  });

  test("an unreadable file reads as unreadable, and the write still reports the failure", () => {
    const path = file('{ "codex": {} }');
    const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const spy = spyOn(fs, "readFileSync").mockImplementation((() => { throw denied; }) as never);
    try {
      expect(readOmoRoleModels(path)).toEqual({ state: "unreadable" });
      expect(() => writeOmoRoleModel("explorer", "m", path)).toThrow("EACCES");
    } finally {
      spy.mockRestore();
    }
  });

  test("comment detection ignores comment markers inside strings", () => {
    expect(hasJsoncComments('{ "url": "https://example.com/*x*/" }')).toBe(false);
    expect(hasJsoncComments('{ "a": 1 /* note */ }')).toBe(true);
    expect(hasJsoncComments('{ "a": 1 /* open')).toBe(true);
  });

  test("the path follows HOME before USERPROFILE", () => {
    expect(omoJsoncPath({ HOME: "/h", USERPROFILE: "/u" }, "/os")).toBe(join("/h", ".omo", "omo.jsonc"));
    expect(omoJsoncPath({ USERPROFILE: "/u" }, "/os")).toBe(join("/u", ".omo", "omo.jsonc"));
    expect(omoJsoncPath({}, "/os")).toBe(join("/os", ".omo", "omo.jsonc"));
  });
});
