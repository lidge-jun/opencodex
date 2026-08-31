import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKiroAdapter } from "../src/adapters/kiro";
import {
  KIRO_ANSWER_DELIVERED_MESSAGE,
  KIRO_COMPLETION_INSTRUCTIONS,
  KIRO_COMPLETION_RETRY_MESSAGE,
  KIRO_COMPLETION_TOOL_NAME,
  KIRO_CONTINUATION_MESSAGE,
  KIRO_EMPTY_TOOL_RESULT_MESSAGE,
  KIRO_TOOL_RESULT_CARRIER_MESSAGE,
} from "../src/adapters/kiro-constants";
import { EMPTY_EXEC_OUTPUT_MESSAGE, FAILED_EXEC_OUTPUT_MESSAGE } from "../src/adapters/exec-tool-result-normalize";
import { MAX_KIRO_TOOL_CATALOG_BYTES, MAX_KIRO_TOOL_COUNT } from "../src/adapters/kiro-tools";
import { applyProviderConfigHints, buildCatalogEntries } from "../src/codex/catalog";
import { getValidAccessTokenSnapshot } from "../src/oauth";
import { saveCredential } from "../src/oauth/store";
import { normalizeKiroModelId } from "../src/providers/kiro-models";
import { configuredReasoningEfforts, mapReasoningEffort } from "../src/reasoning-effort";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { parseRequest } from "../src/responses/parser";
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

  // An empty code-mode exec result must say WHY it is empty. Without this the model reads a blank
  // result, concludes earlier context was lost, and restarts finished work.
  test("an empty code-mode exec result carries the actionable reason, not the generic fallback", async () => {
    const execTool = { name: "exec", description: "Run JavaScript", parameters: { type: "object" } };
    for (const raw of ["", "Script completed\nWall time 0.1 seconds\nOutput:\n", "<empty>"]) {
      const messages = [
        { role: "user", content: "run it" },
        { role: "assistant", content: [{ type: "toolCall", id: "call-x", name: "exec", arguments: {} }] },
        { role: "toolResult", toolCallId: "call-x", toolName: "exec", content: raw, isError: false },
      ];
      const { body } = await createKiroAdapter(provider).buildRequest(parsedWith(messages, [execTool]));
      const resultText = JSON.parse(body).conversationState.currentMessage.userInputMessage
        .userInputMessageContext.toolResults[0].content[0].text;

      expect(resultText).toBe(EMPTY_EXEC_OUTPUT_MESSAGE);
      // The generic fallback would leave the model to guess; assert it is NOT what shipped.
      expect(resultText).not.toBe(KIRO_EMPTY_TOOL_RESULT_MESSAGE);
    }
  });

  test("real exec output and empty non-exec results are left alone", async () => {
    // Review finding (Codex P2): a failed cell with no output is empty but NOT a success. The
    // success guidance would erase the only failure signal — reachable via Responses history,
    // where function_call_output is parsed with isError: false.
    const execTool0 = { name: "exec", description: "Run JavaScript", parameters: { type: "object" } };
    const failed = [
      { role: "user", content: "run it" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-f", name: "exec", arguments: {} }] },
      { role: "toolResult", toolCallId: "call-f", toolName: "exec", content: "Script failed\nWall time 0.1 seconds\nOutput:\n", isError: false },
    ];
    const failedBody = await createKiroAdapter(provider).buildRequest(parsedWith(failed, [execTool0]));
    const failedText = JSON.parse(failedBody.body).conversationState.currentMessage.userInputMessage
      .userInputMessageContext.toolResults[0].content[0].text;
    expect(failedText).toBe(FAILED_EXEC_OUTPUT_MESSAGE);
    expect(failedText).not.toBe(EMPTY_EXEC_OUTPUT_MESSAGE);

    const execTool = { name: "exec", description: "Run JavaScript", parameters: { type: "object" } };
    const withExecOutput = [
      { role: "user", content: "run it" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-x", name: "exec", arguments: {} }] },
      { role: "toolResult", toolCallId: "call-x", toolName: "exec", content: "Output:\nhello", isError: false },
    ];
    const execBody = await createKiroAdapter(provider).buildRequest(parsedWith(withExecOutput, [execTool]));
    expect(JSON.parse(execBody.body).conversationState.currentMessage.userInputMessage
      .userInputMessageContext.toolResults[0].content[0].text).toBe("Output:\nhello");

    // A non-exec tool keeps the generic message: asserting code-mode semantics for arbitrary
    // tools would tell the model to call text()/notify() in a runtime that has neither.
    const nonExec = [
      { role: "user", content: "run it" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-y", name: "bash", arguments: {} }] },
      { role: "toolResult", toolCallId: "call-y", toolName: "bash", content: "", isError: false },
    ];
    const bashBody = await createKiroAdapter(provider).buildRequest(parsedWith(nonExec, [bashTool]));
    expect(JSON.parse(bashBody.body).conversationState.currentMessage.userInputMessage
      .userInputMessageContext.toolResults[0].content[0].text).toBe(KIRO_EMPTY_TOOL_RESULT_MESSAGE);
  });

  // A delivered final answer already ended its turn. Asking it to continue reopens closed work,
  // which is what made a finished task behave like a still-open goal.
  test("a delivered final answer is not told to continue or to complete again", async () => {
    const messages = [
      { role: "user", content: "do it" },
      { role: "assistant", phase: "final_answer", content: [{ type: "text", text: "Done: the answer." }] },
    ];
    const { body } = await createKiroAdapter(provider).buildRequest(parsedWith(messages, [bashTool]));
    const current = JSON.parse(body).conversationState.currentMessage.userInputMessage;

    expect(current.content).toBe(KIRO_ANSWER_DELIVERED_MESSAGE);
    expect(current.content).not.toContain(KIRO_CONTINUATION_MESSAGE);
    expect(current.content).not.toContain(KIRO_COMPLETION_RETRY_MESSAGE);
  });

  test("an unfinished trailing assistant turn still gets the continuation prompt", async () => {
    // Same shape minus `phase`: proves the new branch keys off the delivered final answer and did
    // not simply disable continuation for every trailing assistant turn.
    const messages = [
      { role: "user", content: "do it" },
      { role: "assistant", content: [{ type: "text", text: "Working on it..." }] },
    ];
    const { body } = await createKiroAdapter(provider).buildRequest(parsedWith(messages, [bashTool]));
    const current = JSON.parse(body).conversationState.currentMessage.userInputMessage;

    expect(current.content).toContain(KIRO_CONTINUATION_MESSAGE);
    expect(current.content).not.toBe(KIRO_ANSWER_DELIVERED_MESSAGE);
  });

  // Review finding (Codex P2): suppressing the resume wording is not enough. While completion
  // stays "required" the request keeps advertising the completion tool, so the model answers again
  // or trips the text_fallback retry, which reopens the finished task.
  test("a delivered final answer stops advertising the completion tool", async () => {
    const delivered = [
      { role: "user", content: "do it" },
      { role: "assistant", phase: "final_answer", content: [{ type: "text", text: "Done." }] },
    ];
    const { body } = await createKiroAdapter(provider).buildRequest(parsedWith(delivered, [bashTool]));
    const current = JSON.parse(body).conversationState.currentMessage.userInputMessage;
    const toolNames = (current.userInputMessageContext?.tools ?? [])
      .map((t: { toolSpecification?: { name?: string } }) => t.toolSpecification?.name);

    expect(toolNames).toContain("bash");
    expect(toolNames).not.toContain(KIRO_COMPLETION_TOOL_NAME);
    // The instructions must go too: they tell the model to call a tool that is no longer offered.
    expect(current.content).not.toContain(KIRO_COMPLETION_TOOL_NAME);

    // Control: an unfinished turn still gets the completion contract.
    const unfinished = [
      { role: "user", content: "do it" },
      { role: "assistant", content: [{ type: "text", text: "Working..." }] },
    ];
    const open = await createKiroAdapter(provider).buildRequest(parsedWith(unfinished, [bashTool]));
    const openNames = (JSON.parse(open.body).conversationState.currentMessage.userInputMessage
      .userInputMessageContext?.tools ?? [])
      .map((t: { toolSpecification?: { name?: string } }) => t.toolSpecification?.name);
    expect(openNames).toContain(KIRO_COMPLETION_TOOL_NAME);
  });

  // Review finding (CodeRabbit): the acknowledgement was detected by comparing user content, so a
  // real user message quoting that sentence lost its thinking tags and completion retry.
  test("a user message quoting the acknowledgement is still treated as user content", async () => {
    const messages = [
      { role: "user", content: "do it" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: KIRO_ANSWER_DELIVERED_MESSAGE },
    ];
    const { body } = await createKiroAdapter(provider).buildRequest({
      ...parsedWith(messages, [bashTool]),
      options: { reasoning: "xhigh" },
    } as never);
    const current = JSON.parse(body).conversationState.currentMessage.userInputMessage;

    // Real user text keeps its reasoning injection; internal state must not be inferred from it.
    expect(current.content).toContain("<thinking_mode>");
  });

  test("commentary after a final answer reopens continuation", async () => {
    // A merged assistant turn is terminal only if its LAST component was the final answer.
    const messages = [
      { role: "user", content: "do it" },
      { role: "assistant", phase: "final_answer", content: [{ type: "text", text: "Done." }] },
      { role: "assistant", content: [{ type: "text", text: "Actually, one more check." }] },
    ];
    const { body } = await createKiroAdapter(provider).buildRequest(parsedWith(messages, [bashTool]));
    const current = JSON.parse(body).conversationState.currentMessage.userInputMessage;

    expect(current.content).toContain(KIRO_CONTINUATION_MESSAGE);
    expect(current.content).not.toBe(KIRO_ANSWER_DELIVERED_MESSAGE);
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

  // The private completion tool is enumerated by the shared tool-catalog nudge alongside ordinary
  // tools, and that nudge tells every listed name to "count a tool call only after its tool result
  // returns". Nothing returns a result for this one: the adapter converts the call into the turn's
  // terminal. Without an explicit terminal statement the model reads a deferrable ordinary tool and
  // keeps working instead of completing, which is measurable as a selection failure (25 completion
  // calls across 4069 required-mode attempts) and shows up as finished answers delivered as
  // commentary with more tool calls after them.
  //
  // Both injected surfaces have to carry it. The schema description travels with the tool object the
  // model is choosing between; the prose contract must not contradict it.
  test("the completion tool is advertised as terminal on both injected surfaces", async () => {
    const state = JSON.parse((await createKiroAdapter(provider).buildRequest(
      parsedWith([{ role: "user", content: "hi" }], [bashTool]),
    )).body).conversationState;
    const current = state.currentMessage.userInputMessage;
    const firstUser = state.history?.find((entry: { userInputMessage?: unknown }) => entry.userInputMessage)?.userInputMessage
      ?? current;
    const completion = current.userInputMessageContext.tools
      .find((tool: { toolSpecification: { name: string } }) => tool.toolSpecification.name === "codex_kiro_final_answer");

    const description: string = completion.toolSpecification.description;
    expect(description).toContain("not an ordinary work tool");
    expect(description).toContain("ends the turn");
    expect(description).toContain("returns no tool result");
    expect(description).toContain("no text or tool call may follow it");

    const injected: string = firstUser.content;
    expect(injected).toContain("This completion tool is not an ordinary work tool.");
    expect(injected).toContain("exception to generic tool-result counting");
    expect(injected).toContain("ends the turn, returns no tool result, and no text or tool call may follow it");

    // The mid-task contract must survive: commentary still does not end the turn, and the model must
    // still keep using tools before it completes. Only what happens AFTER the call is constrained.
    expect(injected).toContain("ordinary assistant text is mid-task commentary");
    expect(injected).toContain("Continue using tools after progress updates.");
  });

  // Round one shipped terminal wording and the defect recurred anyway, because terminality was never
  // the gap. The contract described two states -- still working, fully done -- for a model that has
  // three. With no endorsed way to say "blocked on the user", a model with a question wrote it as
  // prose and then answered itself in the SAME inference (measured 4ms apart, sendCount 1), which
  // reads to the user as an agent that keeps working after its final answer.
  test("the injected contract endorses a blocking question as the final answer", async () => {
    const state = JSON.parse((await createKiroAdapter(provider).buildRequest(
      parsedWith([{ role: "user", content: "hi" }], [bashTool]),
    )).body).conversationState;
    const current = state.currentMessage.userInputMessage;
    const firstUser = state.history?.find((entry: { userInputMessage?: unknown }) => entry.userInputMessage)?.userInputMessage
      ?? current;
    const injected: string = firstUser.content;

    // The third state has to be nameable, and the specific defect shape has to be named as wrong.
    // The trigger covers information and clarification, not just a decision: being blocked on a
    // missing account id is the same dead end as being blocked on a choice.
    expect(injected).toContain("cannot continue until the user supplies a decision, information, or a clarification");
    expect(injected).toContain("that question is your final answer");
    expect(injected).toContain("Do not write the question as ordinary text and then answer it yourself.");

    // The schema description is the surface the model reads while CHOOSING a tool, so it has to
    // carry the third state too. Left saying only "fully complete", it contradicts the prose
    // contract and keeps the narrower reading available at the moment of selection.
    const completion = current.userInputMessageContext.tools
      .find((tool: { toolSpecification: { name: string } }) => tool.toolSpecification.name === KIRO_COMPLETION_TOOL_NAME);
    const description: string = completion.toolSpecification.description;
    expect(description).toContain("cannot continue until the user supplies a decision, information, or a clarification");
    expect(completion.toolSpecification.inputSchema.json.properties.answer.description)
      .toContain("blocking question");

    // Unconditional: the completion tool is always advertised when this instruction is emitted, so the
    // clause can never name an uncallable tool. No ask tool in this catalog, clause still present.
    expect(current.userInputMessageContext.tools
      .some((tool: { toolSpecification: { name: string } }) => tool.toolSpecification.name === "request_user_input")).toBe(false);
  });

  // This is the one instruction the model sees at the exact moment it failed to complete, so its
  // wording decides the next move. "Do not ask the user for another task" was meant to stop
  // soliciting NEW work; it reads as a blanket ban on asking anything, which left continuing to work
  // as the only endorsed move.
  test("the completion retry message permits a blocking question but still refuses a new task", () => {
    expect(KIRO_COMPLETION_RETRY_MESSAGE).toContain("cannot continue until the user supplies a decision, information, or a clarification");
    expect(KIRO_COMPLETION_RETRY_MESSAGE).toContain(`call ${KIRO_COMPLETION_TOOL_NAME} now with that question as the answer`);
    // The narrowing must not reopen the loop this message was written to close.
    expect(KIRO_COMPLETION_RETRY_MESSAGE).toContain("Do not solicit a new task");
    expect(KIRO_COMPLETION_RETRY_MESSAGE).toContain("progress-only message");
    // The blanket phrasing is gone, so the model cannot read the narrow rule as a total ban.
    expect(KIRO_COMPLETION_RETRY_MESSAGE).not.toContain("Do not ask the user for another task");
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

    // Property names remain data while flattening, even when they collide with rejected keywords.
    const keywordNames = await pick({
      properties: { format: { type: "string", format: "uuid" } },
      required: ["format"],
      oneOf: [{ properties: { pattern: { type: "string", pattern: "^x" } } }],
    });
    expect(keywordNames.properties.format).toEqual({ type: "string" });
    expect(keywordNames.properties.pattern).toEqual({ type: "string" });
    expect(keywordNames.required).toEqual(["format"]);
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

  test("large catalogs prioritize tool-search discoveries and the search gateway", async () => {
    const ordinaryTools = Array.from({ length: MAX_KIRO_TOOL_COUNT + 20 }, (_, index) => ({
      name: `ordinary_tool_${String(index).padStart(3, "0")}`,
      description: `Ordinary tool ${index}`,
      parameters: { type: "object" },
    }));
    const searchGateway = {
      name: "tool_search",
      description: "Search deferred tools",
      parameters: { type: "object" },
      toolSearch: true,
    };
    const loadedTool = {
      name: "codex_app__send_message_to_thread",
      description: "Send a message to a task",
      parameters: { type: "object" },
      loadedFromToolSearch: true,
    };
    const tools = [...ordinaryTools, searchGateway, loadedTool];

    const current = JSON.parse((await createKiroAdapter(provider).buildRequest(
      parsedWith([{ role: "user", content: "hi" }], tools),
    )).body).conversationState.currentMessage.userInputMessage;
    const ordinary = current.userInputMessageContext.tools.slice(0, -1);
    const names = ordinary.map((tool: { toolSpecification: { name: string } }) => tool.toolSpecification.name);
    const omissionNotice = current.content.split("\n\n", 1)[0];

    expect(ordinary).toHaveLength(MAX_KIRO_TOOL_COUNT);
    expect(names.slice(0, 2)).toEqual([loadedTool.name, searchGateway.name]);
    expect(names.slice(2)).toEqual(ordinaryTools.slice(0, MAX_KIRO_TOOL_COUNT - 2).map(tool => tool.name));
    expect(omissionNotice).toContain("ordinary_tool_046");
    expect(omissionNotice).not.toContain(loadedTool.name);
    expect(omissionNotice).not.toContain(searchGateway.name);
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
    } as OcxParsedRequest)).rejects.toThrow("Kiro does not support Responses structured output");

    const none = { ...parsedWith([{ role: "user", content: "hi" }], [bashTool]), options: { toolChoice: "none" } } as OcxParsedRequest;
    const current = JSON.parse((await createKiroAdapter(provider).buildRequest(none)).body).conversationState.currentMessage.userInputMessage;
    expect(current.userInputMessageContext?.tools).toBeUndefined();
  });

  test("tolerates non-structured Responses text controls and keeps them off the Kiro wire", async () => {
    // Regression: the guard used to reject the PRESENCE of any \`text\` member, so a verbosity
    // hint or a plain \`format: {type:"text"}\` produced HTTP 400 while the identical turn
    // without \`text\` succeeded. Neither is structured output, and Kiro has no wire field for
    // either, so both belong on the tolerated side of the guard.
    for (const text of [
      { verbosity: "medium" },
      { format: { type: "text" } },
      {},
    ]) {
      const parsed = parseRequest({
        model: "kiro/claude-haiku-4.5",
        input: "test",
        stream: true,
        text,
        tools: [{
          type: "function",
          name: "bash",
          description: "Run a shell command",
          parameters: { type: "object" },
        }],
      } as never);
      expect(parsed._structuredOutput ?? false).toBe(false);
      expect((parsed._rawBody as Record<string, unknown>).text).toBeDefined();

      const payload = JSON.parse((await createKiroAdapter(provider).buildRequest(parsed)).body) as {
        text?: unknown;
        verbosity?: unknown;
        conversationState?: {
          text?: unknown;
          verbosity?: unknown;
          currentMessage: {
            userInputMessage: {
              userInputMessageContext?: { text?: unknown; verbosity?: unknown };
            };
          };
        };
      };

      // The turn reached the wire at all — the point of the fix.
      expect(payload.conversationState).toBeDefined();
      // ...but the control itself is not forwarded, at any level that exists on the payload.
      const context = payload.conversationState?.currentMessage.userInputMessage.userInputMessageContext;
      // The fixture advertises a tool so userInputMessageContext really exists here; without
      // one the adapter omits it and this third assertion would pass vacuously.
      expect(context).toBeDefined();
      for (const level of [payload, payload.conversationState, context]) {
        expect(level?.text).toBeUndefined();
        expect(level?.verbosity).toBeUndefined();
      }
    }
  });

  test("still refuses genuine structured output", async () => {
    for (const text of [
      { format: { type: "json_schema", name: "answer", schema: { type: "object" } } },
      { format: { type: "json_object" } },
    ]) {
      const parsed = parseRequest({
        model: "kiro/claude-haiku-4.5",
        input: "test",
        stream: true,
        text,
      } as never);
      expect(parsed._structuredOutput).toBe(true);
      await expect(createKiroAdapter(provider).buildRequest(parsed))
        .rejects.toThrow("Kiro does not support Responses structured output");
    }
  });

  test("accepts Codex's permissive parallel-tool hint while keeping the Kiro wire serialized", async () => {
    const parsed = parseRequest({
      model: "kiro/claude-haiku-4.5",
      input: "test",
      stream: true,
      parallel_tool_calls: true,
      tools: [{
        type: "function",
        name: "bash",
        description: "Run a shell command",
        parameters: { type: "object" },
      }],
    });
    expect(parsed.options.parallelToolCalls).toBe(true);

    const payload = JSON.parse((await createKiroAdapter(provider).buildRequest(parsed)).body) as {
      parallel_tool_calls?: boolean;
      parallelToolCalls?: boolean;
      conversationState: {
        parallel_tool_calls?: boolean;
        parallelToolCalls?: boolean;
        currentMessage: {
          userInputMessage: {
            userInputMessageContext?: {
              parallel_tool_calls?: boolean;
              parallelToolCalls?: boolean;
              tools?: Array<{ toolSpecification?: { name?: string } }>;
            };
          };
        };
      };
    };
    const context = payload.conversationState.currentMessage.userInputMessage.userInputMessageContext;
    expect(context?.tools?.some(tool => tool.toolSpecification?.name === "bash")).toBe(true);
    expect(payload.parallel_tool_calls).toBeUndefined();
    expect(payload.parallelToolCalls).toBeUndefined();
    expect(payload.conversationState.parallel_tool_calls).toBeUndefined();
    expect(payload.conversationState.parallelToolCalls).toBeUndefined();
    expect(context?.parallel_tool_calls).toBeUndefined();
    expect(context?.parallelToolCalls).toBeUndefined();
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

// The completion contract is charged LAST against MAX_KIRO_INJECTED_INSTRUCTION_CHARS, so a large
// enough set of earlier injected additions could in principle slice its closing clause mid-sentence
// and leave the model a truncated instruction. A reservation guard would be dead code -- the two
// charged inputs (the omission notice and the catalog nudge) are both structurally capped, and the
// previous unit proved a reservation test can pass with the reservation removed. So pin the property
// that makes truncation unreachable instead: hostile catalogs at both extremes still deliver the
// contract COMPLETE. This fails if a future change lets either charged input grow without bound.
describe("the completion contract survives a hostile tool catalog intact", () => {
  async function injectedSystemText(tools: unknown[]): Promise<string> {
    const { body } = await createKiroAdapter(provider).buildRequest(parsedWith([{ role: "user", content: "hi" }], tools));
    return JSON.parse(body).conversationState.currentMessage.userInputMessage.content as string;
  }

  test("a maximal admitted catalog (largest nudge) does not truncate the contract", async () => {
    // Every admitted tool is named in the nudge, so unique 64-char names at the count limit produce
    // the largest nudge the adapter can emit. Descriptions stay short so nothing is omitted.
    const tools = Array.from({ length: MAX_KIRO_TOOL_COUNT }, (_unused, index) => ({
      name: `t${String(index).padStart(2, "0")}${"n".repeat(61)}`.slice(0, 64),
      description: "d",
      parameters: { type: "object" },
    }));
    const { body } = await createKiroAdapter(provider).buildRequest(parsedWith([{ role: "user", content: "hi" }], tools));
    const current = JSON.parse(body).conversationState.currentMessage.userInputMessage;
    const content = current.content as string;
    // Precondition: the nudge really is present and really did name the tools, and admission kept
    // every one of them -- otherwise this test would pass while charging less than it claims. Count
    // the emitted catalog rather than grepping the notice text, which is capitalized and would make
    // a lowercase absence check vacuous.
    expect(content).toContain("t00");
    expect(current.userInputMessageContext.tools).toHaveLength(MAX_KIRO_TOOL_COUNT + 1); // + the completion tool
    expect(content).toContain(KIRO_COMPLETION_INSTRUCTIONS);
  });

  test("an omission-forcing catalog (notice plus nudge) does not truncate the contract", async () => {
    // Oversized descriptions blow the byte budget, so admission omits tools and the omission notice
    // is charged on top of the nudge. Both charged inputs present at once.
    const tools = Array.from({ length: MAX_KIRO_TOOL_COUNT * 2 }, (_unused, index) => ({
      name: `omit_${index}_${"x".repeat(50)}`.slice(0, 64),
      description: "y".repeat(6000),
      parameters: { type: "object" },
    }));
    const content = await injectedSystemText(tools);
    // Precondition: admission really did omit tools, so the notice is charged alongside the nudge.
    expect(content).toMatch(/omitted/i);
    expect(content).toContain(KIRO_COMPLETION_INSTRUCTIONS);
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

describe("kiro code-mode catalog nudge", () => {
  // Codex code mode advertises ONE freeform `exec` and reaches everything else through nested
  // `tools.<name>(...)` helpers. The nudge sentence naming `ALL_TOOLS` is the only place a routed
  // model learns those helpers are discoverable, and Kiro was the one adapter that never enabled
  // it: `buildNonOpenAIToolCatalogNudgeFromNames` was called without `codeModeExecName`, so a
  // Kiro model concluded no spawn/subagent tool existed and never delegated.
  async function kiroSystemText(tools: unknown[], modelId = "claude-sonnet-4.5"): Promise<string> {
    const { body } = await createKiroAdapter(provider).buildRequest(parsedWith([{ role: "user", content: "hi" }], tools, modelId));
    return JSON.parse(body).conversationState.currentMessage.userInputMessage.content as string;
  }

  const codeModeExec = { name: "exec", description: "Run JavaScript", freeform: true, parameters: { type: "object" } };

  test("names ALL_TOOLS when a freeform exec is advertised without a bare shell bridge", async () => {
    const content = await kiroSystemText([codeModeExec, { name: "wait", description: "Resume", parameters: { type: "object" } }]);

    expect(content).toContain("ALL_TOOLS");
    expect(content).toContain("Codex code mode");
    // Reaches the ACTUAL Kiro wire prompt, not just the builder: the live 2026-08-28 session that
    // misread a blank result was a routed Kiro turn.
    expect(content).toContain("Nothing in the isolate is echoed automatically");
    // The generic fallback must be gone, not merely accompanied.
    expect(content).not.toContain("If a listed tool exposes nested helpers such as a tools.* API");
  });

  test("keeps the generic fallback for a STRUCTURED tool that merely shares the name exec", async () => {
    // A provider may advertise an ordinary structured `exec` that takes a shell string. Telling
    // that turn its body is JavaScript would be false, so the semantic `freeform` flag decides —
    // not the name. This is the control: a name-only implementation passes every other assertion
    // in this block and fails here.
    const content = await kiroSystemText([{ name: "exec", description: "Run a shell command", parameters: { type: "object" } }]);

    expect(content).not.toContain("ALL_TOOLS");
    expect(content).toContain("If a listed tool exposes nested helpers such as a tools.* API");
  });

  test("does not claim code mode when a bare shell bridge sits beside exec", async () => {
    const content = await kiroSystemText([codeModeExec, { name: "exec_command", description: "Run a shell command", parameters: { type: "object" } }]);

    expect(content).not.toContain("ALL_TOOLS");
  });

  test("decides on the EMITTED catalog: a budget-omitted shell bridge no longer suppresses code mode", async () => {
    // Resolving the predicates over the REQUESTED list is wrong in a reproducible way: the bridge
    // can be dropped by the count budget while `exec` survives, so the model receives a
    // code-mode-shaped catalog containing no shell bridge at all. Suppressing the nudge there
    // withholds discovery in exactly the crowded-catalog sessions where delegation matters most.
    const filler = Array.from({ length: MAX_KIRO_TOOL_COUNT - 1 }, (_, index) => ({
      name: `filler_${String(index).padStart(3, "0")}`,
      description: `Filler ${index}`,
      parameters: { type: "object" },
    }));
    const { body } = await createKiroAdapter(provider).buildRequest(
      parsedWith([{ role: "user", content: "hi" }], [...filler, codeModeExec, { name: "exec_command", description: "Run a shell command", parameters: { type: "object" } }]),
    );
    const current = JSON.parse(body).conversationState.currentMessage.userInputMessage;
    const emitted = current.userInputMessageContext.tools.map((tool: { toolSpecification: { name: string } }) => tool.toolSpecification.name);

    expect(emitted).toContain("exec");
    expect(emitted).not.toContain("exec_command");
    expect(current.content).toContain("ALL_TOOLS");
  });

  test("does not name a STRUCTURED exec that the catalog budget dropped", async () => {
    // A tool the model cannot call must never be named as its execution surface. wp2 makes a
    // code-mode `exec` survive the budget, so this invariant is now demonstrated on a structured
    // `exec`: it stays ordinary filler, so 48 fillers ahead of it drop it deterministically.
    const filler = Array.from({ length: MAX_KIRO_TOOL_COUNT }, (_, index) => ({
      name: `filler_${String(index).padStart(3, "0")}`,
      description: `Filler ${index}`,
      parameters: { type: "object" },
    }));
    const { body } = await createKiroAdapter(provider).buildRequest(
      parsedWith([{ role: "user", content: "hi" }], [...filler, { name: "exec", description: "Run a shell command", parameters: { type: "object" } }]),
    );
    const current = JSON.parse(body).conversationState.currentMessage.userInputMessage;
    const emitted = current.userInputMessageContext.tools.map((tool: { toolSpecification: { name: string } }) => tool.toolSpecification.name);

    expect(emitted).not.toContain("exec");
    expect(current.content).not.toContain("ALL_TOOLS");
  });

  test("advertises no code mode for a tool_choice:none turn", async () => {
    const parsed = {
      modelId: "claude-sonnet-4.5",
      stream: true,
      options: { toolChoice: "none" },
      context: { messages: [{ role: "user", content: "hi" }], tools: [codeModeExec] },
    } as unknown as OcxParsedRequest;
    const { body } = await createKiroAdapter(provider).buildRequest(parsed);
    const content = JSON.parse(body).conversationState.currentMessage.userInputMessage.content as string;

    expect(content).not.toContain("ALL_TOOLS");
  });
});

describe("kiro code-mode exec survives the catalog budget", () => {
  // Under code mode `exec` is not one tool among many: shell, file edits, apply_patch and every
  // MCP helper are reachable ONLY as nested `tools.<name>(...)` calls inside it. A catalog that
  // drops `exec` to keep more helpers admits tools the model cannot call at all. Cursor pins its
  // execution path for the same reason (request-builder.ts, #399); Kiro ranked it as filler.
  const codeModeExec = { name: "exec", description: "Run JavaScript", freeform: true, parameters: { type: "object" } };
  const fillerTools = (count: number) => Array.from({ length: count }, (_, index) => ({
    name: `ordinary_${String(index).padStart(3, "0")}`,
    description: `Ordinary ${index}`,
    parameters: { type: "object" },
  }));

  async function emitted(tools: unknown[]): Promise<{ names: string[]; notice: string }> {
    const { body } = await createKiroAdapter(provider).buildRequest(parsedWith([{ role: "user", content: "hi" }], tools));
    const current = JSON.parse(body).conversationState.currentMessage.userInputMessage;
    return {
      // Drop Kiro's private completion tool, which is appended after the client catalog.
      names: current.userInputMessageContext.tools.slice(0, -1).map((tool: { toolSpecification: { name: string } }) => tool.toolSpecification.name),
      notice: current.content.split("\n\n", 1)[0] as string,
    };
  }

  test("a last-declared code-mode exec survives an over-budget catalog", async () => {
    const { names } = await emitted([...fillerTools(MAX_KIRO_TOOL_COUNT + 20), codeModeExec]);

    expect(names).toContain("exec");
    expect(names).toHaveLength(MAX_KIRO_TOOL_COUNT);
  });

  test("reserving exec costs exactly one loaded tool, not the execution path", async () => {
    // The reservation tradeoff, stated as a test. A session can accumulate an unbounded number of
    // tool_search results (responses/parser.ts pushes every spec), all of which outrank exec. If
    // the fill loop ran unreserved, 48 loaded tools would exhaust the count budget and drop the
    // one tool that makes the other 48 callable.
    const loaded = Array.from({ length: MAX_KIRO_TOOL_COUNT }, (_, index) => ({
      name: `loaded_${String(index).padStart(3, "0")}`,
      description: `Loaded ${index}`,
      parameters: { type: "object" },
      loadedFromToolSearch: true,
    }));
    const { names, notice } = await emitted([...loaded, codeModeExec]);

    expect(names).toContain("exec");
    expect(names).toHaveLength(MAX_KIRO_TOOL_COUNT);
    // Exactly one loaded tool pays for the reservation, and the notice names it honestly.
    expect(names.filter(name => name.startsWith("loaded_"))).toHaveLength(MAX_KIRO_TOOL_COUNT - 1);
    expect(notice).toContain("loaded_047");
    expect(notice).not.toContain("`exec`");
  });

  test("emits loaded -> exec -> gateway order in an over-budget catalog", async () => {
    // Declared adversarially (gateway first, loaded last) so the assertion can only pass if the
    // priority comparator actually ran. The sort is gated on exceedsBudget, so the fixture must
    // exceed the count budget or this would pass identically without the change.
    const gateway = { name: "tool_search", description: "Search deferred tools", parameters: { type: "object" }, toolSearch: true };
    const loaded = { name: "codex_app__send_message_to_thread", description: "Send", parameters: { type: "object" }, loadedFromToolSearch: true };
    const { names, notice } = await emitted([gateway, ...fillerTools(MAX_KIRO_TOOL_COUNT + 20), codeModeExec, loaded]);

    expect(names.slice(0, 3)).toEqual([loaded.name, "exec", gateway.name]);
    expect(notice).not.toContain(loaded.name);
    expect(notice).not.toContain(gateway.name);
  });

  test("a byte-budget catalog reserves room for exec without breaching the budget", async () => {
    // The count budget is the easy case. Bytes are where a naive reservation breaks: the budget is
    // measured over the serialized ARRAY, so exec must be projected into every fit check rather
    // than subtracted as a standalone size. Admitting exec on top of an already-full catalog would
    // satisfy "exec survives" while blowing the ceiling, so both halves are asserted here.
    const heavy = Array.from({ length: 40 }, (_, index) => ({
      name: `heavy_${String(index).padStart(3, "0")}`,
      description: `Heavy ${index}`,
      parameters: { type: "object", properties: { blob: { type: "string", description: "x".repeat(8_000) } } },
    }));
    const { body } = await createKiroAdapter(provider).buildRequest(
      parsedWith([{ role: "user", content: "hi" }], [...heavy, codeModeExec]),
    );
    const current = JSON.parse(body).conversationState.currentMessage.userInputMessage;
    const specs = current.userInputMessageContext.tools.slice(0, -1);
    const names = specs.map((tool: { toolSpecification: { name: string } }) => tool.toolSpecification.name);
    const serializedBytes = new TextEncoder().encode(JSON.stringify(specs)).byteLength;

    expect(names).toContain("exec");
    expect(names.length).toBeLessThan(heavy.length + 1);
    expect(serializedBytes).toBeLessThanOrEqual(MAX_KIRO_TOOL_CATALOG_BYTES);
  });
});
