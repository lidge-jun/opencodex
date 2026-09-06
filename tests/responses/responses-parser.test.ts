import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildResponseJSON } from "../../src/bridge";
import { parseRequest } from "../../src/responses/parser";
import { externalTaskInputContent } from "../../src/responses/task-input";
import { buildTools } from "../../src/responses/parser-tools";
import { parseTextFormat } from "../../src/responses/parser-text-format";
import { buildToolBridgeMaps } from "../../src/server/responses";
import { repoPath } from "../helpers/repo-root";

describe("Responses parser", () => {
  test("normalizes function tool schemas to an object root without corrupting valid schemas (#745)", () => {
    const validParameters = {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    };
    const parsed = parseRequest({
      model: "test-model",
      input: "test",
      tools: [
        { type: "function", name: "missing_parameters" },
        { type: "function", name: "missing_root_type", parameters: { properties: { query: { type: "string" } } } },
        { type: "function", name: "valid_schema", parameters: validParameters },
      ],
    });

    expect(parsed.context.tools).toEqual([
      { name: "missing_parameters", description: "", parameters: { type: "object" } },
      {
        name: "missing_root_type",
        description: "",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      },
      { name: "valid_schema", description: "", parameters: validParameters },
    ]);
  });

  test("normalizes tool_search parameter schemas to the same object-root contract", () => {
    const parsed = parseRequest({
      model: "test-model",
      input: "find a tool",
      tools: [{
        type: "tool_search",
        parameters: { properties: { query: { type: "string" } }, required: ["query"] },
      }],
    });

    expect(parsed.context.tools).toEqual([{
      name: "tool_search",
      description: "Search for additional tools to load for the next turn.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      toolSearch: true,
    }]);
  });

  test("unwraps Chat-shaped function tools while retaining flat function tools", () => {
    const parameters = {
      type: "object",
      properties: { zone: { type: "string" } },
      required: ["zone"],
    };
    const nested = parseRequest({
      model: "test-model",
      input: "What time is it?",
      tools: [
        {
          type: "function",
          function: { name: "get_time", description: "t", parameters, strict: true },
        },
      ],
    });
    expect(nested.context.tools).toEqual([
      { name: "get_time", description: "t", parameters, strict: true },
    ]);

    const flat = parseRequest({
      model: "test-model",
      input: "What time is it?",
      tools: [{ type: "function", name: "get_time", description: "t", parameters, strict: true }],
    });
    expect(flat.context.tools).toEqual([
      { name: "get_time", description: "t", parameters, strict: true },
    ]);
  });

  test("drops Chat-shaped function tools with an empty nested name", () => {
    const parsed = parseRequest({
      model: "test-model",
      input: "What time is it?",
      tools: [{ type: "function", function: { name: "" } }],
    });

    expect(parsed.context.tools).toBeUndefined();
    expect(parsed.context.tools?.some(tool => tool.name.length === 0) ?? false).toBe(false);
  });

  test("describes the exact apply_patch freeform envelope", () => {
    const parsed = parseRequest({
      model: "xai/grok-4.5",
      input: "Update a file",
      tools: [{ type: "custom", name: "apply_patch", description: "Apply a patch" }],
    });

    expect(parsed.context.tools?.[0]).toMatchObject({
      name: "apply_patch",
      freeform: true,
      parameters: {
        properties: {
          input: {
            description: expect.stringContaining("begin exactly with `*** Begin Patch`"),
          },
        },
      },
    });
  });

  test("preserves assistant message phase when replaying Responses output", () => {
    const parsed = parseRequest({
      model: "kiro/gpt-5.6-sol",
      input: [
        { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "working" }] },
        { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "done" }] },
      ],
    });

    expect(parsed.context.messages).toMatchObject([
      { role: "assistant", phase: "commentary", content: [{ type: "text", text: "working" }] },
      { role: "assistant", phase: "final_answer", content: [{ type: "text", text: "done" }] },
    ]);
  });

  test("preserves allowed_tools tool_choice instead of widening it to auto", () => {
    const parsed = parseRequest({
      model: "umans/umans-kimi-k2.7",
      input: "search",
      tools: [
        {
          type: "function",
          name: "web_search",
          description: "Search",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        },
        {
          type: "function",
          name: "run_tests",
          description: "Run tests",
          parameters: { type: "object", properties: {} },
        },
      ],
      tool_choice: {
        type: "allowed_tools",
        mode: "required",
        tools: [{ type: "function", name: "web_search" }],
      },
    });

    expect(parsed.options.toolChoice).toEqual({ allowedTools: ["web_search"], mode: "required" });
  });

  test("restores only namespace, freeform, and tool-search calls allowed by tool_choice", () => {
    const parsed = parseRequest({
      model: "umans/umans-kimi-k2.7",
      input: "use the safe tool",
      tools: [
        {
          type: "namespace",
          name: "mcp__tools",
          tools: [
            { type: "function", name: "safe", parameters: { type: "object" } },
            { type: "function", name: "secret", parameters: { type: "object" } },
          ],
        },
        { type: "custom", name: "apply_patch", description: "Apply" },
        { type: "tool_search" },
      ],
      tool_choice: {
        type: "allowed_tools",
        mode: "required",
        tools: [
          { type: "function", name: "mcp__tools.safe" },
          { type: "custom", name: "apply_patch" },
        ],
      },
    });

    let maps = buildToolBridgeMaps(parsed);
    expect([...maps.toolNsMap]).toEqual([
      ["mcp__tools__safe", { namespace: "mcp__tools", name: "safe" }],
      ["mcp__tools.safe", { namespace: "mcp__tools", name: "safe" }],
    ]);
    expect([...maps.declaredToolNames]).toEqual(["mcp__tools__safe", "mcp__tools.safe", "apply_patch"]);
    expect([...maps.freeformToolNames]).toEqual(["apply_patch"]);
    expect([...maps.toolSearchToolNames]).toEqual([]);

    parsed.options.toolChoice = { allowedTools: ["mcp__tools__safe"], mode: "required" };
    maps = buildToolBridgeMaps(parsed);
    expect([...maps.toolNsMap.keys()]).toEqual(["mcp__tools__safe", "mcp__tools.safe"]);
    expect([...maps.declaredToolNames]).toEqual(["mcp__tools__safe", "mcp__tools.safe"]);
    expect([...maps.freeformToolNames]).toEqual([]);

    parsed.options.toolChoice = { name: "tool_search" };
    maps = buildToolBridgeMaps(parsed);
    expect([...maps.toolNsMap]).toEqual([]);
    expect([...maps.declaredToolNames]).toEqual(["tool_search"]);
    expect([...maps.freeformToolNames]).toEqual([]);
    expect([...maps.toolSearchToolNames]).toEqual(["tool_search"]);

    parsed.options.toolChoice = "none";
    maps = buildToolBridgeMaps(parsed);
    expect([...maps.toolNsMap]).toEqual([]);
    expect([...maps.declaredToolNames]).toEqual([]);
    expect([...maps.freeformToolNames]).toEqual([]);
    expect([...maps.toolSearchToolNames]).toEqual([]);
  });

  test("accepts a unique bare selector for a namespaced custom tool and rejects ambiguity", () => {
    const parsed = parseRequest({
      model: "claude-opus-5",
      input: "run it",
      tools: [{
        type: "namespace",
        name: "mcp__functions",
        tools: [{ type: "custom", name: "exec", description: "Run a command" }],
      }],
      tool_choice: {
        type: "allowed_tools",
        mode: "required",
        tools: [{ type: "custom", name: "exec" }],
      },
    });

    let maps = buildToolBridgeMaps(parsed);
    expect([...maps.toolNsMap]).toEqual([
      ["mcp__functions__exec", { namespace: "mcp__functions", name: "exec", freeform: true }],
      ["mcp__functions.exec", { namespace: "mcp__functions", name: "exec", freeform: true }],
      ["exec", { namespace: "mcp__functions", name: "exec", freeform: true }],
    ]);
    expect([...maps.declaredToolNames]).toEqual(["mcp__functions__exec", "mcp__functions.exec", "exec"]);
    expect([...maps.freeformToolNames]).toEqual(["exec"]);

    const bridged = buildResponseJSON([
      { type: "tool_call_start", id: "call_exec", name: "exec" },
      { type: "tool_call_delta", arguments: '{"input":"pwd"}' },
      { type: "tool_call_end" },
      { type: "done" },
    ], "claude-opus-5", maps);
    expect(bridged.status).toBe("completed");
    expect((bridged.output as Record<string, unknown>[])[0]).toMatchObject({
      type: "custom_tool_call",
      call_id: "call_exec",
      name: "exec",
      input: "pwd",
      status: "completed",
    });

    parsed.options.toolChoice = { name: "exec" };
    maps = buildToolBridgeMaps(parsed);
    expect([...maps.toolNsMap.keys()]).toEqual(["mcp__functions__exec", "mcp__functions.exec", "exec"]);

    expect(() => parseRequest({
      model: "claude-opus-5",
      input: "run it",
      tools: [{
        type: "namespace",
        name: "mcp__functions",
        tools: [{ type: "custom", name: "exec" }],
      }, {
        type: "namespace",
        name: "other",
        tools: [{ type: "custom", name: "exec" }],
      }],
      tool_choice: {
        type: "allowed_tools",
        mode: "required",
        tools: [{ type: "custom", name: "exec" }],
      },
    })).toThrow("ambiguous tool_choice name: exec");

    const mixedKinds = parseRequest({
      model: "claude-opus-5",
      input: "run it",
      tools: [{
        type: "namespace",
        name: "mcp__functions",
        tools: [{ type: "custom", name: "exec" }],
      }, {
        type: "namespace",
        name: "mcp__remote",
        tools: [{ type: "function", name: "exec", parameters: { type: "object" } }],
      }],
    });
    const mixedMaps = buildToolBridgeMaps(mixedKinds);
    const customCall = buildResponseJSON([
      { type: "tool_call_start", id: "call_custom", name: "mcp__functions__exec" },
      { type: "tool_call_delta", arguments: '{"input":"pwd"}' },
      { type: "tool_call_end" },
      { type: "done" },
    ], "claude-opus-5", mixedMaps);
    const functionCall = buildResponseJSON([
      { type: "tool_call_start", id: "call_function", name: "mcp__remote__exec" },
      { type: "tool_call_delta", arguments: "{}" },
      { type: "tool_call_end" },
      { type: "done" },
    ], "claude-opus-5", mixedMaps);
    expect((customCall.output as Record<string, unknown>[])[0]?.type).toBe("custom_tool_call");
    expect((functionCall.output as Record<string, unknown>[])[0]).toMatchObject({
      type: "function_call",
      name: "exec",
      namespace: "mcp__remote",
    });
  });

  test("maps hosted allowed_tools entries to their synthetic routed tool names", () => {
    const parsed = parseRequest({
      model: "umans/umans-kimi-k2.7",
      input: "search",
      tools: [{ type: "web_search", search_context_size: "medium" }],
      tool_choice: {
        type: "allowed_tools",
        mode: "required",
        tools: [{ type: "web_search" }],
      },
    });

    expect(parsed._webSearch).toEqual({ type: "web_search", search_context_size: "medium" });
    expect(parsed.options.toolChoice).toEqual({ allowedTools: ["web_search"], mode: "required" });
  });

  test("rejects wire-name collisions instead of dropping one logical tool", () => {
    expect(() => parseRequest({
      model: "gpt-5.5",
      input: "run it",
      tools: [
        {
          type: "namespace",
          name: "foo",
          tools: [{ type: "function", name: "bar", parameters: { type: "object" } }],
        },
        { type: "function", name: "foo__bar", parameters: { type: "object" } },
      ],
    })).toThrow("ambiguous tool catalog: multiple logical tools map to wire name foo__bar");
  });

  test("rejects a dotted alias that also names a flat tool", () => {
    expect(() => parseRequest({
      model: "gpt-5.5",
      input: "run it",
      tools: [
        {
          type: "namespace",
          name: "foo",
          tools: [{ type: "function", name: "bar", parameters: { type: "object" } }],
        },
        { type: "function", name: "foo.bar", parameters: { type: "object" } },
      ],
      tool_choice: { type: "function", name: "foo.bar" },
    })).toThrow("ambiguous tool_choice name: foo.bar");
  });

  test("maps type-only hosted image_generation tool_choice to required image_gen", () => {
    const parsed = parseRequest({
      model: "claude-opus-4-6",
      input: "draw a cat",
      tools: [{ type: "image_generation" }],
      tool_choice: { type: "image_generation" },
    });

    expect(parsed._imageGeneration?.toolNames.has("image_generation")).toBe(true);
    expect(parsed.options.toolChoice).toEqual({ name: "image_gen" });
    expect(parsed.context.tools?.some(
      tool => tool.name === "image_gen" && tool.imageGeneration === true,
    )).toBe(true);
  });

  test("namespaced ordinary image_gen does not suppress the synthetic root image tool", () => {
    const parsed = parseRequest({
      model: "grok-4.6",
      input: "draw a cat",
      tools: [
        {
          type: "namespace",
          name: "mcp_pack",
          tools: [{ type: "function", name: "image_gen", parameters: { type: "object" } }],
        },
        { type: "image_generation" },
      ],
    });

    const tools = parsed.context.tools ?? [];
    const namespaced = tools.find(tool => tool.name === "image_gen" && tool.namespace === "mcp_pack");
    const synthetic = tools.find(tool => tool.name === "image_gen" && !tool.namespace);
    expect(namespaced).toBeDefined();
    expect(namespaced?.imageGeneration).toBeUndefined();
    expect(synthetic?.imageGeneration).toBe(true);
  });

  test("hosted image_generation then a root ordinary image_gen keeps one synthetic tool", () => {
    const parsed = parseRequest({
      model: "grok-4.6",
      input: "draw a cat",
      tools: [
        { type: "image_generation" },
        { type: "function", name: "image_gen", parameters: { type: "object" } },
      ],
    });

    const root = (parsed.context.tools ?? []).filter(tool => tool.name === "image_gen" && !tool.namespace);
    expect(root).toHaveLength(1);
    expect(root[0]?.imageGeneration).toBe(true);
  });

  test("hosted image_generation then a root custom image_gen keeps one synthetic tool", () => {
    const parsed = parseRequest({
      model: "grok-4.6",
      input: "draw a cat",
      tools: [
        { type: "image_generation" },
        { type: "custom", name: "image_gen" },
      ],
    });

    const root = (parsed.context.tools ?? []).filter(tool => tool.name === "image_gen" && !tool.namespace);
    expect(root).toHaveLength(1);
    expect(root[0]?.imageGeneration).toBe(true);
    expect(root[0]?.freeform).toBeUndefined();
  });

  test("both root declarations before hosted image_generation collapse to one synthetic tool", () => {
    // Reverse order of the two cases above. Removing only the first colliding root
    // left the second behind, so the catalog stayed ambiguous on one wire name.
    const parsed = parseRequest({
      model: "grok-4.6",
      input: "draw a cat",
      tools: [
        { type: "function", name: "image_gen", parameters: { type: "object" } },
        { type: "custom", name: "image_gen" },
        { type: "image_generation" },
      ],
    });

    const root = (parsed.context.tools ?? []).filter(tool => tool.name === "image_gen" && !tool.namespace);
    expect(root).toHaveLength(1);
    expect(root[0]?.imageGeneration).toBe(true);
    expect(root[0]?.freeform).toBeUndefined();
  });

  test("a root image_gen on each side of hosted image_generation still collapses", () => {
    const parsed = parseRequest({
      model: "grok-4.6",
      input: "draw a cat",
      tools: [
        { type: "function", name: "image_gen", parameters: { type: "object" } },
        { type: "image_generation" },
        { type: "custom", name: "image_gen" },
      ],
    });

    const root = (parsed.context.tools ?? []).filter(tool => tool.name === "image_gen" && !tool.namespace);
    expect(root).toHaveLength(1);
    expect(root[0]?.imageGeneration).toBe(true);
  });

  test("a namespaced image_gen survives the root collapse", () => {
    const parsed = parseRequest({
      model: "grok-4.6",
      input: "draw a cat",
      tools: [
        { type: "function", name: "image_gen", parameters: { type: "object" } },
        {
          type: "namespace",
          name: "mcp_pack",
          tools: [{ type: "function", name: "image_gen", parameters: { type: "object" } }],
        },
        { type: "image_generation" },
      ],
    });

    const tools = parsed.context.tools ?? [];
    expect(tools.filter(tool => tool.name === "image_gen" && !tool.namespace)).toHaveLength(1);
    expect(tools.find(tool => tool.name === "image_gen" && tool.namespace === "mcp_pack")).toBeDefined();
  });

  test("preserves requested service_tier for request logging", () => {
    const parsed = parseRequest({
      model: "gpt-5.5",
      input: "fast check",
      stream: true,
      service_tier: "priority",
    });

    expect(parsed.options.serviceTier).toBe("priority");
  });

  test("preserves prompt_cache_key as an internal request option", () => {
    const parsed = parseRequest({
      model: "gpt-5.5",
      input: "cache affinity",
      stream: true,
      prompt_cache_key: "project-cache-v1",
    });

    expect(parsed.options.promptCacheKey).toBe("project-cache-v1");
  });

  test("carries text.format json_schema into options.textFormat and flags structured output", () => {
    const parsed = parseRequest({
      model: "gpt-5.5",
      input: "structured",
      stream: true,
      text: { format: { type: "json_schema", name: "answer", description: "shape", schema: { type: "object" }, strict: true } },
    });

    expect(parsed.options.textFormat).toEqual({
      type: "json_schema",
      name: "answer",
      description: "shape",
      schema: { type: "object" },
      strict: true,
    });
    expect(parsed._structuredOutput).toBe(true);
  });

  test("carries text.format json_object and ignores the plain text format", () => {
    const jsonObject = parseRequest({
      model: "gpt-5.5",
      input: "structured",
      stream: true,
      text: { format: { type: "json_object" } },
    });
    const plain = parseRequest({
      model: "gpt-5.5",
      input: "prose",
      stream: true,
      text: { format: { type: "text" } },
    });

    expect(jsonObject.options.textFormat).toEqual({ type: "json_object" });
    expect(jsonObject._structuredOutput).toBe(true);
    expect(plain.options.textFormat).toBeUndefined();
    expect(plain._structuredOutput).toBeUndefined();
  });

  test("preserves input_image blocks from function_call_output", () => {
    const parsed = parseRequest({
      model: "kiro/claude-sonnet-4.5",
      input: [
        { type: "function_call", call_id: "call-1", name: "get_app_state", arguments: "{}" },
        {
          type: "function_call_output",
          call_id: "call-1",
          output: [
            { type: "output_text", text: "Looked at Google Chrome" },
            { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "high" },
          ],
        },
      ],
    });
    const result = parsed.context.messages.find(m => m.role === "toolResult");

    expect(result?.content).toEqual([
      { type: "text", text: "Looked at Google Chrome" },
      { type: "image", imageUrl: "data:image/png;base64,aGVsbG8=", detail: "high" },
    ]);
  });
});

