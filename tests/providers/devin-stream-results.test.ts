import { describe, expect, test } from "bun:test";
import { mapOcxMessagesToDevin } from "../../src/adapters/devin";
import { buildGetChatMessageRequestForTests, type ChatHistoryItem } from "../../src/adapters/devin/cloud-direct/chat";
import { iterFields } from "../../src/adapters/devin/cloud-direct/wire";
import { parseRequest } from "../../src/responses/parser";
import type { OcxMessage, OcxParsedRequest, OcxToolResultMessage } from "../../src/types";

const call = (id: string) => ({ type: "custom_tool_call", call_id: id, name: "exec", input: "diagnostic" });
const result = (id: string, output: string) => ({ type: "custom_tool_call_output", call_id: id, output });
const user = (content: string) => ({ role: "user", content });

function parse(input: unknown[]): OcxParsedRequest {
  return parseRequest({
    model: "devin/claude-opus-5-5",
    input,
    tools: [{ type: "custom", name: "exec", description: "Read-only diagnostic tool.", format: { type: "text" } }],
  });
}

function mapParsed(parsed: OcxParsedRequest): ChatHistoryItem[] {
  const before = structuredClone(parsed);
  const messages = mapOcxMessagesToDevin(parsed);
  expect(parsed).toEqual(before);
  return messages;
}

