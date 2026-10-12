import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRoleModelError,
  listCodexAgentRoleModels,
  readCodexAgentRoleEffort,
  removeTomlRootReasoningEffort,
  setTomlRootModel,
  setTomlRootReasoningEffort,
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

  test("an escaped quoted model key is replaced rather than duplicated", () => {
    const escaped = 'name = "r"\n"mod\\u0065l" = "old" # pinned\nkeep = 1\n';
    const next = setTomlRootModel(escaped, "new");
    expect(next).toBe('name = "r"\n"mod\\u0065l" = "new" # pinned\nkeep = 1\n');
    expect(Bun.TOML.parse(next)).toEqual({ name: "r", model: "new", keep: 1 });
    expect(setTomlRootModel("'model' = 'old'\n", "new")).toBe("'model' = 'new'\n");
  });

  test("a quoted root key that cannot be decoded refuses the write", () => {
    expect(() => setTomlRootModel('"mo\\x64el" = "old"\n', "new")).toThrow(AgentRoleModelError);
  });

  test("a multiline model value closing on extra quotes is replaced whole", () => {
    for (const pinned of ['model = """old""""\nkeep = 1\n', "model = '''old''''\nkeep = 1\n", 'model = """old"""""\nkeep = 1\n']) {
      const next = setTomlRootModel(pinned, "new");
      expect(next).toBe(pinned.startsWith("model = '") ? "model = 'new'\nkeep = 1\n" : 'model = "new"\nkeep = 1\n');
      expect(Bun.TOML.parse(next)).toEqual({ model: "new", keep: 1 });
    }
  });
});

describe("setTomlRootReasoningEffort", () => {
  const prose = IMPORTED_ROLE.replace("inside prose.", "model_reasoning_effort = \"low\" is prose too.");

  test("replaces only the root effort, not a matching line inside the instructions", () => {
    const next = setTomlRootReasoningEffort(prose, "xhigh");
    expect(next).toBe(prose.replace('model_reasoning_effort = "high"\n', 'model_reasoning_effort = "xhigh"\n'));
    expect(next).toContain('model_reasoning_effort = "low" is prose too.');
  });

  test("keeps CRLF, a BOM, a literal quote style and a trailing comment byte for byte", () => {
    const crlf = "\ufeff" + prose.replace('model_reasoning_effort = "high"', "model_reasoning_effort   =  'high' # tuned").replace(/\n/g, "\r\n");
    const next = setTomlRootReasoningEffort(crlf, "low");
    expect(next).toBe(crlf.replace("'high' # tuned", "'low' # tuned"));
    expect(setTomlRootReasoningEffort(next, "low")).toBe(next);
  });
});

