import { describe, expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";

describe("Responses parser", () => {
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

  test("current parser ignores null empty and unknown string efforts", () => {
    expect(parseRequest({ model: "p/m", input: "hi", reasoning: null }).options.reasoning).toBeUndefined();
    expect(parseRequest({ model: "p/m", input: "hi", reasoning: { effort: "" } }).options.reasoning).toBeUndefined();
    expect(parseRequest({ model: "p/m", input: "hi", reasoning: { effort: "banana" } }).options.reasoning).toBeUndefined();
    expect(() => parseRequest({ model: "p/m", input: "hi", reasoning: { effort: null } })).toThrow();
  });
});
