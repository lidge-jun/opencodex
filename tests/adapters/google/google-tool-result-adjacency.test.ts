import { describe, expect, test } from "bun:test";
import { createGoogleAdapter } from "../../../src/adapters/google";
import type { OcxContentPart, OcxMessage, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

const provider = { adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "key" };

interface GeminiTurn {
  role: "user" | "model";
  parts: Array<Record<string, unknown>>;
}

function assistant(calls: Array<{ id: string; name: string }>): OcxMessage {
  return {
    role: "assistant",
    content: calls.map(call => ({ type: "toolCall", id: call.id, name: call.name, arguments: {} })),
    timestamp: 0,
  };
}

function result(id: string, name: string, content: string | OcxContentPart[] = "ok"): OcxMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content,
    isError: false,
    timestamp: 0,
  } as OcxMessage;
}

function user(text: string): OcxMessage {
  return { role: "user", content: text, timestamp: 0 };
}

async function wire(messages: OcxMessage[]): Promise<GeminiTurn[]> {
  const parsed = {
    modelId: "claude-opus-4.8",
    stream: false,
    options: {},
    context: { messages },
  } as OcxParsedRequest;
  const built = await createGoogleAdapter(provider).buildRequest(parsed);
  return (JSON.parse(built.body) as { contents: GeminiTurn[] }).contents;
}

function functionResponses(turn: GeminiTurn): Array<Record<string, unknown>> {
  return turn.parts
    .filter(part => "functionResponse" in part)
    .map(part => part.functionResponse as Record<string, unknown>);
}

