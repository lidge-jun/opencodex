import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKiroAdapter } from "../src/adapters/kiro";
import { normalizeKiroModelId } from "../src/providers/kiro-models";
import { configuredReasoningEfforts, mapReasoningEffort } from "../src/reasoning-effort";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

const origHome = process.env.HOME;
const origRegion = process.env.KIRO_REGION;
const origApiRegion = process.env.KIRO_API_REGION;
const origArn = process.env.KIRO_PROFILE_ARN;
const origCredsFile = process.env.KIRO_CREDS_FILE;
const origCredentialsFile = process.env.KIRO_CREDENTIALS_FILE;
let tmp: string;

beforeEach(() => {
  // isolate: empty HOME so no kiro-cli SQLite is read; deterministic region.
  tmp = mkdtempSync(join(tmpdir(), "kiro-adapter-"));
  process.env.HOME = tmp;
  process.env.KIRO_REGION = "us-east-1";
  delete process.env.KIRO_API_REGION;
  delete process.env.KIRO_PROFILE_ARN;
  delete process.env.KIRO_CREDS_FILE;
  delete process.env.KIRO_CREDENTIALS_FILE;
});
afterEach(() => {
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origRegion === undefined) delete process.env.KIRO_REGION; else process.env.KIRO_REGION = origRegion;
  if (origApiRegion === undefined) delete process.env.KIRO_API_REGION; else process.env.KIRO_API_REGION = origApiRegion;
  if (origArn === undefined) delete process.env.KIRO_PROFILE_ARN; else process.env.KIRO_PROFILE_ARN = origArn;
  if (origCredsFile === undefined) delete process.env.KIRO_CREDS_FILE; else process.env.KIRO_CREDS_FILE = origCredsFile;
  if (origCredentialsFile === undefined) delete process.env.KIRO_CREDENTIALS_FILE; else process.env.KIRO_CREDENTIALS_FILE = origCredentialsFile;
  rmSync(tmp, { recursive: true, force: true });
});

