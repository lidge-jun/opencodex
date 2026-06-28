import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeMessage } from "../src/lib/eventstream-decoder";
import { createKiroAdapter } from "../src/adapters/kiro";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

const enc = new TextEncoder();
const origHome = process.env.HOME;
const origRegion = process.env.KIRO_REGION;
const origArn = process.env.KIRO_PROFILE_ARN;
let tmp: string;

beforeEach(() => {
  // isolate: empty HOME so no kiro-cli SQLite is read; deterministic region.
  tmp = mkdtempSync(join(tmpdir(), "kiro-adapter-"));
  process.env.HOME = tmp;
  process.env.KIRO_REGION = "us-east-1";
  delete process.env.KIRO_PROFILE_ARN;
});
afterEach(() => {
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origRegion === undefined) delete process.env.KIRO_REGION; else process.env.KIRO_REGION = origRegion;
  if (origArn === undefined) delete process.env.KIRO_PROFILE_ARN; else process.env.KIRO_PROFILE_ARN = origArn;
  rmSync(tmp, { recursive: true, force: true });
});

const provider = { adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev", authMode: "oauth", apiKey: "tok-123" } as unknown as OcxProviderConfig;

function parsedWith(messages: unknown[], tools?: unknown[]): OcxParsedRequest {
  return { modelId: "claude-sonnet-4.5", stream: true, options: {}, context: { messages, tools } } as unknown as OcxParsedRequest;
}

const eventFrame = (obj: unknown) => encodeMessage({ ":message-type": "event", ":event-type": "x" }, enc.encode(JSON.stringify(obj)));
function streamOf(...frames: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < frames.length) c.enqueue(frames[i++]);
      else c.close();
    },
  });
}

describe("kiro adapter — buildRequest", () => {
  test("headers carry Bearer token + CW targets", () => {
    const { url, method, headers } = createKiroAdapter(provider).buildRequest(parsedWith([{ role: "user", content: "hi" }]));
    expect(url).toBe("https://runtime.us-east-1.kiro.dev/");
    expect(method).toBe("POST");
    expect(headers.authorization).toBe("Bearer tok-123");
    expect(headers["x-amz-target"]).toBe("AmazonCodeWhispererStreamingService.GenerateAssistantResponse");
    expect(headers.accept).toBe("application/vnd.amazon.eventstream");
    expect(headers["x-amzn-kiro-agent-mode"]).toBe("vibe");
  });

  test("toolUses[].input is a JSON object (not stringified) and toolResults are adjacent", () => {
    const messages = [
      { role: "user", content: "run it" },
      { role: "assistant", content: [{ type: "toolCall", id: "call|1", name: "bash", arguments: { command: "echo hi" } }] },
      { role: "toolResult", toolCallId: "call|1", toolName: "bash", content: "hi", isError: false },
    ];
    const { body } = createKiroAdapter(provider).buildRequest(parsedWith(messages));
    const cs = JSON.parse(body).conversationState;
    const arm = cs.history.find((h: { assistantResponseMessage?: unknown }) => h.assistantResponseMessage)?.assistantResponseMessage;
    const tu = arm.toolUses[0];
    expect(typeof tu.input).toBe("object");
    expect(tu.input).toEqual({ command: "echo hi" });
    expect(tu.toolUseId).toBe("call_1"); // normalized
    const results = cs.currentMessage.userInputMessage.userInputMessageContext.toolResults;
    expect(results[0].toolUseId).toBe("call_1"); // matches the toolUse id
    expect(results[0].status).toBe("success");
  });

  test("tools map to toolSpecification with name<=64", () => {
    const { body } = createKiroAdapter(provider).buildRequest(
      parsedWith([{ role: "user", content: "hi" }], [{ name: "grep", description: "search", parameters: { type: "object" } }]),
    );
    const ctx = JSON.parse(body).conversationState.currentMessage.userInputMessage.userInputMessageContext;
    expect(ctx.tools[0].toolSpecification.name).toBe("grep");
    expect(ctx.tools[0].toolSpecification.inputSchema.json).toEqual({ type: "object" });
  });
});

describe("kiro adapter — parseStream", () => {
  test("maps CW events (name repeated on every tool chunk) to AdapterEvents with accumulated args", async () => {
    const frames = [
      eventFrame({ content: "Hi " }),
      eventFrame({ content: "there" }),
      eventFrame({ name: "bash", toolUseId: "t1" }),
      eventFrame({ input: '{"command":"ec', name: "bash", toolUseId: "t1" }),
      eventFrame({ input: 'ho hi"}', name: "bash", toolUseId: "t1" }),
      eventFrame({ name: "bash", stop: true, toolUseId: "t1" }),
    ];
    const events: string[] = [];
    let args = "";
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(...frames)))) {
      if (e.type === "text_delta") events.push(`text:${e.text}`);
      else if (e.type === "tool_call_start") events.push(`start:${e.id}:${e.name}`);
      else if (e.type === "tool_call_delta") { args += e.arguments; events.push("delta"); }
      else events.push(e.type);
    }
    expect(events).toEqual(["text:Hi ", "text:there", "start:t1:bash", "delta", "delta", "tool_call_end", "done"]);
    expect(JSON.parse(args)).toEqual({ command: "echo hi" });
  });

  test("emits error for an exception frame", async () => {
    const frame = encodeMessage({ ":message-type": "exception", ":exception-type": "ThrottlingException" }, enc.encode("rate limited"));
    const out: string[] = [];
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(frame)))) {
      out.push(e.type === "error" ? `error:${e.message}` : e.type);
    }
    expect(out[0]).toBe("error:rate limited");
  });
});