describe("CCA Claude tool-result image ordering", () => {
  const cca: OcxProviderConfig = { ...provider, googleMode: "cloud-code-assist",
    baseUrl: "https://cloudcode-pa.googleapis.com", project: "test-project" };
  const imageA = { inline_data: { mime_type: "image/png", data: "YQ==" } };
  const imageB = { inline_data: { mime_type: "image/jpeg", data: "Yg==" } };
  const responseA = { functionResponse: { name: "first", id: "call_A", response: { result: "screen A[image]" } } };
  const responseB = { functionResponse: { name: "second", id: "call_B", response: { result: "screen B[image]" } } };
  const responseC = { functionResponse: { name: "third", id: "call_C", response: { result: "text C" } } };

  function parallelHistory(reversed: boolean): OcxMessage[] {
    const results = [
      result("call_A", "first", [{ type: "text", text: "screen A" },
        { type: "image", imageUrl: "data:image/png;base64,YQ==" }]),
      result("call_B", "second", [{ type: "text", text: "screen B" },
        { type: "image", imageUrl: "data:image/jpeg;base64,Yg==" }]),
      result("call_C", "third", "text C"),
    ];
    return [user("inspect"), assistant([
      { id: "call_A", name: "first" }, { id: "call_B", name: "second" }, { id: "call_C", name: "third" },
    ]), ...(reversed ? results.reverse() : results)];
  }

  async function build(messages: OcxMessage[], config = cca, modelId = "claude-sonnet-4-6", stream = false) {
    const original = structuredClone(messages);
    const built = await createGoogleAdapter(config).buildRequest({
      modelId, stream, options: {}, context: { messages },
    } as OcxParsedRequest);
    expect(messages).toEqual(original);
    const body = JSON.parse(built.body);
    return { contents: (body.request ?? body).contents as GeminiTurn[], built, body };
  }

  for (const model of ["claude-sonnet-4-6", "claude-opus-5-5-high"]) {
    for (const stream of [false, true]) {
      test.each([false, true])(`${model} puts all three responses before both images (stream=${stream}, reversed=%p)`, async reversed => {
        const { contents, built, body } = await build(parallelHistory(reversed), cca, model, stream);
        expect(built.url).toContain(stream ? ":streamGenerateContent?alt=sse" : ":generateContent");
        expect(body.model).toBe(model);
        expect(contents.map(turn => turn.role)).toEqual(["user", "model", "user"]);
        expect(contents[1].parts.map(part => part.functionCall)).toEqual([
          { name: "first", id: "call_A", args: {} },
          { name: "second", id: "call_B", args: {} },
          { name: "third", id: "call_C", args: {} },
        ]);
        // Assert the final compiled envelope, not a filtered list that hides interleaving.
        expect(contents[2].parts).toEqual([responseA, responseB, responseC, imageA, imageB]);
      });
    }
  }

  test("single image result keeps its sibling and text-only parallel results keep their shape", async () => {
    const history = parallelHistory(false);
    const single = await build([history[0], assistant([{ id: "call_A", name: "first" }]), history[2]]);
    expect(single.contents.at(-1)?.parts).toEqual([responseA, imageA]);
    const textOnly = await build([history[0], history[1],
      result("call_C", "third", "text C"), result("call_B", "second", "text B"), result("call_A", "first", "text A")]);
    expect(textOnly.contents.at(-1)?.parts).toEqual([
      { functionResponse: { name: "first", id: "call_A", response: { result: "text A" } } },
      { functionResponse: { name: "second", id: "call_B", response: { result: "text B" } } }, responseC,
    ]);
  });

  test.each([
    ["cloud-code-assist", "gemini-4-argon"],
    ["cloud-code-assist", "gpt-oss-120b-medium"],
    ["ai-studio", "gemini-4-argon"],
    ["ai-studio", "claude-sonnet-4-6"],
    ["vertex", "gemini-3.1-pro"],
    ["vertex", "claude-sonnet-4-6"],
  ] as const)("other routes keep interleaved siblings (%s, %s)", async (googleMode, model) => {
    const { contents } = await build(parallelHistory(true), { ...cca, googleMode }, model);
    expect(contents.at(-1)?.parts).toEqual([responseA, imageA, responseB, imageB, responseC]);
  });

  test("Vertex Argon keeps each image nested in its matching response", async () => {
    const { contents } = await build(parallelHistory(true), { ...cca, googleMode: "vertex" }, "gemini-4-argon");
    expect(contents.at(-1)?.parts).toEqual([
      { functionResponse: { ...responseA.functionResponse, parts: [imageA] } },
      { functionResponse: { ...responseB.functionResponse, parts: [imageB] } }, responseC,
    ]);
  });
});

