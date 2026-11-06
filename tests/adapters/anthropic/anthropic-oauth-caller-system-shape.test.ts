/**
 * Claude OAuth (Pro/Max) requests carry the caller's own system prompt as the first block of the
 * first user turn. A captured OpenCode request was rejected with instructions in top-level
 * system and accepted after relocation. Proxy-owned tool guidance stays in system.
 */
import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../../../src/adapters/anthropic";
import { CLAUDE_CODE_SYSTEM_INSTRUCTION } from "../../../src/oauth/anthropic";
import type { OcxMessage, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

const CALLER_SYSTEM = "You are an AI agent running in OpenCode, a coding agent harness.";

interface WireBlock { type: string; text?: string; cache_control?: unknown }
interface WireMessage { role: string; content: string | WireBlock[] }
interface WireBody { system: WireBlock[]; messages: WireMessage[]; tools?: unknown[] }

/** Fixture provider; `oauth` unless a case overrides it. */
function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKey: "fixture-oauth-access-token",
    authMode: "oauth",
    ...overrides,
  } as OcxProviderConfig;
}

/** Parsed request with an optional caller system prompt. */
function parsed(messages: OcxMessage[], systemPrompt?: string[]): OcxParsedRequest {
  return {
    modelId: "claude-opus-5-5",
    stream: false,
    options: {},
    context: { messages, ...(systemPrompt ? { systemPrompt } : {}) },
  };
}

/** Build the outbound Messages body for a fixture request. */
async function bodyOf(request: OcxParsedRequest, configured = provider()): Promise<WireBody> {
  const { body } = await createAnthropicAdapter(configured).buildRequest(request);
  return JSON.parse(typeof body === "string" ? body : JSON.stringify(body)) as WireBody;
}

/** Text sequence of a message or system array; cache markers are out of scope here. */
function texts(blocks: WireBlock[] | string | undefined): (string | undefined)[] {
  if (blocks === undefined) return [];
  if (typeof blocks === "string") return [blocks];
  return blocks.map(block => block.text);
}

/** First block of a wire message, for the relocated prefix and its cache marker. */
function leadBlock(message: WireMessage | undefined): WireBlock | undefined {
  if (!message || typeof message.content === "string") return undefined;
  return message.content[0];
}

