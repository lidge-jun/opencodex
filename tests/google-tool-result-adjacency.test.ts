import { describe, expect, test } from "bun:test";
import { createGoogleAdapter } from "../src/adapters/google";
import type { OcxContentPart, OcxMessage, OcxParsedRequest } from "../src/types";

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

describe("Google adapter tool-result adjacency repair (#2199)", () => {
  test("normal call/result history stays one adjacent model/user pair", async () => {
    const contents = await wire([
      assistant([{ id: "call_1", name: "bash" }]),
      result("call_1", "bash", "done"),
    ]);

    expect(contents).toHaveLength(2);
    expect(contents.map(turn => turn.role)).toEqual(["model", "user"]);
    expect(functionResponses(contents[1])).toEqual([
      { name: "bash", response: { result: "done" }, id: "call_1" },
    ]);
  });

  test("missing results are synthesized before the next non-tool turn", async () => {
    const contents = await wire([
      assistant([{ id: "call_missing", name: "exec_command" }]),
      user("continue"),
    ]);

    expect(contents.map(turn => turn.role)).toEqual(["model", "user", "user"]);
    expect(functionResponses(contents[1])).toEqual([
      {
        name: "exec_command",
        response: { result: "[missing tool_result for this tool_use in history]" },
        id: "call_missing",
      },
    ]);
    expect(contents[2].parts).toEqual([{ text: "continue" }]);
  });

  test("parallel responses are emitted in call order even when history is reversed", async () => {
    const contents = await wire([
      assistant([{ id: "call_1", name: "first" }, { id: "call_2", name: "second" }]),
      result("call_2", "second", "two"),
      result("call_1", "first", "one"),
    ]);

    expect(contents).toHaveLength(2);
    expect(functionResponses(contents[1])).toEqual([
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

    const responseTurn = contents[1];
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

    expect(contents.map(turn => turn.role)).toEqual(["model", "user", "user", "user"]);
    expect(functionResponses(contents[1])[0]).toMatchObject({ id: "call_1" });
    expect(contents[2].parts).toEqual([{ text: "barrier" }]);
    expect(contents[3].parts).toEqual([
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