describe("removeTomlRootReasoningEffort", () => {
  test("keeps a leading BOM when the effort is on line 0", () => {
    const content = '\ufeffmodel_reasoning_effort = "high"\nname = "r"\n';
    expect(removeTomlRootReasoningEffort(content)).toBe('\ufeffname = "r"\n');
    expect(removeTomlRootReasoningEffort('\ufeffmodel_reasoning_effort = "high"')).toBe('\ufeff');
  });

  test("removes the whole effort line and its comment, preserving CRLF and all other bytes", () => {
    const content = "\ufeff# rôle\r\nmodel_reasoning_effort   = 'high' # tuned\r\nname = 'r'\r\n\r\nkeep = 1";
    expect(removeTomlRootReasoningEffort(content)).toBe("\ufeff# rôle\r\nname = 'r'\r\n\r\nkeep = 1");
  });

  test("leaves an effort assignment in instructions prose untouched", () => {
    const content = 'developer_instructions = """\nmodel_reasoning_effort = "low"\n"""\nmodel_reasoning_effort = "high" # pin\n';
    expect(removeTomlRootReasoningEffort(content)).toBe('developer_instructions = """\nmodel_reasoning_effort = "low"\n"""\n');
  });

  test("leaves a nested table effort key untouched", () => {
    const nested = '[profile]\nmodel_reasoning_effort = "low"\n';
    expect(removeTomlRootReasoningEffort(nested)).toBe(nested);
    expect(removeTomlRootReasoningEffort('model_reasoning_effort = "high"\n' + nested)).toBe(nested);
  });

  test("an absent effort key is a byte-for-byte no-op", () => {
    const content = '\ufeff# model_reasoning_effort = "high"\r\nname = "r"';
    expect(removeTomlRootReasoningEffort(content)).toBe(content);
    expect(removeTomlRootReasoningEffort("")).toBe("");
  });

  test("an unterminated last effort line leaves the previous line's terminator intact", () => {
    expect(removeTomlRootReasoningEffort('model = "m"\r\nkeep = 1\r\nmodel_reasoning_effort = "high"'))
      .toBe('model = "m"\r\nkeep = 1\r\n');
    expect(removeTomlRootReasoningEffort('model = "m"\nkeep = 1\nmodel_reasoning_effort = "high" # pin'))
      .toBe('model = "m"\nkeep = 1\n');
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

  test("refuses a role file that is not valid TOML and leaves its bytes alone", () => {
    const dir = codexHome();
    const broken = 'name = "explorer"\nmodel = "old\\q"\n';
    writeFileSync(join(dir, "agents", "explorer.toml"), broken);
    let caught: unknown;
    try {
      writeCodexAgentRoleModel("explorer", "new", dir);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentRoleModelError);
    expect((caught as AgentRoleModelError).code).toBe("invalid_role_file");
    expect(readFileSync(join(dir, "agents", "explorer.toml"), "utf8")).toBe(broken);
  });

  test("writes the model and effort together and changes nothing else", () => {
    const dir = codexHome();
    expect(readCodexAgentRoleEffort("explorer", dir)).toBe("high");
    expect(writeCodexAgentRoleModel("explorer", "xai/grok-4.5", dir, "medium")).toEqual({ status: "written" });
    expect(readFileSync(join(dir, "agents", "explorer.toml"), "utf8")).toBe(IMPORTED_ROLE
      .replace('model = "gpt-5.5" # pinned', 'model = "xai/grok-4.5" # pinned')
      .replace('model_reasoning_effort = "high"', 'model_reasoning_effort = "medium"'));
    expect(readCodexAgentRoleEffort("explorer", dir)).toBe("medium");
  });

  test("refuses an unknown effort without writing the model either", () => {
    const dir = codexHome();
    for (const effort of ["turbo", "", "high\n"]) {
      expect(() => writeCodexAgentRoleModel("explorer", "xai/grok-4.5", dir, effort)).toThrow(AgentRoleModelError);
    }
    expect(readFileSync(join(dir, "agents", "explorer.toml"), "utf8")).toBe(IMPORTED_ROLE);
  });

  test.each([
    ["multiline basic", '"""\nhigh\n"""'],
    ["multiline literal", "'''\nhigh\n'''"],
    ["non-string", "5"],
  ])("refuses clearing a %s effort and leaves the file unchanged", (_kind, value) => {
    const dir = codexHome();
    const path = join(dir, "agents", "explorer.toml");
    const content = `model = "old"\nmodel_reasoning_effort = ${value}\nkeep = 1\n`;
    writeFileSync(path, content);
    const before = readFileSync(path);
    let caught: unknown;
    try {
      writeCodexAgentRoleModel("explorer", "new", dir, null);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentRoleModelError);
    expect((caught as AgentRoleModelError).code).toBe("unsupported_model_value");
    expect(readFileSync(path)).toEqual(before);
  });

  // A role without a root model pin inherits its model. An omitted model must leave it inheriting.
  const INHERITING_ROLE = IMPORTED_ROLE.replace('model = "gpt-5.5" # pinned\n', "").replace('model_reasoning_effort = "high"\n', "");

  function inheritingHome(): { dir: string; path: string } {
    const dir = codexHome();
    const path = join(dir, "agents", "explorer.toml");
    writeFileSync(path, INHERITING_ROLE);
    return { dir, path };
  }

  test("an effort without a model sets the effort and adds no model pin", () => {
    const { dir, path } = inheritingHome();
    expect(writeCodexAgentRoleModel("explorer", undefined, dir, "medium")).toEqual({ status: "written" });
    expect(readFileSync(path, "utf8")).toBe(INHERITING_ROLE.replace("# imported by Codex\n", '# imported by Codex\nmodel_reasoning_effort = "medium"\n'));
    expect(listCodexAgentRoleModels(dir)).toEqual([{ role: "explorer", model: null }]);
    expect(readCodexAgentRoleEffort("explorer", dir)).toBe("medium");
    expect(writeCodexAgentRoleModel("explorer", undefined, dir, "medium")).toEqual({ status: "unchanged" });
    expect(writeCodexAgentRoleModel("explorer", undefined, dir, "high")).toEqual({ status: "written" });
    expect(readCodexAgentRoleEffort("explorer", dir)).toBe("high");
  });

  test("a null effort without a model clears the effort and restores the original bytes", () => {
    const { dir, path } = inheritingHome();
    writeCodexAgentRoleModel("explorer", undefined, dir, "high");
    expect(writeCodexAgentRoleModel("explorer", undefined, dir, null)).toEqual({ status: "written" });
    expect(readFileSync(path, "utf8")).toBe(INHERITING_ROLE);
    expect(listCodexAgentRoleModels(dir)).toEqual([{ role: "explorer", model: null }]);
    expect(writeCodexAgentRoleModel("explorer", undefined, dir, null)).toEqual({ status: "unchanged" });
  });

  test("neither a model nor an effort leaves the file byte for byte", () => {
    const dir = codexHome();
    expect(writeCodexAgentRoleModel("explorer", undefined, dir)).toEqual({ status: "unchanged" });
    expect(readFileSync(join(dir, "agents", "explorer.toml"), "utf8")).toBe(IMPORTED_ROLE);
    expect(() => writeCodexAgentRoleModel("missing", undefined, dir, "high")).toThrow(AgentRoleModelError);
  });

  test("an effort-only write keeps the existing pin and the TOML and effort guards", () => {
    const dir = codexHome();
    expect(writeCodexAgentRoleModel("explorer", undefined, dir, "low")).toEqual({ status: "written" });
    expect(readFileSync(join(dir, "agents", "explorer.toml"), "utf8")).toBe(IMPORTED_ROLE.replace('model_reasoning_effort = "high"', 'model_reasoning_effort = "low"'));
    expect(() => writeCodexAgentRoleModel("explorer", undefined, dir, "turbo")).toThrow(AgentRoleModelError);
    const broken = 'name = "explorer"\nmodel_reasoning_effort = "old\\q"\n';
    writeFileSync(join(dir, "agents", "explorer.toml"), broken);
    expect(() => writeCodexAgentRoleModel("explorer", undefined, dir, "high")).toThrow(AgentRoleModelError);
    expect(readFileSync(join(dir, "agents", "explorer.toml"), "utf8")).toBe(broken);
  });
});