describe("Google adapter tool-result adjacency repair (#2199)", () => {
  test("normal call/result history stays one adjacent model/user pair", async () => {
    const contents = await wire([
      assistant([{ id: "call_1", name: "bash" }]),
      result("call_1", "bash", "done"),
    ]);

    // The opening user turn is the #5008 head repair: a history opening on a call turn would
    // otherwise leave the functionCall at contents[0], which Antigravity rejects.
    expect(contents).toHaveLength(3);
    expect(contents.map(turn => turn.role)).toEqual(["user", "model", "user"]);
    expect(functionResponses(contents[2])).toEqual([
      { name: "bash", response: { result: "done" }, id: "call_1" },
    ]);
  });

  test("missing results are synthesized before the next non-tool turn", async () => {
    const contents = await wire([
      assistant([{ id: "call_missing", name: "exec_command" }]),
      user("continue"),
    ]);

    expect(contents.map(turn => turn.role)).toEqual(["user", "model", "user", "user"]);
    expect(functionResponses(contents[2])).toEqual([
      {
        name: "exec_command",
        response: { result: "[missing tool_result for this tool_use in history]" },
        id: "call_missing",
      },
    ]);
    expect(contents[3].parts).toEqual([{ text: "continue" }]);
  });

  test("parallel responses are emitted in call order even when history is reversed", async () => {
    const contents = await wire([
      assistant([{ id: "call_1", name: "first" }, { id: "call_2", name: "second" }]),
      result("call_2", "second", "two"),
      result("call_1", "first", "one"),
    ]);

    expect(contents).toHaveLength(3);
    expect(functionResponses(contents[2])).toEqual([
      { name: "first", response: { result: "one" }, id: "call_1" },
      { name: "second", response: { result: "two" }, id: "call_2" },
    ]);
  });

  test("duplicate and mismatched results become marked text after the complete response batch", async () => {
    const contents = await wire([
      assistant([{ id: "call_1", name: "bash" }, { id: "call_2", name: "read" }]),
      result("call_1", "bash", "first result"),
      result("call_1", "bash", "duplicate result"),
      result("call_orphan", "mystery", "orphan result"),
    ]);

    const responseTurn = contents[2];
    expect(functionResponses(responseTurn)).toEqual([
      { name: "bash", response: { result: "first result" }, id: "call_1" },
      {
        name: "read",
        response: { result: "[missing tool_result for this tool_use in history]" },
        id: "call_2",
      },
    ]);
    const text = responseTurn.parts.filter(part => "text" in part).map(part => part.text);
    expect(text).toEqual([
      "[tool_result without adjacent tool_use: bash (call_1)]\nduplicate result",
      "[tool_result without adjacent tool_use: mystery (call_orphan)]\norphan result",
    ]);
  });

  test("standalone image-bearing results stay visible without a fabricated functionResponse", async () => {
    const contents = await wire([
      result("call_orphan", "snapshot", [
        { type: "text", text: "screen" },
        { type: "image", imageUrl: "data:image/png;base64,aGVsbG8=" },
      ]),
    ]);

    expect(contents).toHaveLength(1);
    expect(functionResponses(contents[0])).toEqual([]);
    expect(contents[0].parts[0]).toEqual({
      text: "[tool_result without adjacent tool_use: snapshot (call_orphan)]\nscreen[image]",
    });
    expect(contents[0].parts[1]).toEqual({
      inline_data: { mime_type: "image/png", data: "aGVsbG8=" },
    });
  });

  test("standalone remote-image results keep their marker without fabricating inline data", async () => {
    const contents = await wire([
      result("call_orphan", "snapshot", [
        { type: "image", imageUrl: "https://example.com/screenshot.png" },
      ]),
    ]);

    expect(contents).toHaveLength(1);
    expect(functionResponses(contents[0])).toEqual([]);
    expect(contents[0].parts).toEqual([
      { text: "[tool_result without adjacent tool_use: snapshot (call_orphan)]\n[image]" },
    ]);
    expect(JSON.stringify(contents[0].parts)).not.toContain("inline_data");
    expect(JSON.stringify(contents[0].parts)).not.toContain("(empty tool output)");
  });

  test("a non-tool barrier closes the call before a later result becomes orphan text", async () => {
    const contents = await wire([
      assistant([{ id: "call_1", name: "bash" }]),
      user("barrier"),
      result("call_1", "bash", "late"),
    ]);

    expect(contents.map(turn => turn.role)).toEqual(["user", "model", "user", "user", "user"]);
    expect(functionResponses(contents[2])[0]).toMatchObject({ id: "call_1" });
    expect(contents[3].parts).toEqual([{ text: "barrier" }]);
    expect(contents[4].parts).toEqual([
      { text: "[tool_result without adjacent tool_use: bash (call_1)]\nlate" },
    ]);
  });

  test("a tool call without a usable id degrades to text with its result", async () => {
    const contents = await wire([
      assistant([{ id: "", name: "bash" }]),
      result("", "bash", "done"),
    ]);

    expect(contents).toHaveLength(2);
    expect(contents[0]).toEqual({
      role: "model",
      parts: [{ text: "[tool_use without a usable id: bash]\n{}" }],
    });
    expect(functionResponses(contents[1])).toEqual([]);
    expect(contents[1].parts).toEqual([
      { text: "[tool_result without adjacent tool_use: bash ()]\ndone" },
    ]);
  });
});
