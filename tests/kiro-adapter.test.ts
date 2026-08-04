import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKiroAdapter } from "../src/adapters/kiro";
import { KIRO_TOOL_RESULT_CARRIER_MESSAGE } from "../src/adapters/kiro-constants";
import { MAX_KIRO_TOOL_CATALOG_BYTES, MAX_KIRO_TOOL_COUNT } from "../src/adapters/kiro-tools";
import { applyProviderConfigHints, buildCatalogEntries } from "../src/codex/catalog";
import { getValidAccessTokenSnapshot } from "../src/oauth";
import { saveCredential } from "../src/oauth/store";
import { normalizeKiroModelId } from "../src/providers/kiro-models";
import { configuredReasoningEfforts, mapReasoningEffort } from "../src/reasoning-effort";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

const origHome = process.env.HOME;
const origLocalAppData = process.env.LOCALAPPDATA;
const origUserProfile = process.env.USERPROFILE;
const origRegion = process.env.KIRO_REGION;
const origApiRegion = process.env.KIRO_API_REGION;
const origArn = process.env.KIRO_PROFILE_ARN;
const origCredsFile = process.env.KIRO_CREDS_FILE;
const origCredentialsFile = process.env.KIRO_CREDENTIALS_FILE;
const origOcxHome = process.env.OPENCODEX_HOME;
let tmp: string;

