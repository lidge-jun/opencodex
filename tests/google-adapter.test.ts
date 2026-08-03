import { describe, expect, test } from "bun:test";
import { createGoogleAdapter } from "../src/adapters/google";
import type { OcxParsedRequest } from "../src/types";

const provider = { adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "key" };

function parsedWith(messages: unknown[], tools?: unknown[]): OcxParsedRequest {
  return { modelId: "gemini-3-pro", stream: false, options: {}, context: { messages, tools } } as unknown as OcxParsedRequest;
}

async function geminiContents(parsed: OcxParsedRequest): Promise<{ role: string; parts: Record<string, unknown>[] }[]> {
  // buildRequest is async (google-vertex auth path); await before parsing the body.
  const { body } = await createGoogleAdapter(provider).buildRequest(parsed);
  return JSON.parse(body).contents;
}

async function geminiBody(parsed: OcxParsedRequest): Promise<Record<string, unknown>> {
  const { body } = await createGoogleAdapter(provider).buildRequest(parsed);
  return JSON.parse(body);
}

describe("google adapter — tool result images", () => {
  test("tool-result screenshots ride along as inline_data beside the functionResponse", async () => {
    const contents = await geminiContents(parsedWith([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "get_app_state", namespace: "mcp__chrome", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "get_app_state",
        toolNamespace: "mcp__chrome",
        content: [
          { type: "text", text: "Looked at Google Chrome" },
          { type: "image", imageUrl: "data:image/png;base64,aGVsbG8=", detail: "high" },
        ],
        isError: false,
      },
    ]));

    const toolTurn = contents.find(c => c.parts.some(p => "functionResponse" in p));
    expect(toolTurn).toBeDefined();
    expect(toolTurn!.parts[0]).toEqual({
      functionResponse: { name: "mcp__chrome__get_app_state", response: { result: "Looked at Google Chrome[image]" }, id: "call_1" },
    });
    expect(toolTurn!.parts[1]).toEqual({ inline_data: { mime_type: "image/png", data: "aGVsbG8=" } });
  });

  test("text-only tool results emit a single functionResponse part", async () => {
    const contents = await geminiContents(parsedWith([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: {} }],
      },
      { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: "ok", isError: false },
    ]));

    const toolTurn = contents.find(c => c.parts.some(p => "functionResponse" in p));
    expect(toolTurn!.parts).toEqual([
      { functionResponse: { name: "bash", response: { result: "ok" }, id: "call_1" } },
    ]);
  });

  test("remote (non-data) tool-result image URLs are not inlined", async () => {
    const contents = await geminiContents(parsedWith([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "snap", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "snap",
        content: [{ type: "image", imageUrl: "https://example.test/shot.png" }],
        isError: false,
      },
    ]));

    const toolTurn = contents.find(c => c.parts.some(p => "functionResponse" in p));
    expect(toolTurn!.parts.some(p => "inline_data" in p)).toBe(false);
  });
});