function text(message: ChatHistoryItem): string {
  return typeof message.content === "string"
    ? message.content
    : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

const results = (messages: ChatHistoryItem[]) => messages.filter((message) => message.role === "tool");

function toolResult(content: OcxToolResultMessage["content"], isError = false): OcxToolResultMessage {
  return { role: "toolResult", toolCallId: "a", toolName: "exec", content, isError, timestamp: 1 };
}

function mapResults(...outputs: OcxToolResultMessage[]): ChatHistoryItem[] {
  const parsed = parse([user("Observe only."), call("a")]);
  parsed.context.messages.push(...outputs);
  return mapParsed(parsed);
}

describe("Devin streamed tool results", () => {
  test("encodes progress and final outputs as one tool prompt in arrival order", () => {
    const messages = mapParsed(parse([
      user("Observe only."), call("a"),
      result("a", "Script running with cell ID 890"),
      result("a", "Round 2-2 observed"), result("a", "stopped"),
    ]));
    expect(results(messages)).toHaveLength(1);
    const encoded = buildGetChatMessageRequestForTests({
      apiKey: "k", modelUid: "claude-opus-5-5", messages,
      cascadeId: "c", sessionId: "s", requestId: 1n, triggerId: "t",
    });
    const prompts = [...iterFields(encoded)].filter((field) => field.num === 3)
      .map((field) => [...iterFields(field.value as Buffer)]);
    const tools = prompts.filter((fields) => fields.some((field) => field.num === 7));
    expect(tools).toHaveLength(1);
    expect((tools[0]!.find((field) => field.num === 7)!.value as Buffer).toString()).toBe("a");
    const output = (tools[0]!.find((field) => field.num === 3)!.value as Buffer).toString();
    expect(output).toMatch(/Script running with cell ID 890[\s\S]+Round 2-2 observed[\s\S]+stopped/);
  });

  test("folds a late result into its first slot without dropping intervening messages", () => {
    const messages = mapParsed(parse([
      user("Observe only."), call("a"), result("a", "started"),
      user("What happened?"), { role: "assistant", content: "Still waiting." }, result("a", "stopped"),
    ]));
    const conversation = messages.filter((message) => message.role !== "system");
    expect(conversation.map((message) => message.role)).toEqual(["user", "assistant", "tool", "user", "assistant"]);
    expect(text(conversation[2]!)).toMatch(/started[\s\S]+stopped/);
    expect(text(conversation[3]!)).toBe("What happened?");
    expect(text(conversation[4]!)).toBe("Still waiting.");
  });

  test("interleaved progress from parallel calls stays with the matching call", () => {
    const output = results(mapParsed(parse([
      user("Observe only."), call("a"), call("b"),
      result("a", "alpha started"), result("b", "beta started"),
      result("a", "alpha done"), result("b", "beta done"),
    ])));
    expect(output.map((message) => message.tool_call_id)).toEqual(["a", "b"]);
    expect(text(output[0]!)).toMatch(/alpha started[\s\S]+alpha done/);
    expect(text(output[0]!)).not.toContain("beta");
    expect(text(output[1]!)).toMatch(/beta started[\s\S]+beta done/);
    expect(text(output[1]!)).not.toContain("alpha");
  });

  test("a new invocation reusing an id starts a separate result slot", () => {
    const output = results(mapParsed(parse([
      user("Observe only."), call("a"), result("a", "first started"), result("a", "first done"),
      call("a"), result("a", "second started"), result("a", "second done"),
    ])));
    expect(output).toHaveLength(2);
    expect(text(output[0]!)).toMatch(/first started[\s\S]+first done/);
    expect(text(output[0]!)).not.toContain("second");
    expect(text(output[1]!)).toMatch(/second started[\s\S]+second done/);
    expect(text(output[1]!)).not.toContain("first");
  });

  test.each([false, true])("keeps text and images when the image arrives first: %s", (imageFirst) => {
    const image = toolResult([{ type: "image", imageUrl: "data:image/png;base64,aGVsbG8=" }]);
    const failure = toolResult("runner failed", true);
    const output = results(mapResults(...(imageFirst ? [image, failure] : [failure, image]), toolResult("finished")));
    expect(output).toHaveLength(1);
    expect(output[0]!.is_error).toBe(true);
    expect(Array.isArray(output[0]!.content)).toBe(true);
    expect(output[0]!.content).toContainEqual({ type: "image", mimeType: "image/png", base64Data: "aGVsbG8=" });
    expect(text(output[0]!)).toMatch(/ERROR:\s+runner failed[\s\S]+finished/);
    const encoded = buildGetChatMessageRequestForTests({
      apiKey: "k", modelUid: "claude-opus-5-5", messages: output,
      cascadeId: "c", sessionId: "s", requestId: 1n, triggerId: "t",
    });
    const prompt = [...iterFields(encoded)].find((field) => field.num === 3)!;
    const fields = [...iterFields(prompt.value as Buffer)];
    expect(Number(fields.find((field) => field.num === 9)!.value)).toBe(1);
    expect(fields.filter((field) => field.num === 10)).toHaveLength(1);
  });

  test("preserves images from multiple structured results and the error marker", () => {
    const output = results(mapResults(
      toolResult([{ type: "image", imageUrl: "data:image/png;base64,YQ==" }], true),
      toolResult([{ type: "text", text: "second" }, { type: "image", imageUrl: "data:image/png;base64,Yg==" }]),
    ));
    expect(output).toHaveLength(1);
    const content = output[0]!.content;
    expect(typeof content).not.toBe("string");
    if (typeof content === "string") throw new Error("Expected structured content");
    expect(content.filter((part) => part.type === "image").map((part) => part.base64Data)).toEqual(["YQ==", "Yg=="]);
    expect(text(output[0]!)).toMatch(/ERROR:[\s\S]+second/);
    expect(output[0]!.is_error).toBe(true);
  });

  test("single results stay unchanged and empty chunks do not lose later output", () => {
    const single = results(mapResults(toolResult("only")));
    expect(single).toEqual([{ role: "tool", tool_call_id: "a", content: "only" }]);
    const output = results(mapResults(toolResult(""), toolResult("done")));
    expect(output).toHaveLength(1);
    expect(text(output[0]!)).toContain("done");
    expect(output[0]!.is_error).toBeUndefined();
  });

  test("does not fabricate a missing assistant call", () => {
    const parsed = parse([]);
    parsed.context.messages = [toolResult("started"), toolResult("done")] satisfies OcxMessage[];
    const messages = mapParsed(parsed);
    expect(messages.some((message) => message.role === "assistant")).toBe(false);
    expect(results(messages)).toHaveLength(1);
    expect(text(results(messages)[0]!)).toMatch(/started[\s\S]+done/);
  });
});