describe("anthropic oauth caller system shape", () => {
  test("relocated instructions preserve the stable cache prefix ahead of a changing tail", async () => {
    for (const tail of ["Environment A", "Environment B"]) {
      const request = parsed([{ role: "user", content: "hello", timestamp: 0 }], [CALLER_SYSTEM + "\n\n" + tail]);
      request._anthropicSystemCachePrefix = CALLER_SYSTEM;
      const body = await bodyOf(request);
      expect(texts(body.system)).toEqual([CLAUDE_CODE_SYSTEM_INSTRUCTION]);
      expect(texts(body.messages[0]?.content)).toEqual([CALLER_SYSTEM, tail, "hello"]);
      const blocks = body.messages[0]?.content as WireBlock[];
      expect(blocks[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
      expect(blocks[1]?.cache_control).toBeUndefined();
    }
  });

  test("caller instructions travel in the first user turn, not the top-level system array", async () => {
    const body = await bodyOf(parsed([{ role: "user", content: "hello", timestamp: 0 }], [CALLER_SYSTEM]));

    expect(texts(body.system)).toEqual([CLAUDE_CODE_SYSTEM_INSTRUCTION]);
    expect(texts(body.messages[0]?.content)).toEqual([CALLER_SYSTEM, "hello"]);
    expect(body.system[0]?.cache_control).toBeUndefined();
    // The relocated prefix keeps the explicit breakpoint, so requests that share the caller
    // prompt reuse it even when their first user content differs.
    expect(leadBlock(body.messages[0])?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("the identity block stays first and is the only top-level system block", async () => {
    const body = await bodyOf(parsed([
      { role: "user", content: "hello", timestamp: 0 },
      { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 0 },
      { role: "user", content: "again", timestamp: 0 },
    ], [CALLER_SYSTEM]));

    expect(texts(body.system)).toEqual([CLAUDE_CODE_SYSTEM_INSTRUCTION]);
    expect(JSON.stringify(body.system)).not.toContain("OpenCode");
    // Roles and content survive the move; only the first user turn gained a leading block.
    expect(body.messages.map(message => message.role)).toEqual(["user", "assistant", "user"]);
    expect(body.messages.map(message => texts(message.content))).toEqual([
      [CALLER_SYSTEM, "hello"],
      ["hi"],
      ["again"],
    ]);
  });

  test("a block-array first turn keeps its blocks after the moved instructions", async () => {
    const body = await bodyOf(parsed([{
      role: "user",
      content: [{ type: "text", text: "first part" }, { type: "text", text: "second part" }],
      timestamp: 0,
    }], [CALLER_SYSTEM]));

    expect(texts(body.messages[0]?.content)).toEqual([CALLER_SYSTEM, "first part", "second part"]);
  });

  test("with no caller system prompt nothing moves", async () => {
    const body = await bodyOf(parsed([{ role: "user", content: "hello", timestamp: 0 }]));

    expect(texts(body.system)).toEqual([CLAUDE_CODE_SYSTEM_INSTRUCTION]);
    expect(texts(body.messages[0]?.content)).toEqual(["hello"]);
  });

  test("an assistant-leading history gets a separate initial instruction turn", async () => {
    const body = await bodyOf(parsed([
      { role: "assistant", content: [{ type: "text", text: "prefill" }], timestamp: 0 },
      { role: "user", content: "hello", timestamp: 0 },
    ], [CALLER_SYSTEM]));

    expect(texts(body.system)).toEqual([CLAUDE_CODE_SYSTEM_INSTRUCTION]);
    expect(body.messages.map(message => message.role)).toEqual(["user", "assistant", "user"]);
    expect(body.messages.map(message => texts(message.content))).toEqual([[CALLER_SYSTEM], ["prefill"], ["hello"]]);
  });

  test("caller relocation leaves tool declarations and the proxy tool contract unchanged", async () => {
    const request = parsed([{ role: "user", content: "hello", timestamp: 0 }]);
    request.context.tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }];
    const baseline = await bodyOf(request);
    const body = await bodyOf({ ...request, context: { ...request.context, systemPrompt: [CALLER_SYSTEM] } });
    expect(texts(body.system)).toEqual(texts(baseline.system));
    expect(texts(body.system)[1]).toContain("Tool contract:");
    expect(texts(body.messages[0]?.content)).toEqual([CALLER_SYSTEM, "hello"]);
    expect(body.tools).toEqual(baseline.tools);
  });

  test("an assistant-leading tool exchange retains adjacent call and result messages", async () => {
    const request = parsed([
      { role: "assistant", content: [{ type: "toolCall", id: "toolu_read", name: "read", arguments: {} }], timestamp: 0 },
      { role: "toolResult", toolCallId: "toolu_read", toolName: "read", content: "file contents", isError: false, timestamp: 0 },
    ], [CALLER_SYSTEM]);
    const body = await bodyOf(request);
    expect(body.messages.map(message => message.role)).toEqual(["user", "assistant", "user"]);
    expect(texts(body.messages[0]?.content)).toEqual([CALLER_SYSTEM]);
    expect(body.messages[1]?.content).toEqual([expect.objectContaining({ type: "tool_use", id: "toolu_read" })]);
    expect(body.messages[2]?.content).toEqual([expect.objectContaining({ type: "tool_result", tool_use_id: "toolu_read", content: "file contents" })]);
    expect(texts(body.system)).toEqual([CLAUDE_CODE_SYSTEM_INSTRUCTION]);
  });

  test("multiple caller instruction blocks retain their order", async () => {
    const body = await bodyOf(parsed([{ role: "user", content: "hello", timestamp: 0 }], [CALLER_SYSTEM, "Workspace instructions"]));
    expect(texts(body.messages[0]?.content)).toEqual([CALLER_SYSTEM + "\n\nWorkspace instructions", "hello"]);
  });

  test("an API-key provider keeps the caller system in the top-level array", async () => {
    const body = await bodyOf(
      parsed([{ role: "user", content: "hello", timestamp: 0 }], [CALLER_SYSTEM]),
      provider({ authMode: "key", apiKey: "sk-fixture" }),
    );

    expect(texts(body.system)).toEqual([CALLER_SYSTEM]);
    expect(texts(body.messages[0]?.content)).toEqual(["hello"]);
  });
});
