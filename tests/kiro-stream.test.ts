import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKiroAdapter } from "../src/adapters/kiro";
import { parseKiroEvent } from "../src/adapters/kiro-events";
import { encodeMessage } from "../src/lib/eventstream-decoder";
import { estimateTokens } from "../src/lib/token-estimate";
import type { OcxParsedRequest, OcxProviderConfig, OcxUsage } from "../src/types";

const enc = new TextEncoder();
const origHome = process.env.HOME;
const origRegion = process.env.KIRO_REGION;
const origApiRegion = process.env.KIRO_API_REGION;
const origArn = process.env.KIRO_PROFILE_ARN;
const origCredsFile = process.env.KIRO_CREDS_FILE;
const origCredentialsFile = process.env.KIRO_CREDENTIALS_FILE;
const origDebugFrames = process.env.OCX_DEBUG_FRAMES;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "kiro-stream-"));
  process.env.HOME = tmp;
  process.env.KIRO_REGION = "us-east-1";
  delete process.env.KIRO_API_REGION;
  delete process.env.KIRO_PROFILE_ARN;
  delete process.env.KIRO_CREDS_FILE;
  delete process.env.KIRO_CREDENTIALS_FILE;
  delete process.env.OCX_DEBUG_FRAMES;
});
afterEach(() => {
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origRegion === undefined) delete process.env.KIRO_REGION; else process.env.KIRO_REGION = origRegion;
  if (origApiRegion === undefined) delete process.env.KIRO_API_REGION; else process.env.KIRO_API_REGION = origApiRegion;
  if (origArn === undefined) delete process.env.KIRO_PROFILE_ARN; else process.env.KIRO_PROFILE_ARN = origArn;
  if (origCredsFile === undefined) delete process.env.KIRO_CREDS_FILE; else process.env.KIRO_CREDS_FILE = origCredsFile;
  if (origCredentialsFile === undefined) delete process.env.KIRO_CREDENTIALS_FILE; else process.env.KIRO_CREDENTIALS_FILE = origCredentialsFile;
  if (origDebugFrames === undefined) delete process.env.OCX_DEBUG_FRAMES; else process.env.OCX_DEBUG_FRAMES = origDebugFrames;
  rmSync(tmp, { recursive: true, force: true });
});