beforeEach(() => {
  // isolate: empty HOME so no kiro-cli SQLite is read; deterministic region.
  // The native store resolves per-platform (issue #710) and win32 prefers LOCALAPPDATA/USERPROFILE
  // over HOME, so an empty HOME alone would no longer keep a Windows runner off its real profile.
  tmp = mkdtempSync(join(tmpdir(), "kiro-adapter-"));
  process.env.HOME = tmp;
  process.env.LOCALAPPDATA = join(tmp, "AppData", "Local");
  process.env.USERPROFILE = tmp;
  process.env.OPENCODEX_HOME = tmp;
  process.env.KIRO_REGION = "us-east-1";
  delete process.env.KIRO_API_REGION;
  delete process.env.KIRO_PROFILE_ARN;
  delete process.env.KIRO_CREDS_FILE;
  delete process.env.KIRO_CREDENTIALS_FILE;
});
afterEach(() => {
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origLocalAppData === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = origLocalAppData;
  if (origUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = origUserProfile;
  if (origRegion === undefined) delete process.env.KIRO_REGION; else process.env.KIRO_REGION = origRegion;
  if (origApiRegion === undefined) delete process.env.KIRO_API_REGION; else process.env.KIRO_API_REGION = origApiRegion;
  if (origArn === undefined) delete process.env.KIRO_PROFILE_ARN; else process.env.KIRO_PROFILE_ARN = origArn;
  if (origCredsFile === undefined) delete process.env.KIRO_CREDS_FILE; else process.env.KIRO_CREDS_FILE = origCredsFile;
  if (origCredentialsFile === undefined) delete process.env.KIRO_CREDENTIALS_FILE; else process.env.KIRO_CREDENTIALS_FILE = origCredentialsFile;
  if (origOcxHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = origOcxHome;
  rmSync(tmp, { recursive: true, force: true });
});

const provider = { adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev", authMode: "oauth", apiKey: "tok-123" } as unknown as OcxProviderConfig;
const bashTool = { name: "bash", description: "Run a shell command", parameters: { type: "object" } };

function parsedWith(messages: unknown[], tools?: unknown[], modelId = "claude-sonnet-4.5"): OcxParsedRequest {
  return { modelId, stream: true, options: {}, context: { messages, tools } } as unknown as OcxParsedRequest;
}

function seedKiroCliMetadata(profileArn: string, region: string): void {
  // Host-resolved layout (issue #710): mirrors resolveKiroCliNativeSessionEntries.
  const dir = process.platform === "win32"
    ? join(tmp, "AppData", "Local", "Kiro-Cli")
    : process.platform === "darwin"
      ? join(tmp, "Library", "Application Support", "kiro-cli")
      : join(tmp, ".local", "share", "kiro-cli");
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "data.sqlite3"));
  db.run("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)");
  db.run("INSERT INTO auth_kv (key, value) VALUES (?, ?)", [
    "kirocli:social:token",
    JSON.stringify({ access_token: "local-access", refresh_token: "local-refresh", profile_arn: profileArn, region }),
  ]);
  db.close();
}

describe("kiro adapter — buildRequest", () => {
  test("rejects missing and blank Kiro tokens before building a request", async () => {
    for (const apiKey of [undefined, "", "   "]) {
      const keyless = { ...provider, apiKey } as unknown as OcxProviderConfig;
      await expect(createKiroAdapter(keyless).buildRequest(parsedWith([{ role: "user", content: "hi" }]))).rejects.toThrow(
        "kiro token missing — run ocx login kiro",
      );
    }
  });

  test("Builder ID requests without a profile ARN use the Kiro CLI wire contract", async () => {
    const { url, method, headers, body } = await createKiroAdapter(provider).buildRequest(parsedWith([{ role: "user", content: "hi" }]));
    const payload = JSON.parse(body) as {
      profileArn?: string;
      conversationState: {
        agentContinuationId?: string;
        agentTaskType?: string;
        currentMessage: { userInputMessage: Record<string, unknown> };
      };
    };
    expect(url).toBe("https://runtime.us-east-1.kiro.dev/");
    expect(method).toBe("POST");
    expect(headers.authorization).toBe("Bearer tok-123");
    expect(headers["x-amz-target"]).toBe("AmazonCodeWhispererStreamingService.GenerateAssistantResponse");
    expect(headers.accept).toBe("*/*");
    expect(headers["user-agent"]).toContain("app/AmazonQ-For-CLI");
    expect(headers["x-amzn-kiro-agent-mode"]).toBeUndefined();
    expect(headers["x-amzn-kiro-profile-arn"]).toBeUndefined();
    expect(headers["x-amzn-codewhisperer-optout"]).toBe("true");
    expect(headers.tokentype).toBeUndefined();
    expect(payload.profileArn).toBeUndefined();
    expect(payload.conversationState.agentTaskType).toBe("vibe");
    expect(payload.conversationState.agentContinuationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.conversationState.currentMessage.userInputMessage).toMatchObject({
      content: "hi",
      origin: "KIRO_CLI",
    });
    expect(payload.conversationState.currentMessage.userInputMessage).not.toHaveProperty("userInputMessageContext.envState");
  });

  test("Kiro API keys force the CLI token type and ignore unrelated profile metadata", async () => {
    const apiKeyProvider = { ...provider, authMode: "key", apiKey: "ksk_example" } as unknown as OcxProviderConfig;
    const parsed = parsedWith([{ role: "user", content: "hi" }]);
    parsed._kiroAuthContext = {
      profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/unrelated",
    };
    const request = await createKiroAdapter(apiKeyProvider).buildRequest(parsed);
    const body = JSON.parse(request.body) as {
      profileArn?: string;
      conversationState: { currentMessage: { userInputMessage: { origin?: string } } };
    };

    expect(request.headers.authorization).toBe("Bearer ksk_example");
    expect(request.headers.tokentype).toBe("API_KEY");
    expect(request.headers["x-amzn-kiro-profile-arn"]).toBeUndefined();
    expect(body.profileArn).toBeUndefined();
    expect(body.conversationState.currentMessage.userInputMessage.origin).toBe("KIRO_CLI");
  });

  test("runtime URL uses KIRO_API_REGION separately from auth region", async () => {
    process.env.KIRO_REGION = "us-east-1";
    process.env.KIRO_API_REGION = "ap-northeast-2";

    const { url } = await createKiroAdapter(provider).buildRequest(parsedWith([{ role: "user", content: "hi" }]));

    expect(url).toBe("https://runtime.ap-northeast-2.kiro.dev/");
  });

  test("account-scoped OAuth metadata selects the matching Kiro region and profile", async () => {
    const parsed = parsedWith([{ role: "user", content: "hi" }]);
    parsed._kiroAuthContext = {
      apiRegion: "eu-central-1",
      profileArn: "arn:aws:codewhisperer:eu-central-1:123456789012:profile/account-b",
    };

    const request = await createKiroAdapter(provider).buildRequest(parsed);
    const body = JSON.parse(request.body) as { profileArn?: string };

    expect(request.url).toBe("https://runtime.eu-central-1.kiro.dev/");
    expect(request.headers["x-amzn-kiro-profile-arn"]).toBe(parsed._kiroAuthContext.profileArn);
    expect(request.headers.accept).toBe("application/vnd.amazon.eventstream");
    expect(request.headers["x-amzn-kiro-agent-mode"]).toBe("vibe");
    expect(body.profileArn).toBe(parsed._kiroAuthContext.profileArn);
  });

  test("an account with no stored Kiro metadata never borrows different local CLI metadata", async () => {
    seedKiroCliMetadata(
      "arn:aws:codewhisperer:eu-west-1:123456789012:profile/local-other-account",
      "eu-west-1",
    );
    delete process.env.KIRO_REGION;
    await saveCredential("kiro", {
      access: "stored-access",
      refresh: "stored-refresh",
      expires: Date.now() + 3_600_000,
      source: "oauth",
    });

    const snapshot = await getValidAccessTokenSnapshot("kiro");
    expect(snapshot.kiro).toEqual({});
    const parsed = parsedWith([{ role: "user", content: "hi" }]);
    parsed._kiroAuthContext = { ...snapshot.kiro };
    const request = await createKiroAdapter(provider).buildRequest(parsed);
    const body = JSON.parse(request.body) as { profileArn?: string };

    expect(request.url).toBe("https://runtime.us-east-1.kiro.dev/");
    expect(request.headers["x-amzn-kiro-profile-arn"]).toBeUndefined();
    expect(body.profileArn).toBeUndefined();
  });

  test("genuinely accountless requests still honor Kiro environment overrides", async () => {
    const previousApiRegion = process.env.KIRO_API_REGION;
    const previousProfileArn = process.env.KIRO_PROFILE_ARN;
    process.env.KIRO_API_REGION = "ap-northeast-1";
    process.env.KIRO_PROFILE_ARN = "arn:aws:codewhisperer:ap-northeast-1:123456789012:profile/env";
    try {
      const parsed = parsedWith([{ role: "user", content: "hi" }]);
      expect(parsed._kiroAuthContext).toBeUndefined();
      const request = await createKiroAdapter(provider).buildRequest(parsed);
      expect(request.url).toBe("https://runtime.ap-northeast-1.kiro.dev/");
      expect(request.headers["x-amzn-kiro-profile-arn"]).toBe(process.env.KIRO_PROFILE_ARN);
    } finally {
      if (previousApiRegion === undefined) delete process.env.KIRO_API_REGION;
      else process.env.KIRO_API_REGION = previousApiRegion;
      if (previousProfileArn === undefined) delete process.env.KIRO_PROFILE_ARN;
      else process.env.KIRO_PROFILE_ARN = previousProfileArn;
    }
  });

  test("a genuinely custom Kiro base URL is honored", async () => {
    const custom = { ...provider, baseUrl: "https://kiro.internal.example/custom/generate" };
    const { url } = await createKiroAdapter(custom).buildRequest(parsedWith([{ role: "user", content: "hi" }]));
    expect(url).toBe("https://kiro.internal.example/custom/generate");

    const canonicalHostCustomPath = { ...provider, baseUrl: "https://runtime.us-east-1.kiro.dev/custom/generate" };
    const customPath = await createKiroAdapter(canonicalHostCustomPath).buildRequest(parsedWith([{ role: "user", content: "hi" }]));
    expect(customPath.url).toBe("https://runtime.us-east-1.kiro.dev/custom/generate");
  });

  test("runtime URL rejects host-injection KIRO_API_REGION values", async () => {
    for (const value of ["us-east-1/../../evil", "us-east-1@evil.test", "https://evil.test", "../us-east-1"]) {
      process.env.KIRO_API_REGION = value;
      await expect(createKiroAdapter(provider).buildRequest(parsedWith([{ role: "user", content: "hi" }]))).rejects.toThrow(
        "Kiro: invalid region value.",
      );
      try {
        await createKiroAdapter(provider).buildRequest(parsedWith([{ role: "user", content: "hi" }]));
      } catch (err) {
        expect(err instanceof Error ? err.message : String(err)).not.toContain(value);
      }
    }
  });

  test("normalizes versioned and effort-suffixed model aliases for Kiro payloads", async () => {
    for (const [input, expected] of [
      ["kiro-auto", "auto"],
      ["auto", "auto"],
      ["claude-sonnet-4-5-20250929", "claude-sonnet-4.5"],
      ["claude-4.5-sonnet-high", "claude-sonnet-4.5"],
      ["claude-4-5-opus-max", "claude-opus-4.5"],
      ["minimax-m2-1", "minimax-m2.1"],
      // GPT-5.6 tiers (Kiro 2026-07-13): keep dotted minor + tier suffix intact
      ["gpt-5.6-sol", "gpt-5.6-sol"],
      ["kiro/gpt-5.6-terra", "gpt-5.6-terra"],
      ["gpt-5-6-luna", "gpt-5.6-luna"],
      ["gpt-5.6-sol-high", "gpt-5.6-sol"],
    ]) {
      expect(normalizeKiroModelId(input)).toBe(expected);
      const { body } = await createKiroAdapter(provider).buildRequest(parsedWith([{ role: "user", content: "hi" }], undefined, input));
      expect(JSON.parse(body).conversationState.currentMessage.userInputMessage.modelId).toBe(expected);
    }
  });

  test("toolUses[].input is a JSON object (not stringified) and toolResults are adjacent", async () => {
    const messages = [
      { role: "user", content: "run it" },
      { role: "assistant", content: [{ type: "toolCall", id: "call|1", name: "bash", arguments: { command: "echo hi" } }] },
      { role: "toolResult", toolCallId: "call|1", toolName: "bash", content: "hi", isError: false },
    ];
    const { body } = await createKiroAdapter(provider).buildRequest(parsedWith(messages, [bashTool]));
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

  // Kiro's own client replays the encrypted reasoning blob on the assistant turn it belongs to;
  // dropping it makes every turn start without the previous turn's reasoning.
  test("assistant history replays the Kiro redacted reasoning blob", async () => {
    const messages = [
      { role: "user", content: "think" },
      { role: "assistant", content: [{ type: "text", text: "answer" }], kiroRedactedReasoning: "LktUUn5+blob" },
      { role: "user", content: "again" },
    ];
    const { body } = await createKiroAdapter(provider).buildRequest(parsedWith(messages));
    const arm = JSON.parse(body).conversationState.history
      .find((h: { assistantResponseMessage?: unknown }) => h.assistantResponseMessage)?.assistantResponseMessage;
    expect(arm.reasoningContent).toEqual({ redactedContent: "LktUUn5+blob" });
  });

  test("assistant history omits reasoningContent when no blob was captured", async () => {
    const messages = [
      { role: "user", content: "think" },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
      { role: "user", content: "again" },
    ];
    const { body } = await createKiroAdapter(provider).buildRequest(parsedWith(messages));
    const arm = JSON.parse(body).conversationState.history
      .find((h: { assistantResponseMessage?: unknown }) => h.assistantResponseMessage)?.assistantResponseMessage;
    expect(arm).not.toHaveProperty("reasoningContent");
  });

  test("empty tool output is normalized to a non-empty Kiro result block", async () => {
    const messages = [
      { role: "user", content: "run it" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-empty", name: "bash", arguments: {} }] },
      { role: "toolResult", toolCallId: "call-empty", toolName: "bash", content: "", isError: false },
    ];

    const { body } = await createKiroAdapter(provider).buildRequest(parsedWith(messages, [bashTool]));
    const current = JSON.parse(body).conversationState.currentMessage.userInputMessage;

    expect(current.content.trim()).not.toBe("");
    expect(current.userInputMessageContext.toolResults[0].content[0].text.trim()).not.toBe("");
  });

  test("tool result images are attached to Kiro carrier user messages", async () => {
    const messages = [
      { role: "user", content: "look" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "get_app_state", arguments: {} }] },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "get_app_state",
        content: [
          { type: "text", text: "Looked at Google Chrome" },
          { type: "image", imageUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", detail: "high" },
        ],
        isError: false,
      },
    ];
    const { body } = await createKiroAdapter(provider).buildRequest(
      parsedWith(messages, [{ name: "get_app_state", description: "Look at app", parameters: { type: "object" } }]),
    );
    const current = JSON.parse(body).conversationState.currentMessage.userInputMessage;

    expect(current.userInputMessageContext.toolResults[0].content[0].text).toBe("Looked at Google Chrome");
    expect(current.images).toEqual([{ format: "png", source: { bytes: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" } }]);
  });

  test("image/jpg media type is normalized to the CodeWhisperer 'jpeg' format", async () => {
    const messages = [
      { role: "user", content: [
        { type: "text", text: "look" },
        { type: "image", imageUrl: "data:image/jpg;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", detail: "high" },
      ] },
    ];
    const { body } = await createKiroAdapter(provider).buildRequest(
      parsedWith(messages, [{ name: "noop", description: "d", parameters: { type: "object" } }]),
    );
    const current = JSON.parse(body).conversationState.currentMessage.userInputMessage;
    expect(current.images).toEqual([{ format: "jpeg", source: { bytes: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" } }]);
  });

  test("tools map to toolSpecification", async () => {
    const { body } = await createKiroAdapter(provider).buildRequest(
      parsedWith([{ role: "user", content: "hi" }], [{ name: "grep", description: "search", parameters: { type: "object" } }]),
    );
    const current = JSON.parse(body).conversationState.currentMessage.userInputMessage;
    const ctx = current.userInputMessageContext;
    expect(current.content).toContain("Tool contract: use the current tool catalog as ground truth.");
    expect(current.content).toContain("Valid tool names for this turn are exactly `grep`, `codex_kiro_final_answer`.");
    expect(ctx.tools[0].toolSpecification.name).toBe("grep");
    expect(ctx.tools[0].toolSpecification.inputSchema.json).toEqual({ type: "object" });
  });

  test("explicit completion is injected only when ordinary tools are effective", async () => {
    const toolEnabled = JSON.parse((await createKiroAdapter(provider).buildRequest(
      parsedWith([{ role: "user", content: "hi" }], [bashTool]),
    )).body).conversationState;
    const firstUser = toolEnabled.history?.find((entry: { userInputMessage?: unknown }) => entry.userInputMessage)?.userInputMessage
      ?? toolEnabled.currentMessage.userInputMessage;
    const toolNames = toolEnabled.currentMessage.userInputMessage.userInputMessageContext.tools
      .map((tool: { toolSpecification: { name: string } }) => tool.toolSpecification.name);
    expect(toolNames).toEqual(["bash", "codex_kiro_final_answer"]);
    expect(firstUser.content).toContain("Valid tool names for this turn are exactly `bash`, `codex_kiro_final_answer`.");
    expect(firstUser.content).toContain("ordinary assistant text is mid-task commentary");
    expect(firstUser.content).toContain("call codex_kiro_final_answer exactly once");

    const toolFree = JSON.parse((await createKiroAdapter(provider).buildRequest(
      parsedWith([{ role: "user", content: "hi" }]),
    )).body).conversationState.currentMessage.userInputMessage;
    expect(JSON.stringify(toolFree)).not.toContain("codex_kiro_final_answer");

    const none = {
      ...parsedWith([{ role: "user", content: "hi" }], [bashTool]),
      options: { toolChoice: "none" },
    } as OcxParsedRequest;
    const disabled = JSON.parse((await createKiroAdapter(provider).buildRequest(none)).body)
      .conversationState.currentMessage.userInputMessage;
    expect(disabled.userInputMessageContext?.tools).toBeUndefined();
    expect(JSON.stringify(disabled)).not.toContain("codex_kiro_final_answer");
  });

  test("namespaced (MCP) tools advertise + replay the full wire name", async () => {
    const adapter = createKiroAdapter(provider);
    // Tool spec advertised to Kiro must carry the full namespaced name so the bridge's toolNsMap
    // (keyed by namespace__name) can restore the MCP namespace when Kiro echoes the name back.
    const specBody = (await adapter.buildRequest(
      parsedWith(
        [{ role: "user", content: "hi" }],
        [{ name: "navigate_page", namespace: "mcp__chrome-devtools", description: "navigate", parameters: { type: "object" } }],
      ),
    )).body;
    const specCtx = JSON.parse(specBody).conversationState.currentMessage.userInputMessage.userInputMessageContext;
    expect(specCtx.tools[0].toolSpecification.name).toBe("mcp__chrome-devtools__navigate_page");

    // Replayed assistant tool calls in history must use the same wire name.
    const replayBody = (await adapter.buildRequest(
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
    )).body;
    const history = JSON.parse(replayBody).conversationState.history;
    const replayed = history.find((e: { assistantResponseMessage?: { toolUses?: { name: string }[] } }) => e.assistantResponseMessage?.toolUses);
    expect(replayed.assistantResponseMessage.toolUses[0].name).toBe("mcp__chrome-devtools__navigate_page");
  });

  test("long namespaced tool names are normalized to Kiro's <=64-char charset", async () => {
    const wireName = "mcp__very-long-computer-use-namespace-with-browser-state__look_at_current_applications";
    const { body } = await createKiroAdapter(provider).buildRequest(
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
    const sent = ctx.tools[0].toolSpecification.name;
    expect(wireName.length).toBeGreaterThan(64);
    // Kiro's runtimeservice rejects names >64 chars or outside [a-zA-Z0-9_-]; the sent name conforms.
    expect(sent.length).toBeLessThanOrEqual(64);
    expect(sent).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    // Deterministic hash suffix keeps it unique/reversible.
    expect(sent).toMatch(/_[0-9a-f]{8}$/);
  });

  test("tool names with spaces are normalized for Kiro (codex_apps workspace agents)", async () => {
    const { body } = await createKiroAdapter(provider).buildRequest(
      parsedWith(
        [{ role: "user", content: "hi" }],
        [{
          name: "workspace agents_create_agent",
          namespace: "mcp__codex_apps__workspace_agents",
          description: "create",
          parameters: { type: "object" },
        }],
      ),
    );
    const sent = JSON.parse(body).conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[0].toolSpecification.name;
    expect(sent).not.toContain(" ");
    expect(sent).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  test("tool schemas remove Kiro-rejected fields recursively", async () => {
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
    const { body } = await createKiroAdapter(provider).buildRequest(
      parsedWith([{ role: "user", content: "hi" }], [{ name: "bash", description: "Run command", parameters }]),
    );
    const schema = JSON.parse(body).conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[0].toolSpecification.inputSchema.json;

    expect(schema.required).toBeUndefined();
    expect(schema.additionalProperties).toBeUndefined();
   expect(schema.properties.options.required).toEqual(["mode"]);
   expect(schema.properties.options.additionalProperties).toBeUndefined();
 });

  test("memory-style validation constraints are stripped but property names are preserved", async () => {
    // Mirrors codex-rs memories tools (add_ad_hoc_note/read/search): schemars emits
    // pattern/length/range keywords that Kiro's runtimeservice rejects as "Invalid tool use format".
    const parameters = {
      type: "object",
      properties: {
        filename: { type: "string", pattern: "^\\d{4}.*\\.md$", minLength: 24, maxLength: 128 },
        note: { type: "string", minLength: 1 },
        max_lines: { type: "integer", minimum: 1 },
        queries: { type: "array", items: { type: "string" }, minItems: 1 },
        // A property literally named "pattern"/"format" must survive untouched.
        pattern: { type: "string", format: "uuid" },
        format: { type: "string" },
      },
      required: ["filename", "note"],
    };
    const { body } = await createKiroAdapter(provider).buildRequest(
      parsedWith([{ role: "user", content: "hi" }], [{ name: "memories__add_ad_hoc_note", description: "Remember", parameters }]),
    );
    const schema = JSON.parse(body).conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[0].toolSpecification.inputSchema.json;

    expect(schema.properties.filename.pattern).toBeUndefined();
    expect(schema.properties.filename.minLength).toBeUndefined();
    expect(schema.properties.filename.maxLength).toBeUndefined();
    expect(schema.properties.filename.type).toBe("string");
    expect(schema.properties.note.minLength).toBeUndefined();
    expect(schema.properties.max_lines.minimum).toBeUndefined();
    expect(schema.properties.queries.minItems).toBeUndefined();
    expect(schema.properties.queries.items).toEqual({ type: "string" });
    // Property names that collide with schema keywords must be kept as properties.
    expect(schema.properties.pattern).toBeDefined();
    expect(schema.properties.pattern.format).toBeUndefined();
    expect(schema.properties.format).toBeDefined();
    expect(schema.required).toEqual(["filename", "note"]);
  });

  test("Codex's Responses-only encrypted marker is stripped from v2 collaboration schemas", async () => {
    // openai/codex 5f4d06ef stamps `encrypted: true` on spawn_agent/send_message/followup_task
    // `message` properties (issue #85 class). Kiro/Bedrock validators reject unknown keywords, and
    // the marker only means something to the ChatGPT Responses backend.
    const parameters = {
      type: "object",
      properties: {
        target: { type: "string" },
        message: { type: "string", description: "Message text.", encrypted: true },
        // A property literally named "encrypted" must survive as a property.
        encrypted: { type: "boolean" },
      },
      required: ["target", "message"],
    };
    const { body } = await createKiroAdapter(provider).buildRequest(
      parsedWith([{ role: "user", content: "hi" }], [{ name: "followup_task", namespace: "collaboration", description: "Send follow-up", parameters }]),
    );
    const schema = JSON.parse(body).conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[0].toolSpecification.inputSchema.json;

    expect(schema.properties.message.encrypted).toBeUndefined();
    expect(schema.properties.message.type).toBe("string");
    expect(schema.properties.encrypted).toEqual({ type: "boolean" });
    expect(schema.required).toEqual(["target", "message"]);
  });

  test("validation-only applicator keywords are dropped while $defs are preserved", async () => {
    const parameters = {
      type: "object",
      properties: {
        ref_field: { $ref: "#/$defs/Inner" },
        tags: { type: "object", patternProperties: { "^x-": { type: "string" } } },
      },
      patternProperties: { "^meta_": { type: "string", pattern: "^v" } },
      propertyNames: { pattern: "^[a-z]+$" },
      $defs: { Inner: { type: "object", properties: { id: { type: "string" } } } },
    };
    const { body } = await createKiroAdapter(provider).buildRequest(
      parsedWith([{ role: "user", content: "hi" }], [{ name: "memories__read", description: "Read", parameters }]),
    );
    const schema = JSON.parse(body).conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[0].toolSpecification.inputSchema.json;

    // Validation-only applicator keywords Bedrock/Kiro reject must be gone everywhere.
    expect(schema.patternProperties).toBeUndefined();
    expect(schema.propertyNames).toBeUndefined();
    expect(schema.properties.tags.patternProperties).toBeUndefined();
    // $ref + $defs (real reuse, supported) survive, and the inner schema is sanitized too.
    expect(schema.properties.ref_field).toEqual({ $ref: "#/$defs/Inner" });
    expect(schema.$defs.Inner.properties.id).toEqual({ type: "string" });
  });

  test("root inputSchema always declares type:object (Bedrock requires it)", async () => {
    // Empty parameters (e.g. some MCP/Computer Use tools) must still surface type:"object" or
    // Bedrock rejects with "toolSpec.inputSchema.json.type must be one of the following: object".
    const empty = JSON.parse(
      (await createKiroAdapter(provider).buildRequest(
        parsedWith([{ role: "user", content: "hi" }], [{ name: "noargs", description: "d", parameters: {} }]),
      )).body,
    ).conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[0].toolSpecification.inputSchema.json;
    expect(empty).toEqual({ type: "object" });

    // Missing parameters entirely -> defaults to type:"object".
    const none = JSON.parse(
      (await createKiroAdapter(provider).buildRequest(
        parsedWith([{ role: "user", content: "hi" }], [{ name: "noargs2", description: "d" }]),
      )).body,
    ).conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[0].toolSpecification.inputSchema.json;
    expect(none).toEqual({ type: "object" });

    // Array-form type including "object" collapses to "object" while preserving properties.
    const arrForm = JSON.parse(
      (await createKiroAdapter(provider).buildRequest(
        parsedWith([{ role: "user", content: "hi" }], [{ name: "arr", description: "d", parameters: { type: ["object", "null"], properties: { a: { type: "string" } } } }]),
      )).body,
    ).conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[0].toolSpecification.inputSchema.json;
    expect(arrForm.type).toBe("object");
    expect(arrForm.properties).toEqual({ a: { type: "string" } });

    // An explicitly object-typed schema is left untouched.
    const obj = JSON.parse(
      (await createKiroAdapter(provider).buildRequest(
        parsedWith([{ role: "user", content: "hi" }], [{ name: "obj", description: "d", parameters: { type: "object", properties: { a: { type: "string" } } } }]),
      )).body,
    ).conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[0].toolSpecification.inputSchema.json;
    expect(obj).toEqual({ type: "object", properties: { a: { type: "string" } } });
  });

  test("root oneOf/anyOf/allOf are flattened into a single object schema (Bedrock rejects them)", async () => {
    const pick = async (schema: unknown) =>
      JSON.parse((await createKiroAdapter(provider).buildRequest(
        parsedWith([{ role: "user", content: "hi" }], [{ name: "comp", description: "d", parameters: schema }]),
      )).body).conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[0].toolSpecification.inputSchema.json;

    // anyOf: properties merged, no required (OR semantics -> keep lenient).
    const anyOf = await pick({ anyOf: [
      { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      { type: "object", properties: { b: { type: "number" } } },
    ] });
    expect(anyOf.oneOf).toBeUndefined();
    expect(anyOf.anyOf).toBeUndefined();
    expect(anyOf.allOf).toBeUndefined();
    expect(anyOf.type).toBe("object");
    expect(anyOf.properties).toEqual({ a: { type: "string" }, b: { type: "number" } });
    expect(anyOf.required).toBeUndefined();

    // oneOf: same flattening, no required.
    const oneOf = await pick({ oneOf: [{ type: "object", properties: { x: { type: "string" } } }] });
    expect(oneOf.oneOf).toBeUndefined();
    expect(oneOf.type).toBe("object");
    expect(oneOf.properties).toEqual({ x: { type: "string" } });

    // allOf: properties merged AND required union kept (AND semantics).
    const allOf = await pick({ allOf: [
      { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
    ] });
    expect(allOf.allOf).toBeUndefined();
    expect(allOf.type).toBe("object");
    expect(allOf.properties).toEqual({ a: { type: "string" }, b: { type: "string" } });
    expect(allOf.required).toEqual(expect.arrayContaining(["a", "b"]));
  });

  test("root composition preserves root properties/siblings and merges coexisting keywords", async () => {
    const pick = async (schema: unknown) =>
      JSON.parse((await createKiroAdapter(provider).buildRequest(
        parsedWith([{ role: "user", content: "hi" }], [{ name: "comp2", description: "d", parameters: schema }]),
      )).body).conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[0].toolSpecification.inputSchema.json;

    // Root direct properties/required AND a sibling oneOf: keep the root fields, merge the variant.
    const rootPlusOneOf = await pick({
      type: "object",
      description: "keep me",
      properties: { keep: { type: "string" } },
      required: ["keep"],
      oneOf: [{ properties: { a: { type: "string" } } }],
    });
    expect(rootPlusOneOf.oneOf).toBeUndefined();
    expect(rootPlusOneOf.description).toBe("keep me");
    expect(rootPlusOneOf.properties).toEqual({ keep: { type: "string" }, a: { type: "string" } });
    expect(rootPlusOneOf.required).toEqual(["keep"]);

    // oneOf AND allOf at the root simultaneously: both must be flattened (not just the first).
    const both = await pick({
      oneOf: [{ properties: { a: { type: "string" } } }],
      allOf: [{ properties: { b: { type: "string" } }, required: ["b"] }],
    });
    expect(both.oneOf).toBeUndefined();
    expect(both.allOf).toBeUndefined();
    expect(both.properties).toEqual({ a: { type: "string" }, b: { type: "string" } });
    expect(both.required).toEqual(["b"]);

    // $defs are preserved so merged $ref properties still resolve.
    const withDefs = await pick({ $defs: { X: { type: "string" } }, anyOf: [{ properties: { a: { $ref: "#/$defs/X" } } }] });
    expect(withDefs.$defs).toEqual({ X: { type: "string" } });
    expect(withDefs.properties).toEqual({ a: { $ref: "#/$defs/X" } });
  });

  test("tool descriptions use deterministic model-specific caps without prompt injection", async () => {
    const longDescription = `Long docs ${"x".repeat(1100)} keep this tail.`;
    const { body } = await createKiroAdapter(provider).buildRequest(
      parsedWith([{ role: "user", content: "hi" }], [{ name: "longtool", description: longDescription, parameters: { type: "object" } }]),
    );
    const current = JSON.parse(body).conversationState.currentMessage.userInputMessage;
    const spec = current.userInputMessageContext.tools[0].toolSpecification;

    expect(spec.description).toHaveLength(1024);
    expect(spec.description.endsWith("…")).toBe(true);
    expect(current.content).not.toContain("### Tool documentation");

    const verifiedDescription = `Verified docs ${"y".repeat(10_000)}`;
    const verifiedBody = (await createKiroAdapter(provider).buildRequest(
      parsedWith(
        [{ role: "user", content: "hi" }],
        [{ name: "verified", description: verifiedDescription, parameters: { type: "object" } }],
        "gpt-5.6-sol",
      ),
    )).body;
    const verifiedSpec = JSON.parse(verifiedBody).conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[0].toolSpecification;
    expect(verifiedSpec.description).toHaveLength(9216);
    expect(verifiedSpec.description.endsWith("…")).toBe(true);
  });

  test("large catalogs retain the declared prefix within Kiro's count budget", async () => {
    // Each top-level description is below the existing per-description cap: this proves the
    // aggregate count budget, rather than that older truncation behavior, limits the catalog.
    const tools = Array.from({ length: MAX_KIRO_TOOL_COUNT + 20 }, (_, index) => ({
      name: `count_tool_${String(index).padStart(3, "0")}`,
      description: `Brief description ${index}`,
      parameters: { type: "object" },
    }));
    const current = JSON.parse((await createKiroAdapter(provider).buildRequest(
      parsedWith([{ role: "user", content: "hi" }], tools),
    )).body).conversationState.currentMessage.userInputMessage;
    const ordinary = current.userInputMessageContext.tools.slice(0, -1);

    expect(ordinary).toHaveLength(MAX_KIRO_TOOL_COUNT);
    expect(ordinary.map((tool: { toolSpecification: { name: string } }) => tool.toolSpecification.name)).toEqual(
      tools.slice(0, MAX_KIRO_TOOL_COUNT).map(tool => tool.name),
    );
    expect(current.content).toContain(`Kiro's outbound catalog budget allows ${MAX_KIRO_TOOL_COUNT} of ${tools.length} client tools`);
    expect(current.content).toContain("count_tool_048");
    expect(current.content).toContain("Omitted and unavailable this turn");
  });

  test("large catalogs retain the declared prefix within Kiro's serialized byte budget", async () => {
    // Top-level descriptions stay small, so existing description truncation cannot make this pass.
    // The repeated schema descriptions instead make the aggregate converted catalog exceed 96 KiB.
    const tools = Array.from({ length: 40 }, (_, index) => ({
      name: `byte_tool_${String(index).padStart(3, "0")}`,
      description: `Brief description ${index}`,
      parameters: {
        type: "object",
        properties: { payload: { type: "string", description: "x".repeat(8_000) } },
      },
    }));
    const current = JSON.parse((await createKiroAdapter(provider).buildRequest(
      parsedWith([{ role: "user", content: "hi" }], tools),
    )).body).conversationState.currentMessage.userInputMessage;
    const ordinary = current.userInputMessageContext.tools.slice(0, -1);
    const serializedBytes = new TextEncoder().encode(JSON.stringify(ordinary)).byteLength;

    expect(ordinary.length).toBeLessThan(tools.length);
    expect(serializedBytes).toBeLessThanOrEqual(MAX_KIRO_TOOL_CATALOG_BYTES);
    expect(ordinary.map((tool: { toolSpecification: { name: string } }) => tool.toolSpecification.name)).toEqual(
      tools.slice(0, ordinary.length).map(tool => tool.name),
    );
    expect(current.content).toContain(`Kiro's outbound catalog budget allows ${ordinary.length} of ${tools.length} client tools`);
  });

  test("historical tool calls stay structured when the current catalog is omitted", async () => {
    const messages = [
      { role: "user", content: "run it" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: "/tmp", isError: false },
    ];
    const { body } = await createKiroAdapter(provider).buildRequest(parsedWith(messages));
    const cs = JSON.parse(body).conversationState;
    const assistant = cs.history.find((h: { assistantResponseMessage?: unknown }) => h.assistantResponseMessage).assistantResponseMessage;
    const current = cs.currentMessage.userInputMessage;

    expect(assistant.toolUses).toEqual([{ name: "bash", input: { command: "pwd" }, toolUseId: "call-1" }]);
    expect(assistant.content).toBe("");
    expect(current.content).toBe(KIRO_TOOL_RESULT_CARRIER_MESSAGE);
    expect(current.userInputMessageContext.toolResults).toEqual([
      { content: [{ text: "/tmp" }], status: "success", toolUseId: "call-1" },
    ]);
    expect(current.userInputMessageContext.tools).toBeUndefined();
  });

  test("orphaned and encrypted tool results are rejected instead of fictionalized", async () => {
    const messages = [
      { role: "toolResult", toolCallId: "missing-call", toolName: "bash", content: "orphaned", isError: true },
    ];
    await expect(createKiroAdapter(provider).buildRequest(parsedWith(messages, [bashTool]))).rejects.toThrow(
      "orphaned tool result",
    );

    const encrypted = [
      { role: "user", content: "run" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: "opaque", containsEncryptedContent: true, isError: false },
    ];
    await expect(createKiroAdapter(provider).buildRequest(parsedWith(encrypted, [bashTool]))).rejects.toThrow(
      "cannot translate encrypted output",
    );
  });

  test("adjacent user/developer and assistant items normalize without synthetic prose", async () => {
    const messages = [
      { role: "developer", content: "first" },
      { role: "user", content: "second" },
      { role: "assistant", content: [{ type: "text", text: "one" }] },
      { role: "assistant", content: [{ type: "text", text: "two" }] },
      { role: "user", content: "third" },
    ];
    const cs = JSON.parse((await createKiroAdapter(provider).buildRequest(parsedWith(messages))).body).conversationState;
    expect(cs.history).toEqual([
      { userInputMessage: { content: "first\n\nsecond", modelId: "claude-sonnet-4.5", origin: "KIRO_CLI" } },
      { assistantResponseMessage: { content: "one\n\ntwo" } },
    ]);
    expect(cs.currentMessage.userInputMessage.content).toBe("third");
    expect(JSON.stringify(cs)).not.toContain("(acknowledged)");
    expect(JSON.stringify(cs)).not.toContain("(continue)");
  });

  test("reserves the private completion name across the full collision domain", async () => {
    await expect(createKiroAdapter(provider).buildRequest(parsedWith(
      [{ role: "user", content: "hi" }],
      [{ name: "codex_kiro_final_answer", description: "collision", parameters: { type: "object" } }],
    ))).rejects.toThrow("reserves the tool name");

    await expect(createKiroAdapter(provider).buildRequest(parsedWith([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "codex_kiro_final_answer", arguments: {} }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "codex_kiro_final_answer", content: "x", isError: false },
    ]))).rejects.toThrow("reserves the tool name");
  });

  test("conversation IDs are random once, then reused from provider continuation state", async () => {
    const request = parsedWith([{ role: "user", content: "hi" }]);
    const adapter = createKiroAdapter(provider);
    const first = JSON.parse((await adapter.buildRequest(request)).body).conversationState.conversationId;
    const second = JSON.parse((await adapter.buildRequest(request)).body).conversationState.conversationId;
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);

    const remembered = parsedWith([{ role: "user", content: "next" }]);
    remembered._providerContinuation = { kiro: { conversationId: "returned-conversation-7" } };
    const reused = JSON.parse((await createKiroAdapter(provider).buildRequest(remembered)).body).conversationState.conversationId;
    expect(reused).toBe("returned-conversation-7");
  });

  test("validates Kiro request capabilities explicitly", async () => {
    for (const options of [
      { toolChoice: "required" },
      { toolChoice: { name: "bash" } },
      { parallelToolCalls: true },
      { serviceTier: "priority" },
    ]) {
      await expect(createKiroAdapter(provider).buildRequest({
        ...parsedWith([{ role: "user", content: "hi" }], [bashTool]),
        options,
      } as OcxParsedRequest)).rejects.toThrow(/Kiro (supports only|does not support)/);
    }

    await expect(createKiroAdapter(provider).buildRequest({
      ...parsedWith([{ role: "user", content: "hi" }], [bashTool]),
      _structuredOutput: true,
    } as OcxParsedRequest)).rejects.toThrow("Kiro does not support Responses text controls or structured output");

    const none = { ...parsedWith([{ role: "user", content: "hi" }], [bashTool]), options: { toolChoice: "none" } } as OcxParsedRequest;
    const current = JSON.parse((await createKiroAdapter(provider).buildRequest(none)).body).conversationState.currentMessage.userInputMessage;
    expect(current.userInputMessageContext?.tools).toBeUndefined();
  });
});

describe("kiro adapter — native and emulated reasoning effort", () => {
  const kiro = PROVIDER_REGISTRY.find(p => p.id === "kiro") as unknown as OcxProviderConfig;

  test("kiro advertises Codex-compatible reasoning efforts", async () => {
    expect(kiro).toBeTruthy();
    expect(configuredReasoningEfforts(kiro, "claude-opus-4.8")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(configuredReasoningEfforts(kiro, "claude-opus-4.5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(configuredReasoningEfforts(kiro, "kiro-auto")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("kiro catalog disables unsupported Responses verbosity controls", () => {
    const model = applyProviderConfigHints(
      "kiro",
      kiro,
      { provider: "kiro", id: "gpt-5.6-sol" },
    );
    const entry = buildCatalogEntries(null, [], [model]).find(candidate => candidate.slug === "kiro/gpt-5.6-sol");

    expect(model.supportsVerbosity).toBe(false);
    expect(entry?.support_verbosity).toBe(false);
  });

  test("mapReasoningEffort keeps xhigh and max as distinct labels", async () => {
    expect(mapReasoningEffort(kiro, "claude-opus-4.8", "xhigh")).toBe("xhigh");
    expect(mapReasoningEffort(kiro, "deepseek-3.2", "max")).toBe("max");
  });

  test("xhigh injects current-message thinking tags with a 90% output-token budget", async () => {
    const { body } = await createKiroAdapter(provider).buildRequest({
      ...parsedWith([{ role: "user", content: "solve it" }]),
      options: { reasoning: "xhigh", maxOutputTokens: 8000 },
    });
    const content = JSON.parse(body).conversationState.currentMessage.userInputMessage.content;

    expect(content).toContain("<thinking_mode>enabled</thinking_mode>");
    expect(content).toContain("<max_thinking_length>7200</max_thinking_length>");
    expect(content).toContain("solve it");
  });

  test("max injects current-message thinking tags with a 95% output-token budget", async () => {
    const { body } = await createKiroAdapter(provider).buildRequest({
      ...parsedWith([{ role: "user", content: "solve it" }]),
      options: { reasoning: "max", maxOutputTokens: 8000 },
    });
    const content = JSON.parse(body).conversationState.currentMessage.userInputMessage.content;

    expect(content).toContain("<thinking_mode>enabled</thinking_mode>");
    expect(content).toContain("<max_thinking_length>7600</max_thinking_length>");
    expect(content).toContain("solve it");
  });

  test("reasoning tags are not injected into tool-result carrier turns", async () => {
    const messages = [
      { role: "user", content: "run a command" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: "/tmp", isError: false },
    ];
    const { body } = await createKiroAdapter(provider).buildRequest({ ...parsedWith(messages, [bashTool]), options: { reasoning: "high" } });
    const content = JSON.parse(body).conversationState.currentMessage.userInputMessage.content;

    expect(content).toBe(KIRO_TOOL_RESULT_CARRIER_MESSAGE);
    expect(content).not.toContain("<thinking_mode>");
  });

  // issue #543: Claude Code sends a mid-turn steer (queued_command) as text riding the same
  // user turn as the pending tool_result. Proxy filler must never precede that instruction.
  test("a mid-turn steering message is the current turn without proxy carrier filler", async () => {
    const steer = "STOP editing module A. Use kiro/gpt-5.6-sol instead.";
    const messages = [
      { role: "user", content: "Refactor module A." },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: "file list", isError: false },
      { role: "user", content: steer },
    ];
    const { body } = await createKiroAdapter(provider).buildRequest(parsedWith(messages, [bashTool]));
    const current = JSON.parse(body).conversationState.currentMessage.userInputMessage;

    // The human instruction is the whole content: the carrier sentence must be ABSENT, not
    // merely moved after it (a startsWith assertion would pass with filler appended).
    expect(current.content).toBe(steer);
    expect(current.content).not.toContain(KIRO_TOOL_RESULT_CARRIER_MESSAGE);
    // The tool result still rides along structurally, so no information is lost.
    expect(current.userInputMessageContext.toolResults).toEqual([
      { content: [{ text: "file list" }], status: "success", toolUseId: "call-1" },
    ]);
  });

  test("mid-turn steering reaches Kiro identically for opus-5 and opus-4.8", async () => {
    // The #543 reporter observed opus-4.8 honoring mid-turn steers while opus-5 ignored them on
    // the same proxy build. Pin that our request construction does not differ between the two
    // beyond model identity and opus-5's native effort field, so a future model-conditional
    // regression on this path is caught here rather than in a user's session.
    const steer = "Stop and switch approach now.";
    const messages = [
      { role: "user", content: "Start the task." },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: "out", isError: false },
      { role: "user", content: steer },
    ];
    const build = async (modelId: string) => {
      const { body } = await createKiroAdapter(provider).buildRequest({
        ...parsedWith(messages, [bashTool], modelId),
        options: { reasoning: "high" },
      });
      return JSON.parse(body);
    };
    const opus5 = await build("claude-opus-5");
    const opus48 = await build("claude-opus-4.8");

    for (const payload of [opus5, opus48]) {
      const current = payload.conversationState.currentMessage.userInputMessage;
      expect(current.content).toBe(steer);
      expect(current.userInputMessageContext.toolResults).toEqual([
        { content: [{ text: "out" }], status: "success", toolUseId: "call-1" },
      ]);
    }
    // Only the native-effort field may differ; opus-4.8 also gets no emulated thinking tags
    // here because tool-result turns skip that injection.
    expect(opus5.additionalModelRequestFields).toEqual({ output_config: { effort: "high" } });
    expect(opus48.additionalModelRequestFields).toBeUndefined();
    expect(opus48.conversationState.currentMessage.userInputMessage.content).not.toContain("<thinking_mode>");
  });

  test("gpt-5.6-sol sends native reasoning while legacy models keep labeled emulation", async () => {
    const nativeBody = JSON.parse((await createKiroAdapter(provider).buildRequest({
      ...parsedWith([{ role: "user", content: "solve" }], undefined, "gpt-5.6-sol"),
      options: { reasoning: "high" },
    })).body);
    expect(nativeBody.additionalModelRequestFields).toEqual({ reasoning: { effort: "high" } });
    expect(nativeBody.conversationState.currentMessage.userInputMessage.content).toBe("solve");

    const emulatedBody = JSON.parse((await createKiroAdapter(provider).buildRequest({
      ...parsedWith([{ role: "user", content: "solve" }], undefined, "claude-sonnet-4.5"),
      options: { reasoning: "high", maxOutputTokens: 1000 },
    })).body);
    expect(emulatedBody.additionalModelRequestFields).toBeUndefined();
    expect(emulatedBody.conversationState.currentMessage.userInputMessage.content).toContain("<max_thinking_length>800</max_thinking_length>");
  });

  test("claude-opus-5 sends native effort through the Claude-specific output_config field", async () => {
    const body = JSON.parse((await createKiroAdapter(provider).buildRequest({
      ...parsedWith([{ role: "user", content: "solve" }], undefined, "claude-opus-5"),
      options: { reasoning: "max", maxOutputTokens: 1000 },
    })).body);

    expect(body.additionalModelRequestFields).toEqual({ output_config: { effort: "max" } });
    // Native effort replaces the emulated thinking-tag prompt entirely.
    expect(body.conversationState.currentMessage.userInputMessage.content).toBe("solve");
  });

  test("native-effort models reject efforts Kiro does not accept", async () => {
    for (const modelId of ["gpt-5.6-sol", "claude-opus-5"]) {
      await expect(createKiroAdapter(provider).buildRequest({
        ...parsedWith([{ role: "user", content: "solve" }], undefined, modelId),
        options: { reasoning: "minimal" },
      })).rejects.toThrow(`Kiro ${modelId} does not support reasoning effort "minimal"`);
    }
  });
});

describe("kiro adapter — per-model context windows (kiro.dev/docs/models)", () => {
  const kiro = PROVIDER_REGISTRY.find(p => p.id === "kiro") as unknown as OcxProviderConfig;
  const cw = kiro.modelContextWindows ?? {};

  test("registry includes the currently documented Kiro models", () => {
    for (const id of [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "claude-opus-4.5",
      "claude-sonnet-4.0",
      "minimax-m2.1",
    ]) {
      expect(kiro.models ?? []).toContain(id);
    }
  });

  test("1M-context models map to 1_000_000", () => {
    for (const id of ["claude-sonnet-5", "claude-opus-5", "claude-opus-4.8", "claude-opus-4.7", "claude-opus-4.6", "claude-sonnet-4.6"]) {
      expect(kiro.models ?? []).toContain(id);
      expect(cw[id]).toBe(1_000_000);
    }
  });

  test("smaller-context models match Kiro's published limits", () => {
    expect(cw["gpt-5.6-sol"]).toBe(272_000);
    expect(cw["gpt-5.6-terra"]).toBe(272_000);
    expect(cw["gpt-5.6-luna"]).toBe(272_000);
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

  test("kiro catalog is static (no OpenAI-style live /models)", () => {
    expect(kiro.liveModels).toBe(false);
  });

  test("Auto router has no fixed window (omitted)", () => {
    expect(cw["kiro-auto"]).toBeUndefined();
  });
});

describe("boundedInjectedInstruction surrogate safety", () => {
  test("a budget cut never ends on a lone high surrogate", async () => {
    const { boundedInjectedInstructionForTests } = await import("../src/adapters/kiro");
    const { MAX_KIRO_INJECTED_INSTRUCTION_CHARS } = await import("../src/adapters/kiro-constants");
    // Place an astral character exactly at the budget boundary.
    const prefix = "가".repeat(MAX_KIRO_INJECTED_INSTRUCTION_CHARS - 1);
    const text = `${prefix}🎆tail`;
    const used = { value: 0 };
    const result = boundedInjectedInstructionForTests(text, used);
    expect(result).toBeDefined();
    const last = result!.charCodeAt(result!.length - 1);
    // The astral pair is dropped whole rather than split into a broken half.
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    expect(result!.includes("\uFFFD")).toBe(false);
    expect(Buffer.byteLength(result!, "utf8")).toBeGreaterThan(0);
  });
});