describe("google adapter — tool-call ids on the wire", () => {
  test("v2 collaboration encrypted marker never reaches functionDeclarations (issue #85)", async () => {
    // Codex Desktop v2 stamps `encrypted: true` on collaboration message properties; CCA/Gemini
    // rejects the whole request with 400 "Unknown name". The sanitizer must strip it end-to-end.
    const collabParams = {
      type: "object",
      properties: {
        target: { type: "string", description: "Agent id." },
        message: { type: "string", description: "Message text.", encrypted: true },
      },
      required: ["target", "message"],
      additionalProperties: false,
    };
    const body = await geminiBody(parsedWith(
      [{ role: "user", content: "hi" }],
      [{ name: "followup_task", namespace: "collaboration", description: "Send follow-up", parameters: collabParams }],
    ));
    const decls = (body.tools as { functionDeclarations: Record<string, unknown>[] }[])[0].functionDeclarations;
    expect(decls.length).toBe(1);
    expect(JSON.stringify(decls)).not.toContain("encrypted");
    const params = decls[0].parameters as { properties: Record<string, Record<string, unknown>> };
    expect(params.properties.message.type).toBe("string");
  });

  test("systemInstruction includes the non-OpenAI tool catalog nudge when tools are present", async () => {
    const body = await geminiBody(parsedWith(
      [{ role: "user", content: "find files" }],
      [{ name: "exec_command", description: "Run", parameters: { type: "object" } }],
    ));
    const instruction = body.systemInstruction as { parts: Array<{ text: string }> };

    expect(instruction.parts[0].text).toContain("Tool contract: use the current tool catalog as ground truth.");
    expect(instruction.parts[0].text).toContain("Valid tool names for this turn are exactly `exec_command`.");
  });

  test("functionCall and functionResponse carry the matching tool-call id", async () => {
    const contents = await geminiContents(parsedWith([
      { role: "assistant", content: [{ type: "toolCall", id: "call_abc", name: "bash", arguments: { cmd: "ls" } }] },
      { role: "toolResult", toolCallId: "call_abc", toolName: "bash", content: "ok", isError: false },
    ]));

    const modelTurn = contents.find(c => c.role === "model");
    const fcPart = modelTurn!.parts.find(p => "functionCall" in p) as { functionCall: { id?: string } };
    expect(fcPart.functionCall.id).toBe("call_abc");

    const toolTurn = contents.find(c => c.parts.some(p => "functionResponse" in p));
    const frPart = toolTurn!.parts.find(p => "functionResponse" in p) as { functionResponse: { id?: string } };
    // Must equal the functionCall id so the upstream Anthropic conversion can pair them.
    expect(frPart.functionResponse.id).toBe("call_abc");
  });

  test("ids are normalized to Anthropic's tool_use.id charset, preserving call/response pairing", async () => {
    const contents = await geminiContents(parsedWith([
      { role: "assistant", content: [{ type: "toolCall", id: "fc:weird/id#1", name: "bash", arguments: {} }] },
      { role: "toolResult", toolCallId: "fc:weird/id#1", toolName: "bash", content: "ok", isError: false },
    ]));

    const fc = (contents.find(c => c.role === "model")!.parts.find(p => "functionCall" in p) as { functionCall: { id?: string } }).functionCall.id;
    const fr = (contents.find(c => c.parts.some(p => "functionResponse" in p))!.parts.find(p => "functionResponse" in p) as { functionResponse: { id?: string } }).functionResponse.id;
    // Lossy chars are rewritten to `_` plus a deterministic hash suffix (collision-resistant).
    expect(fc).toMatch(/^fc_weird_id_1_[0-9a-f]{8}$/);
    // Call and result share the same raw id, so they normalize identically and stay paired.
    expect(fc).toBe(fr);
  });

  test("distinct raw ids that share a normalized prefix do not collide", async () => {
    const contents = await geminiContents(parsedWith([
      { role: "assistant", content: [
        { type: "toolCall", id: "call:a", name: "bash", arguments: {} },
        { type: "toolCall", id: "call/a", name: "bash", arguments: {} },
      ] },
    ]));
    const ids = contents.find(c => c.role === "model")!.parts
      .filter(p => "functionCall" in p)
      .map(p => (p as { functionCall: { id?: string } }).functionCall.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  test("claude-on-antigravity keeps the tool_use id through signature sanitization", async () => {
    const ccaProvider = {
      adapter: "google",
      googleMode: "cloud-code-assist",
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      apiKey: "key",
      project: "proj-123",
    };
    const parsed = {
      modelId: "claude-opus-4.8",
      stream: false,
      options: {},
      context: {
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [{ type: "toolCall", id: "call_xyz", name: "bash", arguments: {} }] },
          { role: "toolResult", toolCallId: "call_xyz", toolName: "bash", content: "ok", isError: false },
        ],
      },
    } as unknown as OcxParsedRequest;

    const { body } = await createGoogleAdapter(ccaProvider).buildRequest(parsed);
    const envelope = JSON.parse(body);
    const contents = envelope.request.contents as { role: string; parts: Record<string, unknown>[] }[];
    const fc = (contents.find(c => c.role === "model")!.parts.find(p => "functionCall" in p) as { functionCall: { id?: string } }).functionCall.id;
    expect(fc).toBe("call_xyz");
  });
});

describe("google adapter — tool_choice on the wire", () => {
  const TOOLS = [
    { name: "get_weather", parameters: { type: "object", properties: {} } },
    { name: "shot", namespace: "mcp__chrome", parameters: { type: "object", properties: {} } },
  ];

  function parsedWithChoice(toolChoice: unknown, tools: unknown[] | null = TOOLS): OcxParsedRequest {
    return {
      modelId: "gemini-3-pro",
      stream: false,
      options: toolChoice === undefined ? {} : { toolChoice },
      context: { messages: [{ role: "user", content: "hi" }], tools: tools ?? undefined },
    } as unknown as OcxParsedRequest;
  }

  test('"none" and "required" map to NONE and ANY', async () => {
    expect((await geminiBody(parsedWithChoice("none"))).toolConfig)
      .toEqual({ functionCallingConfig: { mode: "NONE" } });
    expect((await geminiBody(parsedWithChoice("required"))).toolConfig)
      .toEqual({ functionCallingConfig: { mode: "ANY" } });
  });

  test("a forced tool maps to ANY with its wire name allowed", async () => {
    expect((await geminiBody(parsedWithChoice({ name: "get_weather" }))).toolConfig)
      .toEqual({ functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["get_weather"] } });
    // Dotted alias resolves to the namespaced declaration name.
    expect((await geminiBody(parsedWithChoice({ name: "mcp__chrome.shot" }))).toolConfig)
      .toEqual({ functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["mcp__chrome__shot"] } });
  });

  test('"auto", absent, and allowedTools+auto stay byte-identical (no toolConfig)', async () => {
    expect((await geminiBody(parsedWithChoice("auto"))).toolConfig).toBeUndefined();
    expect((await geminiBody(parsedWithChoice(undefined))).toolConfig).toBeUndefined();
    expect((await geminiBody(parsedWithChoice({ allowedTools: ["get_weather"], mode: "auto" }))).toolConfig).toBeUndefined();
  });

  test("allowedTools with mode required keeps the filtered catalog and adds ANY", async () => {
    const body = await geminiBody(parsedWithChoice({ allowedTools: ["get_weather"], mode: "required" }));
    const declared = (body.tools as { functionDeclarations: { name: string }[] }[])[0].functionDeclarations.map(d => d.name);
    expect(declared).toEqual(["get_weather"]);
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY" } });
  });

  test("no declared tools means no toolConfig even with a choice", async () => {
    expect((await geminiBody(parsedWithChoice("none", null))).toolConfig).toBeUndefined();
    expect((await geminiBody(parsedWithChoice({ name: "get_weather" }, []))).toolConfig).toBeUndefined();
  });

  test("claude-on-antigravity keeps VALIDATED mode over a client choice, allowed names survive", async () => {
    const ccaProvider = {
      adapter: "google",
      googleMode: "cloud-code-assist",
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      apiKey: "key",
      project: "proj-123",
    };
    const parsed = parsedWithChoice({ name: "get_weather" });
    (parsed as unknown as { modelId: string }).modelId = "claude-opus-4.8";
    const { body } = await createGoogleAdapter(ccaProvider).buildRequest(parsed);
    const request = JSON.parse(body).request as Record<string, unknown>;
    expect(request.toolConfig).toEqual({
      functionCallingConfig: { mode: "VALIDATED", allowedFunctionNames: ["get_weather"] },
    });
  });
});