const provider = { adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev", authMode: "oauth", apiKey: "tok-123" } as unknown as OcxProviderConfig;
const bashTool = { name: "bash", description: "Run a shell command", parameters: { type: "object" } };

function parsedWith(messages: unknown[], tools?: unknown[], modelId = "claude-sonnet-4.5"): OcxParsedRequest {
  return { modelId, stream: true, options: {}, context: { messages, tools } } as unknown as OcxParsedRequest;
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

  test("runtime URL uses KIRO_API_REGION separately from auth region", () => {
    process.env.KIRO_REGION = "us-east-1";
    process.env.KIRO_API_REGION = "ap-northeast-2";

    const { url } = createKiroAdapter(provider).buildRequest(parsedWith([{ role: "user", content: "hi" }]));

    expect(url).toBe("https://runtime.ap-northeast-2.kiro.dev/");
  });

  test("runtime URL rejects host-injection KIRO_API_REGION values", () => {
    for (const value of ["us-east-1/../../evil", "us-east-1@evil.test", "https://evil.test", "../us-east-1"]) {
      process.env.KIRO_API_REGION = value;
      expect(() => createKiroAdapter(provider).buildRequest(parsedWith([{ role: "user", content: "hi" }]))).toThrow(
        "Kiro: invalid region value.",
      );
      try {
        createKiroAdapter(provider).buildRequest(parsedWith([{ role: "user", content: "hi" }]));
      } catch (err) {
        expect(err instanceof Error ? err.message : String(err)).not.toContain(value);
      }
    }
  });

  test("normalizes versioned and effort-suffixed model aliases for Kiro payloads", () => {
    for (const [input, expected] of [
      ["kiro-auto", "auto"],
      ["auto", "auto"],
      ["claude-sonnet-4-5-20250929", "claude-sonnet-4.5"],
      ["claude-4.5-sonnet-high", "claude-sonnet-4.5"],
      ["claude-4-5-opus-max", "claude-opus-4.5"],
      ["minimax-m2-1", "minimax-m2.1"],
    ]) {
      expect(normalizeKiroModelId(input)).toBe(expected);
      const { body } = createKiroAdapter(provider).buildRequest(parsedWith([{ role: "user", content: "hi" }], undefined, input));
      expect(JSON.parse(body).conversationState.currentMessage.userInputMessage.modelId).toBe(expected);
    }
  });

  test("toolUses[].input is a JSON object (not stringified) and toolResults are adjacent", () => {
    const messages = [
      { role: "user", content: "run it" },
      { role: "assistant", content: [{ type: "toolCall", id: "call|1", name: "bash", arguments: { command: "echo hi" } }] },
      { role: "toolResult", toolCallId: "call|1", toolName: "bash", content: "hi", isError: false },
    ];
    const { body } = createKiroAdapter(provider).buildRequest(parsedWith(messages, [bashTool]));
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

  test("tool result images are attached to Kiro carrier user messages", () => {
    const messages = [
      { role: "user", content: "look" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "get_app_state", arguments: {} }] },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "get_app_state",
        content: [
          { type: "text", text: "Looked at Google Chrome" },
          { type: "image", imageUrl: "data:image/png;base64,aGVsbG8=", detail: "high" },
        ],
        isError: false,
      },
    ];
    const { body } = createKiroAdapter(provider).buildRequest(
      parsedWith(messages, [{ name: "get_app_state", description: "Look at app", parameters: { type: "object" } }]),
    );
    const current = JSON.parse(body).conversationState.currentMessage.userInputMessage;

    expect(current.userInputMessageContext.toolResults[0].content[0].text).toBe("Looked at Google Chrome");
    expect(current.images).toEqual([{ format: "png", source: { bytes: "aGVsbG8=" } }]);
  });

  test("tools map to toolSpecification", () => {
    const { body } = createKiroAdapter(provider).buildRequest(
      parsedWith([{ role: "user", content: "hi" }], [{ name: "grep", description: "search", parameters: { type: "object" } }]),
    );
    const ctx = JSON.parse(body).conversationState.currentMessage.userInputMessage.userInputMessageContext;
    expect(ctx.tools[0].toolSpecification.name).toBe("grep");
    expect(ctx.tools[0].toolSpecification.inputSchema.json).toEqual({ type: "object" });
  });

  test("namespaced (MCP) tools advertise + replay the full wire name", () => {
    const adapter = createKiroAdapter(provider);
    // Tool spec advertised to Kiro must carry the full namespaced name so the bridge's toolNsMap
    // (keyed by namespace__name) can restore the MCP namespace when Kiro echoes the name back.
    const specBody = adapter.buildRequest(
      parsedWith(
        [{ role: "user", content: "hi" }],
        [{ name: "navigate_page", namespace: "mcp__chrome-devtools", description: "navigate", parameters: { type: "object" } }],
      ),
    ).body;
    const specCtx = JSON.parse(specBody).conversationState.currentMessage.userInputMessage.userInputMessageContext;
    expect(specCtx.tools[0].toolSpecification.name).toBe("mcp__chrome-devtools__navigate_page");

    // Replayed assistant tool calls in history must use the same wire name.
    const replayBody = adapter.buildRequest(
      parsedWith(
        [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "call_1", name: "navigate_page", namespace: "mcp__chrome-devtools", arguments: { url: "x" } }],
          },
          { role: "toolResult", toolCallId: "call_1", toolName: "navigate_page", content: "ok", isError: false },
        ],
        [{ name: "navigate_page", namespace: "mcp__chrome-devtools", description: "navigate", parameters: { type: "object" } }],
      ),
    ).body;
    const history = JSON.parse(replayBody).conversationState.history;
    const replayed = history.find((e: { assistantResponseMessage?: { toolUses?: { name: string }[] } }) => e.assistantResponseMessage?.toolUses);
    expect(replayed.assistantResponseMessage.toolUses[0].name).toBe("mcp__chrome-devtools__navigate_page");
  });

  test("long namespaced tool names are preserved rather than truncated", () => {
    const wireName = "mcp__very-long-computer-use-namespace-with-browser-state__look_at_current_applications";
    const { body } = createKiroAdapter(provider).buildRequest(
      parsedWith(
        [{ role: "user", content: "hi" }],
        [{
          name: "look_at_current_applications",
          namespace: "mcp__very-long-computer-use-namespace-with-browser-state",
          description: "look",
          parameters: { type: "object" },
        }],
      ),
    );
    const ctx = JSON.parse(body).conversationState.currentMessage.userInputMessage.userInputMessageContext;
    expect(wireName.length).toBeGreaterThan(64);
    expect(ctx.tools[0].toolSpecification.name).toBe(wireName);
  });

  test("tool schemas remove Kiro-rejected fields recursively", () => {
    const parameters = {
      type: "object",
      required: [],
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        options: {
          type: "object",
          required: ["mode"],
          additionalProperties: false,
          properties: { mode: { type: "string" } },
        },
      },
    };
    const { body } = createKiroAdapter(provider).buildRequest(
      parsedWith([{ role: "user", content: "hi" }], [{ name: "bash", description: "Run command", parameters }]),
    );
    const schema = JSON.parse(body).conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[0].toolSpecification.inputSchema.json;

    expect(schema.required).toBeUndefined();
    expect(schema.additionalProperties).toBeUndefined();
    expect(schema.properties.options.required).toEqual(["mode"]);
    expect(schema.properties.options.additionalProperties).toBeUndefined();
  });

  test("long tool descriptions move into the system prompt instead of being truncated away", () => {
    const longDescription = `Long docs ${"x".repeat(1100)} keep this tail.`;
    const { body } = createKiroAdapter(provider).buildRequest(
      parsedWith([{ role: "user", content: "hi" }], [{ name: "longtool", description: longDescription, parameters: { type: "object" } }]),
    );
    const current = JSON.parse(body).conversationState.currentMessage.userInputMessage;
    const spec = current.userInputMessageContext.tools[0].toolSpecification;

    expect(spec.description).toBe("Tool documentation moved to the system prompt: longtool.");
    expect(current.content).toContain("### Tool documentation: longtool");
    expect(current.content).toContain(longDescription);
  });

  test("no-tools fallback converts assistant tool calls and tool results to text", () => {
    const messages = [
      { role: "user", content: "run it" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: "/tmp", isError: false },
    ];
    const { body } = createKiroAdapter(provider).buildRequest(parsedWith(messages));
    const cs = JSON.parse(body).conversationState;
    const assistant = cs.history.find((h: { assistantResponseMessage?: unknown }) => h.assistantResponseMessage).assistantResponseMessage;
    const current = cs.currentMessage.userInputMessage;

    expect(assistant.toolUses).toBeUndefined();
    expect(assistant.content).toContain("Tool call fallback (bash, id call-1):");
    expect(current.content).toContain("Tool result fallback (bash, id call-1, success):");
    expect(current.userInputMessageContext).toBeUndefined();
  });

  test("orphaned tool results fall back to text even when tools are available", () => {
    const messages = [
      { role: "toolResult", toolCallId: "missing-call", toolName: "bash", content: "orphaned", isError: true },
    ];
    const { body } = createKiroAdapter(provider).buildRequest(parsedWith(messages, [bashTool]));
    const current = JSON.parse(body).conversationState.currentMessage.userInputMessage;

    expect(current.content).toContain("Tool result fallback (bash, id missing-call, error):");
    expect(current.userInputMessageContext.toolResults).toBeUndefined();
    expect(current.userInputMessageContext.tools).toHaveLength(1);
  });
});

