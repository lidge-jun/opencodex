/**
 * Claude OAuth (Pro/Max) requests carry the caller's own system prompt as the first block of the
 * first user turn. Anthropic's overage classifier reads the top-level `system` array as the
 * client identity, and caller text there makes it bill the turn as third-party traffic. The
 * top-level array stays the Claude Code identity for every request.
 */
import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../../../src/adapters/anthropic";
import { CLAUDE_CODE_SYSTEM_INSTRUCTION } from "../../../src/oauth/anthropic";
import type { OcxMessage, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

const CALLER_SYSTEM = "You are an AI agent running in OpenCode, a coding agent harness.";

interface WireBlock { type: string; text?: string; cache_control?: unknown }
interface WireMessage { role: string; content: string | WireBlock[] }
interface WireBody { system: WireBlock[]; messages: WireMessage[] }

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

  test("a first turn that is not a user message keeps the text in the top-level array", async () => {
    const body = await bodyOf(parsed([
      { role: "assistant", content: [{ type: "text", text: "prefill" }], timestamp: 0 },
      { role: "user", content: "hello", timestamp: 0 },
    ], [CALLER_SYSTEM]));

    expect(texts(body.system)).toEqual([CLAUDE_CODE_SYSTEM_INSTRUCTION, CALLER_SYSTEM]);
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
