import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRoleModelError,
  listCodexAgentRoleModels,
  setTomlRootModel,
  writeCodexAgentRoleModel,
} from "../../src/codex/agent-role-models";

const IMPORTED_ROLE = [
  "# imported by Codex",
  'name = "explorer"',
  'developer_instructions = """',
  "Never trust a line like",
  'model = "x"',
  "inside prose.",
  '"""',
  'model = "gpt-5.5" # pinned',
  'model_reasoning_effort = "high"',
  "",
].join("\n");

describe("setTomlRootModel", () => {
  test("replaces only the root value, leaving the instructions string untouched", () => {
    const next = setTomlRootModel(IMPORTED_ROLE, "anthropic/claude-sonnet-5");
    expect(next).toBe(IMPORTED_ROLE.replace('model = "gpt-5.5" # pinned', 'model = "anthropic/claude-sonnet-5" # pinned'));
  });

  test("inserts a missing key after the leading comments, with the file's CRLF", () => {
    const unpinned = IMPORTED_ROLE.replace('model = "gpt-5.5" # pinned\n', "").replace(/\n/g, "\r\n");
    const next = setTomlRootModel(unpinned, "gpt-5.6-sol");
    expect(next).toBe(unpinned.replace("# imported by Codex\r\n", '# imported by Codex\r\nmodel = "gpt-5.6-sol"\r\n'));
    expect(setTomlRootModel(next, "gpt-5.6-sol")).toBe(next);
  });

  test("keeps a literal-string pin literal and preserves spacing", () => {
    expect(setTomlRootModel("model   =   'a' \n", "b")).toBe("model   =   'b' \n");
    expect(setTomlRootModel("model = 'a'\n", "it's")).toBe('model = "it\'s"\n');
  });

  test("a model key under a table is not the root pin", () => {
    const tabled = '[profile]\nmodel = "inner"\n';
    expect(setTomlRootModel(tabled, "outer")).toBe(`model = "outer"\n${tabled}`);
  });

  test("a leading BOM stays at byte 0", () => {
    expect(setTomlRootModel('\ufeffname = "r"\n', "m")).toBe('\ufeffmodel = "m"\nname = "r"\n');
  });

  test("a non-string model value is refused rather than duplicated", () => {
    expect(() => setTomlRootModel("model = 5\n", "m")).toThrow(AgentRoleModelError);
  });
});

describe("writeCodexAgentRoleModel", () => {
  let home: string | null = null;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = null;
  });

  function codexHome(): string {
    home = mkdtempSync(join(tmpdir(), "ocx-agent-roles-"));
    mkdirSync(join(home, "agents"));
    writeFileSync(join(home, "agents", "explorer.toml"), IMPORTED_ROLE);
    writeFileSync(join(home, "outside.toml"), 'model = "keep"\n');
    return home;
  }

  test("writes the pin and reports it back through the listing", () => {
    const dir = codexHome();
    expect(writeCodexAgentRoleModel("explorer", " xai/grok-4.5 ", dir)).toEqual({ status: "written" });
    expect(listCodexAgentRoleModels(dir)).toEqual([{ role: "explorer", model: "xai/grok-4.5" }]);
    expect(writeCodexAgentRoleModel("explorer", "xai/grok-4.5", dir)).toEqual({ status: "unchanged" });
  });

  test("refuses a role that is not a listed file, including traversal", () => {
    const dir = codexHome();
    for (const role of ["../outside", "missing", "agents/explorer"]) {
      expect(() => writeCodexAgentRoleModel(role, "m", dir)).toThrow(AgentRoleModelError);
    }
    expect(readFileSync(join(dir, "outside.toml"), "utf8")).toBe('model = "keep"\n');
  });

  test("refuses an empty or multi-line model without touching the file", () => {
    const dir = codexHome();
    for (const model of ["", "a\nb", 5]) {
      expect(() => writeCodexAgentRoleModel("explorer", model as string, dir)).toThrow(AgentRoleModelError);
    }
    expect(readFileSync(join(dir, "agents", "explorer.toml"), "utf8")).toBe(IMPORTED_ROLE);
  });
});