describe("codex-rs compat surface (260707)", () => {
  const base = { model: "claude-sonnet-4-6", stream: true };

  test("function_call_output arrays keep input_text blocks (FunctionCallOutputContentItem)", () => {
    const parsed = parseRequest({ ...base, input: [
      { type: "function_call", call_id: "c1", name: "view_image", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: [
        { type: "input_text", text: "caption text" },
        { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "high" },
      ]},
    ]});
    const result = parsed.context.messages.find(m => m.role === "toolResult");
    expect(result?.content).toEqual([
      { type: "text", text: "caption text" },
      { type: "image", imageUrl: "data:image/png;base64,aGVsbG8=", detail: "high" },
    ]);
  });

  test("function_call_output encrypted_content degrades to an opaque text marker", () => {
    const parsed = parseRequest({ ...base, input: [
      { type: "function_call", call_id: "c1", name: "x", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: [
        { type: "encrypted_content", encrypted_content: "opaque-blob" },
        { type: "input_text", text: "visible" },
      ]},
    ]});
    const result = parsed.context.messages.find(m => m.role === "toolResult");
    expect(result?.content).toBe("[encrypted content omitted]visible");
  });

  test("image detail 'original' is normalized to 'high' for downstream adapters", () => {
    const parsed = parseRequest({ ...base, input: [
      { type: "message", role: "user", content: [
        { type: "input_text", text: "look" },
        { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "original" },
      ]},
      { type: "function_call", call_id: "c1", name: "view_image", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: [
        { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "original" },
      ]},
    ]});
    const user = parsed.context.messages.find(m => m.role === "user");
    expect((user?.content as { detail?: string }[])[1].detail).toBe("high");
    const result = parsed.context.messages.find(m => m.role === "toolResult");
    expect((result?.content as { detail?: string }[])[0].detail).toBe("high");
  });

  test("custom_tool_call_output array output is normalized, not leaked raw", () => {
    const parsed = parseRequest({ ...base, input: [
      { type: "custom_tool_call", call_id: "c2", name: "apply_patch", input: "body" },
      { type: "custom_tool_call_output", call_id: "c2", output: [
        { type: "input_text", text: "patched ok" },
      ]},
    ]});
    const result = parsed.context.messages.find(m => m.role === "toolResult");
    expect(result?.content).toBe("patched ok");
  });

  test("custom_tool_call_output array with image keeps structured parts", () => {
    const parsed = parseRequest({ ...base, input: [
      { type: "custom_tool_call", call_id: "c3", name: "snap", input: "" },
      { type: "custom_tool_call_output", call_id: "c3", output: [
        { type: "input_text", text: "shot" },
        { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
      ]},
    ]});
    const result = parsed.context.messages.find(m => m.role === "toolResult");
    expect(result?.content).toEqual([
      { type: "text", text: "shot" },
      { type: "image", imageUrl: "data:image/png;base64,aGVsbG8=" },
    ]);
  });

  for (const outputType of ["function_call_output", "custom_tool_call_output"]) {
    test.each([
      {
        name: "file-only image becomes a text marker",
        output: [{ type: "input_image", file_id: "file-only" }],
        expected: "[image: file-only]",
      },
      {
        name: "empty URL falls back to file_id",
        output: [{ type: "input_image", image_url: "", file_id: "file-fallback" }],
        expected: "[image: file-fallback]",
      },
      {
        name: "non-string URLs fall back to usable file_ids",
        output: [null, false, 42, {}, []].map(image_url => ({ type: "input_image", image_url, file_id: "file-valid" })),
        expected: "[image: file-valid]".repeat(5),
      },
      {
        name: "nonempty URL wins over file_id and normalizes original detail",
        output: [{ type: "input_image", image_url: "https://example.com/winner.png", file_id: "file-loser", detail: "original" }],
        expected: [{ type: "image", imageUrl: "https://example.com/winner.png", detail: "high" }],
      },
      {
        name: "valid URL survives a malformed file_id",
        output: [{ type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", file_id: 42 }],
        expected: [{ type: "image", imageUrl: "data:image/png;base64,aGVsbG8=" }],
      },
      {
        name: "empty arrays stay empty text",
        output: [],
        expected: "",
      },
      {
        name: "malformed blocks and unusable image references are omitted",
        output: [
          null, false, 42, "", [], {},
          { type: "input_image" },
          { type: "input_image", image_url: "", file_id: "" },
          ...[null, false, 42, {}, []].flatMap(value => [
            { type: "input_image", image_url: value, file_id: "" },
            { type: "input_image", image_url: "", file_id: value },
          ]),
        ],
        expected: "",
      },
    ])(`${outputType}: $name`, ({ output, expected }) => {
      const parsed = parseRequest({ ...base, input: [{ type: outputType, call_id: "image-call", output }] });
      const result = parsed.context.messages.find(m => m.role === "toolResult");
      expect(result?.content).toEqual(expected);
    });

    test(`${outputType}: mixed image output preserves order, caller input and raw body`, () => {
      const output = Object.freeze([
        { type: "input_text", text: "before" },
        { type: "input_image", image_url: "", file_id: "file-marker" },
        { type: "input_image", image_url: "https://example.com/kept.png", file_id: "file-ignored", detail: "original" },
        { type: "input_image", image_url: "", file_id: "" },
        { type: "input_text", text: "after" },
      ].map(block => Object.freeze(block)));
      const item = Object.freeze({ type: outputType, call_id: "image-call", output });
      const body = Object.freeze({ ...base, input: Object.freeze([item]) });
      const before = JSON.stringify(body);
      const parsed = parseRequest(body);
      expect(parsed.context.messages).toHaveLength(1);
      const result = parsed.context.messages[0];
      expect(result.role).toBe("toolResult");
      expect(result.content).toEqual([
        { type: "text", text: "before" },
        { type: "text", text: "[image: file-marker]" },
        { type: "image", imageUrl: "https://example.com/kept.png", detail: "high" },
        { type: "text", text: "after" },
      ]);
      expect(parsed._rawBody).toBe(body);
      expect(body.input[0]).toBe(item);
      expect(item.output).toBe(output);
      expect(JSON.stringify(body)).toBe(before);
      expect(JSON.stringify(parsed._rawBody)).toBe(before);
    });
  }

  test("context_compaction with ocx1 payload replays the stored summary", () => {
    const summary = "previous work summary";
    const encrypted = "ocx1:" + Buffer.from(summary, "utf-8").toString("base64");
    const parsed = parseRequest({ ...base, input: [
      { type: "context_compaction", encrypted_content: encrypted },
      { type: "message", role: "user", content: "next task" },
    ]});
    const first = parsed.context.messages[0];
    expect(first.role).toBe("user");
    expect(first.content as string).toContain(summary);
    expect(parsed._compactionRequest).toBeUndefined();
    expect(parsed._contextCompactionBoundary).toBe(true);
  });

  test("context_compaction without payload is a silent marker (no opaque note)", () => {
    const parsed = parseRequest({ ...base, input: [
      { type: "context_compaction" },
      { type: "message", role: "user", content: "hello" },
    ]});
    expect(parsed.context.messages).toHaveLength(1);
    expect(parsed.context.messages[0].content).toBe("hello");
    expect(parsed._contextCompactionBoundary).toBe(true);
  });

  test("local_shell_call pairs with its function_call_output", () => {
    const parsed = parseRequest({ ...base, input: [
      { type: "local_shell_call", call_id: "sh1", status: "completed",
        action: { type: "exec", command: ["ls", "-la"] } },
      { type: "function_call_output", call_id: "sh1", output: "total 0" },
    ]});
    const assistant = parsed.context.messages.find(m => m.role === "assistant");
    const call = (assistant?.content as { type: string; id?: string; name?: string; arguments?: Record<string, unknown> }[])
      .find(p => p.type === "toolCall");
    expect(call?.id).toBe("sh1");
    expect(call?.name).toBe("shell");
    expect(call?.arguments).toEqual({ command: ["ls", "-la"] });
    const result = parsed.context.messages.find(m => m.role === "toolResult");
    expect(result?.toolName).toBe("shell");
    expect(result?.content).toBe("total 0");
  });

  test("web_search_call replay stays out of assistant-visible history text", () => {
    const parsed = parseRequest({ ...base, input: [
      { type: "web_search_call", status: "completed", action: { type: "search", query: "bun 1.3 release" } },
      { type: "message", role: "user", content: "and now?" },
    ]});
    const serialized = JSON.stringify(parsed.context.messages);
    expect(serialized).not.toContain("[web search performed");
    expect(serialized).not.toContain("bun 1.3 release");
    expect(parsed.context.messages.map(m => m.role)).toEqual(["user"]);
  });

  test("tool_search_output failed status is surfaced as an error result", () => {
    const parsed = parseRequest({ ...base, input: [
      { type: "tool_search_call", call_id: "ts1", arguments: { query: "x" } },
      { type: "tool_search_output", call_id: "ts1", status: "failed", execution: "client", tools: [] },
    ]});
    const result = parsed.context.messages.find(m => m.role === "toolResult");
    expect(result?.isError).toBe(true);
    expect(result?.content as string).toContain("failed");
  });

  test("marks tool_search-loaded definitions for transport priority", () => {
    const parsed = parseRequest({ ...base, input: [
      { type: "tool_search_call", call_id: "ts1", arguments: { query: "automation" } },
      {
        type: "tool_search_output", call_id: "ts1", status: "completed", execution: "client",
        tools: [{ type: "function", name: "automation_update", description: "Update", parameters: {} }],
      },
    ]});
    expect(parsed.context.tools?.find(tool => tool.name === "automation_update")?.loadedFromToolSearch).toBe(true);
  });

  test("normalizes ultra reasoning effort to max like the upstream client boundary", () => {
    const parsed = parseRequest({ model: "p/m", input: "hi", reasoning: { effort: "ultra" } });
    expect(parsed.options.reasoning).toBe("max");
  });

  test("still drops unknown reasoning efforts instead of forwarding them", () => {
    const parsed = parseRequest({ model: "p/m", input: "hi", reasoning: { effort: "banana" } });
    expect(parsed.options.reasoning).toBeUndefined();
  });

  test("detects image_generation hosted tool arriving via additional_tools (responses_lite WS shape)", () => {
    // Codex Desktop responses_websockets lite path: NO body.tools; the hosted tool spec rides
    // inside an input item {type:"additional_tools", tools:[...]}. extractHostedImageGeneration
    // must still see it so the image bridge activates.
    const parsed = parseRequest({
      model: "p/m",
      input: [
        { type: "additional_tools", tools: [{ type: "image_generation" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "draw a cat" }] },
      ],
    });
    expect(parsed._imageGeneration?.toolNames.has("image_generation")).toBe(true);
  });

  test("current parser ignores null empty and unknown string efforts", () => {
    expect(parseRequest({ model: "p/m", input: "hi", reasoning: null }).options.reasoning).toBeUndefined();
    expect(parseRequest({ model: "p/m", input: "hi", reasoning: { effort: "" } }).options.reasoning).toBeUndefined();
    expect(parseRequest({ model: "p/m", input: "hi", reasoning: { effort: "banana" } }).options.reasoning).toBeUndefined();
    expect(() => parseRequest({ model: "p/m", input: "hi", reasoning: { effort: null } })).toThrow();
  });

  test("a replayed custom_tool_call recovers the namespace it was declared under", () => {
    // The round trip loses it otherwise. The bridge emits a client-facing custom call with
    // only the BARE name — `{"type":"custom_tool_call","name":"exec"}` even for a tool
    // declared as `mcp__functions__exec`. On the next request the adapters replay tool
    // history through `namespacedToolName(namespace, name)`, so a missing namespace makes
    // the replayed call target a bare `exec` the provider may not expose.
    //
    // `function_call` items do not need this: they carry `namespace` on the wire.
    const parsed = parseRequest({
      model: "p/m",
      tools: [{
        type: "namespace",
        name: "mcp__tools",
        tools: [{ type: "custom", name: "exec", description: "run", format: { type: "text" } }],
      }],
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
        { type: "custom_tool_call", call_id: "call_1", name: "exec", input: "ls" },
      ],
    });

    const assistant = parsed.context.messages.find(msg => msg.role === "assistant");
    const call = (assistant?.content as Array<{ type: string; name?: string; namespace?: string }> | undefined)
      ?.find(part => part.type === "toolCall");
    expect(call?.name).toBe("exec");
    expect(call?.namespace).toBe("mcp__tools");
  });

  test("a replayed custom_tool_call under the reserved functions namespace stays bare", () => {
    // Companion guard. Codex 0.147 groups ordinary client tools under `functions`, and
    // buildTools deliberately flattens those WITHOUT a namespace. Reconstructing one here
    // would invent a namespace the request never advertised and break the reverse mapping
    // in the other direction.
    const parsed = parseRequest({
      model: "p/m",
      tools: [{
        type: "namespace",
        name: "functions",
        tools: [{ type: "custom", name: "apply_patch", description: "patch", format: { type: "text" } }],
      }],
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
        { type: "custom_tool_call", call_id: "call_2", name: "apply_patch", input: "*** Begin Patch" },
      ],
    });

    const assistant = parsed.context.messages.find(msg => msg.role === "assistant");
    const call = (assistant?.content as Array<{ type: string; name?: string; namespace?: string }> | undefined)
      ?.find(part => part.type === "toolCall");
    expect(call?.name).toBe("apply_patch");
    expect(call?.namespace).toBeUndefined();
  });
});

describe("unpaired tool result boundary (#3259)", () => {
  // The real delegation-history shape that produced the defect: a subagent bootstrap turn
  // whose FIRST tool result has no originating call in the same request.
  const delegationHistory = (toolItem: Record<string, unknown>) => ({
    model: "test-model",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "You are a subagent." }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "do the task" }] },
      toolItem,
    ],
  });

  const toolResultOf = (item: Record<string, unknown>) =>
    parseRequest(delegationHistory(item)).context.messages.find(m => m.role === "toolResult") as
      | { toolCallId?: unknown; content?: unknown }
      | undefined;

  test("a function_call_output with no call_id still parses, and yields an unusable toolCallId", () => {
    // This is the state src/server/responses/core.ts guards on. `toolCallId` is declared
    // `string` (src/types/request.ts:168) but is undefined here — the schema catch-all
    // (schema.ts:106) accepted the item and parser.ts:738 assigned it unchecked.
    const result = toolResultOf({ type: "function_call_output", output: "bootstrap result" });
    expect(result).toBeDefined();
    expect(typeof result?.toolCallId).not.toBe("string");
  });

  test("an empty-string call_id is equally unusable", () => {
    // findToolById (parser.ts:328) matches by identity, so "" can never pair. The guard
    // must treat it exactly like undefined.
    const result = toolResultOf({ type: "function_call_output", call_id: "", output: "x" });
    expect(result?.toolCallId).toBe("");
  });

  test("a well-formed tool result on the same history pairs normally", () => {
    const result = toolResultOf({ type: "function_call_output", call_id: "call_1", output: "ok" });
    expect(result).toMatchObject({ toolCallId: "call_1", content: "ok" });
  });

  test("custom_tool_call_output has the identical hole (parser.ts:752)", () => {
    const result = toolResultOf({ type: "custom_tool_call_output", output: "x" });
    expect(result).toBeDefined();
    expect(typeof result?.toolCallId).not.toBe("string");
  });

  test("tolerances unrelated to call_id stay intact", () => {
    // parser.ts:611-621 deliberately tolerates non-JSON arguments; nothing here may 400 it.
    expect(() => parseRequest(delegationHistory({
      type: "function_call", call_id: "c1", name: "shell", arguments: "not json",
    }))).not.toThrow();
    // Unknown future item types must keep flowing through the catch-all untouched.
    expect(() => parseRequest(delegationHistory({
      type: "brand_new_item_2027", foo: 1,
    }))).not.toThrow();
  });
});

