import { describe, expect, test } from "bun:test";
import {
  MANAGED_AGENTS_TABLE_MARKER,
  MANAGED_SUBAGENT_DEFAULT_MARKER,
  transformManagedSubagentDefaults,
} from "../src/codex/subagent-defaults";

function apply(content: string, model = "openai/gpt-5.6-sol", reasoningEffort?: string) {
  return transformManagedSubagentDefaults(content, { model, reasoningEffort });
}

describe("managed native subagent defaults TOML transform", () => {
  test("creates an owned [agents] table and TOML-escapes supplied strings", () => {
    const input = 'model = "gpt-5.6"\n';
    const result = apply(input, 'provider/a"b\\c\nnext\u007f', "xhigh");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conflicts).toEqual([]);
    expect(result.content).toBe([
      'model = "gpt-5.6"',
      MANAGED_AGENTS_TABLE_MARKER,
      "[agents]",
      MANAGED_SUBAGENT_DEFAULT_MARKER,
      'default_subagent_model = "provider/a\\"b\\\\c\\nnext\\u007F"',
      MANAGED_SUBAGENT_DEFAULT_MARKER,
      'default_subagent_reasoning_effort = "xhigh"',
      "",
    ].join("\n"));
    expect((Bun.TOML.parse(result.content).agents as Record<string, unknown>).default_subagent_model)
      .toBe('provider/a"b\\c\nnext\u007f');
    expect(apply(result.content, 'provider/a"b\\c\nnext\u007f', "xhigh")).toEqual({
      ok: true,
      changed: false,
      content: result.content,
      conflicts: [],
    });
  });

  test("updates only marked values while preserving comments, siblings, and table order", () => {
    const input = [
      "# before",
      "[agents] # native settings",
      "max_threads = 12 # user",
      MANAGED_SUBAGENT_DEFAULT_MARKER,
      "default_subagent_model = 'old/model' # keep this comment",
      "custom = { nested = true }",
      "",
      "[notice]",
      "hide = false",
      "",
    ].join("\n");
    const result = apply(input, "new/model");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain('default_subagent_model = "new/model" # keep this comment');
    expect(result.content).toContain("max_threads = 12 # user\n");
    expect(result.content).toContain("custom = { nested = true }\n\n[notice]\nhide = false\n");
    expect(result.content).not.toContain("default_subagent_reasoning_effort");
  });

  test("preserves CRLF on insertion and update", () => {
    const input = `[agents]\r\n${MANAGED_SUBAGENT_DEFAULT_MARKER}\r\ndefault_subagent_model = "old"\r\nmax_threads = 4\r\n`;
    const result = apply(input, "new", "high");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain('default_subagent_model = "new"\r\n');
    expect(result.content).toContain('default_subagent_reasoning_effort = "high"\r\n');
    expect(result.content).not.toMatch(/[^\r]\n/);
  });

  test("omitting effort removes only a marked effort and leaves an unmarked sibling", () => {
    const input = [
      "[agents]",
      MANAGED_SUBAGENT_DEFAULT_MARKER,
      'default_subagent_model = "old"',
      MANAGED_SUBAGENT_DEFAULT_MARKER,
      'default_subagent_reasoning_effort = "high" # owned',
      "max_depth = 3 # user",
      "",
    ].join("\n");
    const result = apply(input, "new");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).not.toContain("default_subagent_reasoning_effort");
    expect(result.content).toContain("max_depth = 3 # user");
  });

  test("reports unmarked target keys as conflicts without overwriting them", () => {
    const input = '[agents]\ndefault_subagent_model = "user/model" # user-owned\nmax_threads = 8\n';
    const result = apply(input, "managed/model", "medium");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conflicts).toEqual([
      { key: "default_subagent_model", line: 2, reason: "user-owned" },
    ]);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(input);
  });

  test("an effort conflict also prevents updating the managed model half", () => {
    const input = [
      "[agents]",
      MANAGED_SUBAGENT_DEFAULT_MARKER,
      'default_subagent_model = "old/managed"',
      'default_subagent_reasoning_effort = "user-effort"',
      "",
    ].join("\n");
    const result = apply(input, "new/managed", "high");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result).toEqual({
      ok: true,
      changed: false,
      content: input,
      conflicts: [
        { key: "default_subagent_reasoning_effort", line: 4, reason: "user-owned" },
      ],
    });
  });

  test("clear removes owned pairs but preserves user-owned targets", () => {
    const input = [
      "[agents]",
      MANAGED_SUBAGENT_DEFAULT_MARKER,
      'default_subagent_model = "managed/model"',
      'default_subagent_reasoning_effort = "user-effort" # user-owned',
      "max_threads = 8",
      "",
    ].join("\n");
    const result = transformManagedSubagentDefaults(input, null);
    expect(result).toEqual({
      ok: true,
      changed: true,
      content: '[agents]\ndefault_subagent_reasoning_effort = "user-effort" # user-owned\nmax_threads = 8\n',
      conflicts: [],
    });
  });

  test("clear ignores unsupported user-owned shapes when no managed marker exists", () => {
    const input = [
      'agents = { default_subagent_model = "user/model" }',
      'message = """',
      MANAGED_SUBAGENT_DEFAULT_MARKER,
      "[agents]",
      'default_subagent_model = "string/data"',
      '"""',
      "",
    ].join("\n");
    expect(transformManagedSubagentDefaults(input, null)).toEqual({
      ok: true,
      changed: false,
      content: input,
      conflicts: [],
    });
  });

  test("clear removes an empty marker-owned table and is idempotent", () => {
    const enabled = apply("");
    expect(enabled.ok).toBe(true);
    if (!enabled.ok) return;
    const cleared = transformManagedSubagentDefaults(enabled.content, null);
    expect(cleared).toEqual({ ok: true, changed: true, content: "", conflicts: [] });
    expect(transformManagedSubagentDefaults(cleared.content, null)).toEqual({
      ok: true,
      changed: false,
      content: "",
      conflicts: [],
    });
  });

  test("a marker-owned table with unknown content survives clear", () => {
    const input = [
      MANAGED_AGENTS_TABLE_MARKER,
      "[agents]",
      MANAGED_SUBAGENT_DEFAULT_MARKER,
      'default_subagent_model = "managed/model"',
      "max_threads = 7 # user extension",
      "",
    ].join("\n");
    const result = transformManagedSubagentDefaults(input, null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe("[agents]\nmax_threads = 7 # user extension\n");
    expect(result.content).not.toContain(MANAGED_AGENTS_TABLE_MARKER);
  });

  test("inserts a base table before nested custom-role tables and preserves them", () => {
    const input = [
      'model = "gpt-5.6"',
      "",
      "[agents.reviewer] # custom role",
      'description = "review only"',
      "",
      '[agents."executor"]',
      'description = "execute"',
      "",
    ].join("\n");
    const result = apply(input, "managed/model", "high");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content.indexOf("[agents]")).toBeLessThan(result.content.indexOf("[agents.reviewer]"));
    expect(result.content).toContain('[agents.reviewer] # custom role\ndescription = "review only"');
    expect(result.content).toContain('[agents."executor"]\ndescription = "execute"');
    expect(apply(result.content, "managed/model", "high").changed).toBe(false);
  });

  test("supports quoted canonical table and key names", () => {
    const input = `["agents"]\n${MANAGED_SUBAGENT_DEFAULT_MARKER}\n"default_subagent_model" = "old"\n`;
    const result = apply(input, "new");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain('"default_subagent_model" = "new"');
  });

  test.each([
    ["basic", 'message = """\n[agents]\n# Managed by opencodex: native subagent default\ndefault_subagent_model = "string/data"\n"""\n'],
    ["literal", "message = '''\n[agents]\n# Managed by opencodex: native subagent default\ndefault_subagent_model = 'string/data'\n'''\n"],
  ])("ignores table, key, and marker text inside %s multiline strings", (_kind, input) => {
    const before = Bun.TOML.parse(input).message;
    const result = apply(input, "managed/model", "high");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Bun.TOML.parse(result.content).message).toBe(before);
    expect(result.content).toStartWith(input);
    expect(result.content.match(/^\[agents\]$/gm)).toHaveLength(2);
    const parsedAgents = Bun.TOML.parse(result.content).agents as Record<string, unknown>;
    expect(parsedAgents.default_subagent_model).toBe("managed/model");
    expect(parsedAgents.default_subagent_reasoning_effort).toBe("high");
  });

  test("recognizes an escaped quoted user key as the canonical target", () => {
    const input = String.raw`[agents]
"default_subagent_\u006dodel" = "user/model"
`;
    const result = apply(input, "managed/model", "high");
    expect(result).toEqual({
      ok: true,
      changed: false,
      content: input,
      conflicts: [{ key: "default_subagent_model", line: 2, reason: "user-owned" }],
    });
    expect(() => Bun.TOML.parse(result.content)).not.toThrow();
  });

  test.each([
    ["x", String.raw`[agents]
"default_subagent_\x6dodel" = "user/model"
`],
    ["U", String.raw`["\U00000061gents"]
"default_subagent_\U0000006Dodel" = "user/model"
`],
  ])("recognizes Codex-supported \\%s escapes in quoted canonical keys", (_escape, input) => {
    const result = apply(input, "managed/model");
    expect(result).toEqual({
      ok: true,
      changed: false,
      content: input,
      conflicts: [{ key: "default_subagent_model", line: 2, reason: "user-owned" }],
    });
  });

  test("recognizes an escaped quoted agents table without creating a duplicate", () => {
    const input = String.raw`["\u0061gents"]
max_threads = 4
`;
    const result = apply(input, "managed/model");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain(String.raw`["\u0061gents"]`);
    expect(result.content).not.toContain("\n[agents]\n");
    expect((Bun.TOML.parse(result.content).agents as Record<string, unknown>).default_subagent_model)
      .toBe("managed/model");
  });

  test("does not treat nested array elements as table boundaries", () => {
    const input = [
      "[agents]",
      "matrix = [",
      '  ["x"],',
      "]",
      'default_subagent_model = "user/model"',
      "",
    ].join("\n");
    const result = apply(input, "managed/model", "high");
    expect(result).toEqual({
      ok: true,
      changed: false,
      content: input,
      conflicts: [{ key: "default_subagent_model", line: 5, reason: "user-owned" }],
    });
    expect(() => Bun.TOML.parse(result.content)).not.toThrow();
  });

  test("finds root dotted targets after a multiline nested array", () => {
    const input = [
      "matrix = [",
      '  ["x"],',
      "]",
      'agents.default_subagent_model = "user/model"',
      "",
    ].join("\n");
    const result = apply(input);
    expect(result.ok).toBe(false);
    expect(result.content).toBe(input);
  });

  test.each([
    ["model", [
      "[agents]",
      MANAGED_SUBAGENT_DEFAULT_MARKER,
      'default_subagent_model = """',
      "managed/model",
      '"""',
      "",
    ].join("\n"), null],
    ["literal model", [
      "[agents]",
      MANAGED_SUBAGENT_DEFAULT_MARKER,
      "default_subagent_model = '''",
      "managed/model",
      "'''",
      "",
    ].join("\n"), null],
    ["effort", [
      "[agents]",
      MANAGED_SUBAGENT_DEFAULT_MARKER,
      'default_subagent_model = "managed/model"',
      MANAGED_SUBAGENT_DEFAULT_MARKER,
      'default_subagent_reasoning_effort = """',
      "high",
      '"""',
      "",
    ].join("\n"), { model: "managed/model" }],
  ])("refuses to partially remove a marker-owned multiline %s", (_kind, input, defaults) => {
    const result = transformManagedSubagentDefaults(input, defaults);
    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(input);
    expect(() => Bun.TOML.parse(result.content)).not.toThrow();
  });

  test.each([
    ["duplicate tables", "[agents]\n[agents]\n"],
    ["duplicate target keys", '[agents]\ndefault_subagent_model = "a"\ndefault_subagent_model = "b"\n'],
    ["root dotted target", 'agents.default_subagent_model = "a"\n'],
    ["quoted root dotted target", '"agents"."default_subagent_model" = "a"\n'],
    ["escaped quoted root dotted target", String.raw`"\u0061gents"."default_subagent_\u006dodel" = "a"
`],
    ["dotted target in table", '[agents]\ndefault_subagent_model.value = "a"\n'],
    ["target key as dotted table", "[agents.default_subagent_model]\nvalue = 'a'\n"],
    ["target key as deeper dotted table", "[agents.default_subagent_model.metadata]\nvalue = 'a'\n"],
    ["array agents table", "[[agents]]\nmodel = 'a'\n"],
    ["inline agents definition", 'agents = { default_subagent_model = "a" }\n'],
    ["orphaned key marker", `${MANAGED_SUBAGENT_DEFAULT_MARKER}\n[notice]\n`],
    ["orphaned table marker", `${MANAGED_AGENTS_TABLE_MARKER}\n[notice]\n`],
  ])("rejects %s without changing bytes", (_name, input) => {
    const result = apply(input);
    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(input);
  });

  test("rejects invalid requested defaults without changing bytes", () => {
    const input = "# untouched\r\n";
    expect(transformManagedSubagentDefaults(input, { model: "" })).toMatchObject({
      ok: false,
      changed: false,
      content: input,
    });
    expect(transformManagedSubagentDefaults(input, { model: "m", reasoningEffort: "" })).toMatchObject({
      ok: false,
      changed: false,
      content: input,
    });
    expect(transformManagedSubagentDefaults(input, { model: "bad\ud800" })).toMatchObject({
      ok: false,
      changed: false,
      content: input,
    });
  });
});