const provider = { adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev", authMode: "oauth", apiKey: "tok-123" } as unknown as OcxProviderConfig;
const bashTool = { name: "bash", description: "Run a shell command", parameters: { type: "object" } };

function parsedWith(messages: unknown[], tools?: unknown[], modelId = "claude-sonnet-4.5"): OcxParsedRequest {
  return { modelId, stream: true, options: {}, context: { messages, tools } } as unknown as OcxParsedRequest;
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

async function doneUsage(adapter: ReturnType<typeof createKiroAdapter>, ...frames: Uint8Array[]): Promise<OcxUsage> {
  let done: OcxUsage | undefined;
  for await (const e of adapter.parseStream(new Response(streamOf(...frames)))) {
    if (e.type === "done") done = e.usage;
  }
  expect(done).toBeDefined();
  return done!;
}

describe("kiro adapter — parseStream", () => {
  test("Kiro event parser preserves usage and context usage frames", () => {
    expect(parseKiroEvent(enc.encode(JSON.stringify({ usage: 123 })))).toEqual({ type: "usage", usage: 123 });
    expect(parseKiroEvent(enc.encode(JSON.stringify({ contextUsagePercentage: 25.5 })))).toEqual({
      type: "context_usage",
      contextUsagePercentage: 25.5,
    });
  });

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
    expect(events).toEqual(["text:Hi ", "text:there", "heartbeat", "heartbeat", "heartbeat", "start:t1:bash", "delta", "delta", "tool_call_end", "done"]);
    expect(JSON.parse(args)).toEqual({ command: "echo hi" });
  });

  test("emits error for an exception frame", async () => {
    const frame = encodeMessage({ ":message-type": "exception", ":exception-type": "ThrottlingException" }, enc.encode("rate limited"));
    const out: string[] = [];
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(frame)))) {
      out.push(e.type === "error" ? `error:${e.message}` : e.type);
    }
    expect(out[0]).toBe("error:Kiro rate limit exceeded: ThrottlingException: rate limited");
  });

  test("exception frame is terminal: no trailing done", async () => {
    const errFrame = encodeMessage({ ":message-type": "exception", ":exception-type": "ThrottlingException" }, enc.encode("rate limited"));
    const contentFrame = eventFrame({ content: "leaked text" });
    const out: string[] = [];
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(errFrame, contentFrame)))) {
      out.push(e.type === "error" ? `error:${e.message}` : e.type);
    }
    expect(out).toEqual(["error:Kiro rate limit exceeded: ThrottlingException: rate limited"]);
    expect(out).not.toContain("done");
    expect(out).not.toContain("text_delta");
  });

  test("exception mid-stream closes an open tool call then stops", async () => {
    const start = eventFrame({ name: "shell", toolUseId: "tu_1" });
    const errFrame = encodeMessage({ ":message-type": "error", ":error-type": "InternalServerException" }, enc.encode("boom"));
    const tail = eventFrame({ content: "should not appear" });
    const out: string[] = [];
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(start, errFrame, tail)))) {
      out.push(e.type === "error" ? `error:${e.message}` : e.type);
    }
    expect(out).toEqual(["heartbeat", "error:Kiro upstream error: InternalServerException: boom"]);
    expect(out).not.toContain("tool_call_start");
    expect(out).not.toContain("tool_call_end");
    expect(out).not.toContain("done");
  });

  test("open tool input at EOF fails closed instead of emitting partial JSON", async () => {
    const frames = [
      eventFrame({ name: "bash", toolUseId: "t1" }),
      eventFrame({ input: '{"command":"ec', name: "bash", toolUseId: "t1" }),
    ];
    const out: string[] = [];
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(...frames)))) {
      if (e.type === "error") out.push(`error:${e.message}`);
      else if (e.type === "tool_call_delta") out.push(`delta:${e.arguments}`);
      else out.push(e.type);
    }
    expect(out).toEqual(["heartbeat", "heartbeat", "error:Kiro response truncated upstream before the tool call completed (stream ended before tool stop)"]);
    expect(out.some(item => item.startsWith("delta:"))).toBe(false);
    expect(out).not.toContain("done");
  });

  test("open tool with complete JSON but no stop is recovered at EOF", async () => {
    const frames = [
      eventFrame({ name: "bash", toolUseId: "t1" }),
      eventFrame({ input: '{"command":"pwd"}', name: "bash", toolUseId: "t1" }),
    ];
    const out: string[] = [];
    let args = "";
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(...frames)))) {
      if (e.type === "tool_call_delta") { args += e.arguments; out.push("delta"); }
      else out.push(e.type === "error" ? `error:${e.message}` : e.type);
    }
    expect(out).toEqual(["heartbeat", "heartbeat", "tool_call_start", "delta", "tool_call_end", "done"]);
    expect(JSON.parse(args)).toEqual({ command: "pwd" });
  });

  test("explicit Kiro truncation marker fails without done", async () => {
    const frame = eventFrame({ finish_reason: "max_tokens" });
    const out: string[] = [];
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(frame)))) {
      out.push(e.type === "error" ? `error:${e.message}` : e.type);
    }
    expect(out).toEqual(["error:Kiro response truncated upstream before the tool call completed (max_tokens)"]);
    expect(out).not.toContain("done");
  });

  test("duplicate tool name starts before input do not create duplicate tool calls", async () => {
    const frames = [
      eventFrame({ name: "bash", toolUseId: "t1" }),
      eventFrame({ name: "bash", toolUseId: "t1" }),
      eventFrame({ input: '{"command":"pwd"}', name: "bash", toolUseId: "t1" }),
      eventFrame({ name: "bash", stop: true, toolUseId: "t1" }),
    ];
    const starts: string[] = [];
    const events: string[] = [];
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(...frames)))) {
      if (e.type === "tool_call_start") starts.push(e.name);
      events.push(e.type);
    }
    expect(starts).toEqual(["bash"]);
    expect(events).toEqual(["heartbeat", "heartbeat", "heartbeat", "tool_call_start", "tool_call_delta", "tool_call_end", "done"]);
  });

  test("exception payload errors redact secrets, profile ARNs, raw JSON, and local paths", async () => {
    const secretPayload = JSON.stringify({
      __type: "ValidationException",
      message: "accessToken=aoa-secret refreshToken=rt-secret clientSecret=client-secret profile arn:aws:codewhisperer:us-east-1:123456789012:profile/demo path /Users/example/private/file.json",
      accessToken: "aoa-secret",
      refreshToken: "rt-secret",
      clientSecret: "client-secret",
      profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/demo",
    });
    const frame = encodeMessage({ ":message-type": "exception", ":exception-type": "ValidationException" }, enc.encode(secretPayload));
    const errors: string[] = [];
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(frame)))) {
      if (e.type === "error") errors.push(e.message);
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Kiro invalid request: ValidationException");
    expect(errors[0]).not.toContain("aoa-secret");
    expect(errors[0]).not.toContain("rt-secret");
    expect(errors[0]).not.toContain("client-secret");
    expect(errors[0]).not.toContain("arn:aws");
    expect(errors[0]).not.toContain("/Users/example");
    expect(errors[0]).not.toContain("{");
  });

  test("auth and model exceptions become actionable Kiro errors", async () => {
    const authFrame = encodeMessage(
      { ":message-type": "exception", ":exception-type": "AccessDeniedException" },
      enc.encode(JSON.stringify({ message: "expired token for profileArn=arn:aws:codewhisperer:us-east-1:123456789012:profile/demo" })),
    );
    const modelFrame = encodeMessage(
      { ":message-type": "exception", ":exception-type": "ValidationException" },
      enc.encode(JSON.stringify({ message: "model not found in this region" })),
    );
    const messages: string[] = [];
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(authFrame)))) {
      if (e.type === "error") messages.push(e.message);
    }
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(modelFrame)))) {
      if (e.type === "error") messages.push(e.message);
    }
    expect(messages[0]).toContain("Kiro authentication failed: AccessDeniedException");
    expect(messages[0]).not.toContain("arn:aws");
    expect(messages[1]).toContain("Kiro invalid request: ValidationException");
    expect(messages[1]).toContain("model not found");
  });

  test("stream parser catch path redacts thrown error details", async () => {
    const broken = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("decoder failed refreshToken=rt-secret clientSecret=client-secret /Users/example/private/file.json");
      },
    });
    const errors: string[] = [];
    for await (const e of createKiroAdapter(provider).parseStream(new Response(broken))) {
      if (e.type === "error") errors.push(e.message);
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Kiro upstream error");
    expect(errors[0]).not.toContain("rt-secret");
    expect(errors[0]).not.toContain("client-secret");
    expect(errors[0]).not.toContain("/Users/example");
  });

  test("leading thinking block is emitted as raw reasoning, not visible text", async () => {
    const frames = [eventFrame({ content: "<thinking>private plan</thinking>visible answer" })];
    const out: string[] = [];
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(...frames)))) {
      if (e.type === "reasoning_raw_delta") out.push(`reason:${e.text}`);
      else if (e.type === "text_delta") out.push(`text:${e.text}`);
      else out.push(e.type);
    }
    expect(out).toEqual(["reason:private plan", "text:visible answer", "done"]);
    expect(out.join("|")).not.toContain("<thinking>");
  });

  test("thinking tags split across chunks are parsed as reasoning", async () => {
    const frames = [
      eventFrame({ content: "<think" }),
      eventFrame({ content: "ing>split" }),
      eventFrame({ content: " thought</thinking>\nanswer" }),
    ];
    const out: string[] = [];
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(...frames)))) {
      if (e.type === "reasoning_raw_delta") out.push(`reason:${e.text}`);
      else if (e.type === "text_delta") out.push(`text:${e.text}`);
      else out.push(e.type);
    }
    expect(out).toEqual(["reason:split thought", "text:answer", "done"]);
  });

  test("non-leading thinking tag remains visible text", async () => {
    const frame = eventFrame({ content: "answer <thinking>literal</thinking>" });
    const out: string[] = [];
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(frame)))) {
      if (e.type === "text_delta") out.push(e.text);
    }
    expect(out.join("")).toBe("answer <thinking>literal</thinking>");
  });

  test("unterminated leading thinking block flushes as reasoning at stream end", async () => {
    const frames = [eventFrame({ content: "<reasoning>still private" })];
    const out: string[] = [];
    let reasoning = "";
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(...frames)))) {
      if (e.type === "reasoning_raw_delta") reasoning += e.text;
      else if (e.type === "text_delta") out.push(`text:${e.text}`);
      else out.push(e.type);
    }
    expect(reasoning).toBe("still private");
    expect(out).toEqual(["done"]);
  });

  test("done carries heuristic usage (input from current turn, output from streamed text)", async () => {
    const adapter = createKiroAdapter(provider);
    adapter.buildRequest(parsedWith([{ role: "user", content: "x".repeat(700) }]));
    const done = await doneUsage(adapter, eventFrame({ content: "y".repeat(350) }));
    expect(done.inputTokens).toBe(200);
    expect(done.outputTokens).toBe(100);
    expect(done.estimated).toBe(true);
  });

  test("Kiro contextUsagePercentage overrides total tokens for fixed-window models", async () => {
    const adapter = createKiroAdapter(provider);
    adapter.buildRequest(parsedWith([{ role: "user", content: "x".repeat(700) }]));
    const done = await doneUsage(
      adapter,
      eventFrame({ content: "y".repeat(350) }),
      eventFrame({ contextUsagePercentage: 25 }),
    );

    expect(done.inputTokens).toBe(200);
    expect(done.outputTokens).toBe(100);
    expect(done.totalTokens).toBe(50_000);
    expect(done.estimated).toBe(true);
  });

  test("Kiro auto ignores provider-level context window and falls back to heuristic totals", async () => {
    const adapter = createKiroAdapter({ ...provider, contextWindow: 200_000 });
    adapter.buildRequest(parsedWith([{ role: "user", content: "x".repeat(700) }], undefined, "kiro-auto"));
    const done = await doneUsage(
      adapter,
      eventFrame({ content: "y".repeat(350) }),
      eventFrame({ contextUsagePercentage: 25 }),
    );

    expect(done.inputTokens).toBe(200);
    expect(done.outputTokens).toBe(100);
    expect(done.totalTokens).toBeUndefined();
  });

  test("fresh payload includes history while usage counts only the current turn", async () => {
    const latest = "please summarize recent commits";
    const shortMessages = [
      { role: "user", content: "old question" },
      { role: "assistant", content: [{ type: "text", text: "old answer" }] },
      { role: "user", content: latest },
    ];
    const longMessages = [
      { role: "user", content: "u".repeat(8000) },
      { role: "assistant", content: [{ type: "text", text: "a".repeat(8000) }] },
      { role: "user", content: "another old question" },
      { role: "assistant", content: [{ type: "text", text: "another old answer" }] },
      { role: "user", content: latest },
    ];
    const shortAdapter = createKiroAdapter(provider);
    const shortBody = shortAdapter.buildRequest(parsedWith(shortMessages)).body;
    const shortUsage = await doneUsage(shortAdapter, eventFrame({ content: "ok" }));
    const longAdapter = createKiroAdapter(provider);
    const longBody = longAdapter.buildRequest(parsedWith(longMessages)).body;
    const longUsage = await doneUsage(longAdapter, eventFrame({ content: "ok" }));
    expect(longBody.length).toBeGreaterThan(shortBody.length + 10_000);
    expect(longUsage.inputTokens).toBe(shortUsage.inputTokens);
    expect(longUsage.inputTokens).toBe(estimateTokens(latest, "claude-sonnet-4.5"));
  });

  test("request log usage estimates the full Codex context while SSE usage stays current-turn", async () => {
    const latest = "please summarize recent commits";
    const messages = [
      { role: "user", content: "u".repeat(8000) },
      { role: "assistant", content: [{ type: "text", text: "a".repeat(8000) }] },
      { role: "user", content: latest },
    ];
    const adapter = createKiroAdapter(provider);
    const request = adapter.buildRequest(parsedWith(messages));
    const usage = await doneUsage(adapter, eventFrame({ content: "ok" }));

    expect(usage.inputTokens).toBe(estimateTokens(latest, "claude-sonnet-4.5"));
    expect(request.usageLog?.estimated).toBe(true);
    expect(request.usageLog?.inputTokens).toBeGreaterThan(usage.inputTokens + 4000);
  });

  test("resumed payload sends only the current turn instead of repeated history", async () => {
    const latest = "please summarize recent commits";
    const oldHistory = [
      { role: "user", content: "u".repeat(8000) },
      { role: "assistant", content: [{ type: "text", text: "a".repeat(8000) }] },
      { role: "user", content: "another old question" },
      { role: "assistant", content: [{ type: "text", text: "another old answer" }] },
    ];
    const freshBody = createKiroAdapter(provider).buildRequest(parsedWith([...oldHistory, { role: "user", content: latest }])).body;
    const resumedAdapter = createKiroAdapter(provider);
    const resumedBody = resumedAdapter.buildRequest({
      ...parsedWith([...oldHistory, { role: "user", content: latest }]),
      previousResponseId: "kiro-prev-1",
    }).body;
    const resumedUsage = await doneUsage(resumedAdapter, eventFrame({ content: "ok" }));
    const cs = JSON.parse(resumedBody).conversationState;
    expect(freshBody.length).toBeGreaterThan(resumedBody.length + 10_000);
    expect(cs.history).toBeUndefined();
    expect(cs.currentMessage.userInputMessage.content).toBe(latest);
    expect(resumedUsage.inputTokens).toBe(estimateTokens(latest, "claude-sonnet-4.5"));
  });

  test("tool-result follow-up counts new tool output without re-counting prior assistant tool args", async () => {
    const hugeArgs = { command: "x".repeat(8000) };
    const messages = [
      { role: "user", content: "run a command" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: hugeArgs }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: "done", isError: false },
    ];
    const adapter = createKiroAdapter(provider);
    const body = adapter.buildRequest(parsedWith(messages)).body;
    const usage = await doneUsage(adapter, eventFrame({ content: "ok" }));
    expect(body).toContain("x".repeat(8000));
    expect(usage.inputTokens).toBeLessThan(50);
    expect(usage.inputTokens).toBeGreaterThan(0);
  });

  test("resumed tool-result payload preserves the matching assistant toolUse context", async () => {
    const messages = [
      { role: "user", content: "run a command" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: "/tmp", isError: false },
    ];
    const { body } = createKiroAdapter(provider).buildRequest({ ...parsedWith(messages, [bashTool]), previousResponseId: "kiro-prev-1" });
    const cs = JSON.parse(body).conversationState;
    expect(cs.history).toHaveLength(2);
    expect(cs.history[0].userInputMessage.content).toBe("run a command");
    expect(cs.history[1].assistantResponseMessage.toolUses).toEqual([
      { name: "bash", input: { command: "pwd" }, toolUseId: "call-1" },
    ]);
    expect(cs.currentMessage.userInputMessage.content).toBe("(tool results)");
    expect(cs.currentMessage.userInputMessage.userInputMessageContext.toolResults).toEqual([
      { content: [{ text: "/tmp" }], status: "success", toolUseId: "call-1" },
    ]);
  });

  test("resumed tool-result usage remains current-turn only after payload repair", async () => {
    const messages = [
      { role: "user", content: "u".repeat(8000) },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "x".repeat(8000) } }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: "done", isError: false },
    ];
    const adapter = createKiroAdapter(provider);
    adapter.buildRequest({ ...parsedWith(messages), previousResponseId: "kiro-prev-1" });
    const usage = await doneUsage(adapter, eventFrame({ content: "ok" }));
    expect(usage.inputTokens).toBeLessThan(50);
    expect(usage.inputTokens).toBeGreaterThan(0);
  });

  test("buildRequest emits only redacted Kiro diagnostic breadcrumbs when enabled", () => {
    process.env.OCX_DEBUG_FRAMES = "1";
    process.env.KIRO_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:123456789012:profile/demo";
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      createKiroAdapter(provider).buildRequest(parsedWith([{ role: "user", content: "secret prompt body" }], [bashTool]));
      expect(error).toHaveBeenCalledTimes(1);
      const line = String(error.mock.calls[0]?.[0] ?? "");
      expect(line).toContain("[ocx:kiro:request]");
      expect(line).toContain("\"region\":\"us-east-1\"");
      expect(line).toContain("\"hasProfileArn\":true");
      expect(line).not.toContain("secret prompt body");
      expect(line).not.toContain("tok-123");
      expect(line).not.toContain("arn:aws:codewhisperer");
    } finally {
      error.mockRestore();
    }
  });
});

describe("kiro adapter — parseResponse (web-search sidecar non-streaming path)", () => {
  test("adapter exposes parseResponse so the web_search sidecar accepts kiro", () => {
    expect(typeof createKiroAdapter(provider).parseResponse).toBe("function");
  });

  test("drains the same CW eventstream into an AdapterEvent[] (parity with parseStream)", async () => {
    const frames = [
      eventFrame({ content: "Hi " }),
      eventFrame({ content: "there" }),
      eventFrame({ name: "bash", toolUseId: "t1" }),
      eventFrame({ input: '{"q":1}', name: "bash", toolUseId: "t1" }),
      eventFrame({ name: "bash", stop: true, toolUseId: "t1" }),
    ];
    const events = await createKiroAdapter(provider).parseResponse!(new Response(streamOf(...frames)));
    expect(events.map(e => e.type)).toEqual([
      "text_delta", "text_delta", "heartbeat", "heartbeat", "tool_call_start", "tool_call_delta", "tool_call_end", "done",
    ]);
    const start = events.find(e => e.type === "tool_call_start") as { id: string; name: string };
    expect(start).toMatchObject({ id: "t1", name: "bash" });
  });
});