describe("kiro adapter — fake reasoning effort tags", () => {
  const kiro = PROVIDER_REGISTRY.find(p => p.id === "kiro") as unknown as OcxProviderConfig;

  test("kiro advertises Codex-compatible reasoning efforts", () => {
    expect(kiro).toBeTruthy();
    expect(configuredReasoningEfforts(kiro, "claude-opus-4.8")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(configuredReasoningEfforts(kiro, "claude-opus-4.5")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(configuredReasoningEfforts(kiro, "kiro-auto")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(configuredReasoningEfforts(kiro, "claude-opus-4.5")).not.toContain("max");
  });

  test("mapReasoningEffort keeps Codex xhigh rather than advertising max", () => {
    expect(mapReasoningEffort(kiro, "claude-opus-4.8", "xhigh")).toBe("xhigh");
    expect(mapReasoningEffort(kiro, "deepseek-3.2", "max")).toBe("xhigh");
  });

  test("xhigh injects current-message thinking tags with a 95% output-token budget", () => {
    const { body } = createKiroAdapter(provider).buildRequest({
      ...parsedWith([{ role: "user", content: "solve it" }]),
      options: { reasoning: "xhigh", maxOutputTokens: 8000 },
    });
    const content = JSON.parse(body).conversationState.currentMessage.userInputMessage.content;

    expect(content).toContain("<thinking_mode>enabled</thinking_mode>");
    expect(content).toContain("<max_thinking_length>7600</max_thinking_length>");
    expect(content).toContain("solve it");
  });

  test("reasoning tags are not injected into tool-result carrier turns", () => {
    const messages = [
      { role: "user", content: "run a command" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: "/tmp", isError: false },
    ];
    const { body } = createKiroAdapter(provider).buildRequest({ ...parsedWith(messages, [bashTool]), options: { reasoning: "high" } });
    const content = JSON.parse(body).conversationState.currentMessage.userInputMessage.content;

    expect(content).toBe("(tool results)");
    expect(content).not.toContain("<thinking_mode>");
  });
});

describe("kiro adapter — per-model context windows (kiro.dev/docs/models)", () => {
  const kiro = PROVIDER_REGISTRY.find(p => p.id === "kiro") as unknown as OcxProviderConfig;
  const cw = kiro.modelContextWindows ?? {};

  test("registry includes the currently documented Kiro models", () => {
    for (const id of ["claude-opus-4.5", "claude-sonnet-4.0", "minimax-m2.1"]) {
      expect(kiro.models ?? []).toContain(id);
    }
  });

  test("1M-context models map to 1_000_000", () => {
    for (const id of ["claude-opus-4.8", "claude-opus-4.7", "claude-opus-4.6", "claude-sonnet-4.6"]) {
      expect(cw[id]).toBe(1_000_000);
    }
  });

  test("smaller-context models match Kiro's published limits", () => {
    expect(cw["claude-opus-4.5"]).toBe(200_000);
    expect(cw["claude-sonnet-4.5"]).toBe(200_000);
    expect(cw["claude-sonnet-4.0"]).toBe(200_000);
    expect(cw["claude-haiku-4.5"]).toBe(200_000);
    expect(cw["minimax-m2.5"]).toBe(200_000);
    expect(cw["minimax-m2.1"]).toBe(200_000);
    expect(cw["glm-5"]).toBe(200_000);
    expect(cw["deepseek-3.2"]).toBe(128_000);
    expect(cw["qwen3-coder-next"]).toBe(256_000);
  });

  test("Auto router has no fixed window (omitted)", () => {
    expect(cw["kiro-auto"]).toBeUndefined();
  });
});