describe("external task-input envelopes (#3735)", () => {
  const parseFrozen = (input: unknown[], extra: Record<string, unknown> = {}) => {
    const body = Object.freeze({
      model: "test-model",
      ...extra,
      input: Object.freeze(input.map((item) => Object.freeze(item as object))),
    });
    const before = JSON.stringify(body);
    const parsed = parseRequest(body);
    expect(parsed._rawBody).toBe(body);
    expect(JSON.stringify(body)).toBe(before);
    return parsed;
  };

  test.each([
    {
      name: "arbitrary metadata names preserve output whitespace",
      item: {
        type: "function_call_output",
        id: "rsrc.1",
        name: "Launch Task",
        namespace: "agent.workspace",
        output: "  keep  ",
      },
      content: "  keep  ",
    },
    {
      name: "ordered text and original image keep order and map detail to high",
      item: {
        type: "function_call_output",
        id: "img_1",
        name: "view",
        namespace: "tools",
        output: [
          { type: "input_text", text: "caption" },
          { type: "input_image", image_url: "https://example.com/a.png", detail: "original" },
        ],
      },
      content: [
        { type: "text", text: "caption" },
        { type: "image", imageUrl: "https://example.com/a.png", detail: "high" },
      ],
    },
    {
      name: "output_text normalizes through input content parts",
      item: {
        type: "function_call_output",
        id: "txt_1",
        name: "note",
        namespace: "ns",
        output: [{ type: "output_text", text: "from output_text" }],
      },
      content: "from output_text",
    },
  ])("$name", ({ item, content }) => {
    const parsed = parseFrozen([item]);
    expect(parsed.context.messages).toMatchObject([{ role: "user", content }]);
    expect(parsed.context.messages.some((message) => message.role === "toolResult")).toBe(false);
  });

  test("complete metadata with a valid call_id stays a tool result", () => {
    const parsed = parseFrozen([{
      type: "function_call_output",
      call_id: "call_keep",
      id: "task_1",
      name: "Launch Task",
      namespace: "agent.workspace",
      output: "ok",
    }]);
    expect(parsed.context.messages).toMatchObject([{
      role: "toolResult",
      toolCallId: "call_keep",
      content: "ok",
    }]);
  });

  test.each([
    { name: "missing id", item: { type: "function_call_output", name: "n", namespace: "ns", output: "ok" } },
    { name: "blank id", item: { type: "function_call_output", id: "  ", name: "n", namespace: "ns", output: "ok" } },
    { name: "missing name", item: { type: "function_call_output", id: "i", namespace: "ns", output: "ok" } },
    { name: "blank name", item: { type: "function_call_output", id: "i", name: "", namespace: "ns", output: "ok" } },
    { name: "missing namespace", item: { type: "function_call_output", id: "i", name: "n", output: "ok" } },
    { name: "blank namespace", item: { type: "function_call_output", id: "i", name: "n", namespace: "\t", output: "ok" } },
    { name: "empty call_id", item: { type: "function_call_output", call_id: "", id: "i", name: "n", namespace: "ns", output: "ok" } },
    { name: "null call_id", item: { type: "function_call_output", call_id: null, id: "i", name: "n", namespace: "ns", output: "ok" } },
    { name: "number call_id", item: { type: "function_call_output", call_id: 1, id: "i", name: "n", namespace: "ns", output: "ok" } },
    { name: "custom_tool_call_output", item: { type: "custom_tool_call_output", id: "i", name: "n", namespace: "ns", output: "ok" } },
    {
      name: "encrypted-only",
      item: {
        type: "function_call_output",
        id: "i",
        name: "n",
        namespace: "ns",
        output: [{ type: "encrypted_content", encrypted_content: "blob" }],
      },
    },
    {
      name: "mixed unsupported",
      item: {
        type: "function_call_output",
        id: "i",
        name: "n",
        namespace: "ns",
        output: [
          { type: "input_text", text: "visible" },
          { type: "encrypted_content", encrypted_content: "blob" },
        ],
      },
    },
    {
      name: "malformed text",
      item: {
        type: "function_call_output",
        id: "i",
        name: "n",
        namespace: "ns",
        output: [{ type: "input_text", text: 1 }],
      },
    },
    {
      name: "malformed image",
      item: {
        type: "function_call_output",
        id: "i",
        name: "n",
        namespace: "ns",
        output: [{ type: "input_image", image_url: 1 }],
      },
    },
    {
      name: "invalid detail",
      item: {
        type: "function_call_output",
        id: "i",
        name: "n",
        namespace: "ns",
        output: [{ type: "input_image", image_url: "https://example.com/a.png", detail: "ultra" }],
      },
    },
    {
      name: "file_id-only image",
      item: {
        type: "function_call_output",
        id: "i",
        name: "n",
        namespace: "ns",
        output: [{ type: "input_image", file_id: "file-1" }],
      },
    },
    { name: "blank output", item: { type: "function_call_output", id: "i", name: "n", namespace: "ns", output: "   " } },
    { name: "empty output", item: { type: "function_call_output", id: "i", name: "n", namespace: "ns", output: "" } },
    { name: "empty array", item: { type: "function_call_output", id: "i", name: "n", namespace: "ns", output: [] } },
  ])("$name stays off the user path", ({ item }) => {
    const parsed = parseFrozen([item]);
    expect(parsed.context.messages.some((message) => message.role === "user")).toBe(false);
    expect(parsed.context.messages.some((message) => message.role === "toolResult")).toBe(true);
  });

  test("own and inherited call_id properties are helper-ineligible", () => {
    const base = {
      type: "function_call_output",
      id: "task_1",
      name: "n",
      namespace: "ns",
      output: "ok",
    };
    expect(externalTaskInputContent(base)).toBe("ok");
    expect(externalTaskInputContent({ ...base, call_id: undefined })).toBeUndefined();
    expect(externalTaskInputContent(Object.assign(Object.create({ call_id: "proto" }), base))).toBeUndefined();
  });

  test("previous_response_id with only a valid envelope starts continuation at 0", () => {
    const parsed = parseFrozen([{
      type: "function_call_output",
      id: "task_1",
      name: "Launch Task",
      namespace: "agent.workspace",
      output: "next task",
    }], { previous_response_id: "resp_1" });
    expect(parsed._continuationConversationMessageIndex).toBe(0);
    expect(parsed.context.messages).toMatchObject([{ role: "user", content: "next task" }]);
  });

  test("reasoning before a valid envelope does not leak into a later assistant", () => {
    const parsed = parseFrozen([
      {
        type: "reasoning",
        id: "rs_stale",
        summary: [{ type: "summary_text", text: "stale thinking" }],
      },
      {
        type: "function_call_output",
        id: "task_1",
        name: "Launch Task",
        namespace: "agent.workspace",
        output: "next task",
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "done" }],
      },
    ]);
    expect(parsed.context.messages).toMatchObject([
      { role: "user", content: "next task" },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]);
    const assistant = parsed.context.messages.find((message) => message.role === "assistant");
    expect(assistant && "content" in assistant ? assistant.content : []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "thinking", thinking: "stale thinking" })]),
    );
  });
});

test("parser leaf seams preserve tool and format contracts without importing the request parser", () => {
  const tools = buildTools([{ type: "function", name: "missing_parameters" }]);
  expect(tools?.[0]?.name).toBe("missing_parameters");
  expect(parseTextFormat(undefined)).toBeUndefined();
  for (const leaf of ["parser-content.ts", "parser-tools.ts", "parser-text-format.ts"]) {
    expect(readFileSync(repoPath("src", "responses", leaf), "utf8")).not.toMatch(/from\s+["\x27]\.\/parser["\x27]/);
  }
});
