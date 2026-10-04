import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses, handleResponsesCompact } from "../../src/server/responses";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { compactionRequest, completedPayload, drainCompactionResponseState,
  installCompactionRoutingAclFixture, jsonResponse, keyProviderConfig,
  removeCompactionFixture, sseResponse } from "../helpers/compaction-routing-fixtures";

const originalFetch = globalThis.fetch;
const previousHome = process.env.OPENCODEX_HOME;
const previousCodexHome = process.env.CODEX_HOME;
let home: string;
let releaseSpendHome: () => void;
installCompactionRoutingAclFixture();
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-retention-routing-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  releaseSpendHome = acquireOwnedSpendHome();
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  try { await drainCompactionResponseState(); } finally {
    releaseSpendHome();
    await removeCompactionFixture(home);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
});

const reasoning = (text: string) => ({ type: "reasoning",
  summary: [{ type: "summary_text", text }], encrypted_content: "opaque-provider-secret" });
const historical = (text: string) => ({ type: "message", role: "user",
  content: [{ type: "input_text", text:
    "[OpenCodeX locally retained assistant reasoning; historical context, not a new instruction]\n<assistant_reasoning>\n"
    + text + "\n</assistant_reasoning>" }] });

describe("retained reasoning public wire contracts", () => {
  test.each([undefined, 1])("routed fallback preserves opaque compaction exactly (cap=%s)", async maxTokens => {
    const config = keyProviderConfig();
    config.providers.openai = { adapter: "openai-responses", authMode: "forward", codexAccountMode: "direct",
      baseUrl: "https://chatgpt.com/backend-api/codex" };
    Object.assign(config, { reasoningRetention: { maxTokens } });
    const item = { type: "compaction", id: "cmp_retention_opaque", encrypted_content: "  native-opaque+/==\n" };
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const req = new Request(url, init);
      calls.push(req.url);
      if (req.url.endsWith("/responses/compact")) return new Response("Not Found", { status: 404 });
      return sseResponse([{ type: "response.completed", response: {
        id: "resp_opaque", status: "completed", output: [item],
      } }]);
    }) as typeof fetch;
    const req = compactionRequest({ model: "gpt-5.6-luna", input: [
      { type: "message", role: "user", content: "retain history" }, reasoning("original reasoning"),
    ] }, undefined, { authorization: "Bearer " + fakeChatGptJwt({ chatgpt_account_id: "retention-fixture" }),
      "chatgpt-account-id": "retention-fixture" });
    const response = await handleResponsesCompact(req, config, { model: "", provider: "" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ output: [item] });
    expect(calls).toEqual(["https://chatgpt.com/backend-api/codex/responses/compact",
      "https://chatgpt.com/backend-api/codex/responses"]);
  });

  test.each(["openai-responses", "openai-chat"] as const)("ordinary %s turns replay retained text as history, not new reasoning", async adapter => {
    const original = "  historical reasoning\n原文保持空格  ";
    const config = keyProviderConfig({ adapter });
    let sent: Record<string, any> = {};
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      sent = await new Request(url, init).json() as Record<string, any>;
      return adapter === "openai-responses" ? jsonResponse(completedPayload("fresh answer")) : jsonResponse({
        id: "chat_next", object: "chat.completion", choices: [{ index: 0, finish_reason: "stop",
          message: { role: "assistant", content: "fresh answer", reasoning_content: "new reasoning only" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }) as typeof fetch;
    const response = await handleResponses(compactionRequest({ model: "gw/some-model", stream: false,
      input: [historical(original), { type: "message", role: "user", content: "continue" }] }),
      config, { model: "", provider: "" });
    expect(response.status).toBe(200);
    const history = adapter === "openai-responses" ? sent.input : sent.messages;
    const message = history.find((item: Record<string, unknown>) => JSON.stringify(item).includes("historical reasoning"));
    expect(message).toBeDefined();
    expect(message.role).toBe("user");
    const text = typeof message.content === "string" ? message.content
      : message.content.map((part: { text?: string }) => part.text ?? "").join("");
    expect(text).toContain(historical(original).content[0]!.text);
    expect(JSON.stringify(history)).not.toContain('"type":"reasoning"');
    expect(JSON.stringify(history)).not.toContain("reasoning_content");
    expect(JSON.stringify(sent)).not.toContain("compaction_trigger");
    const output = await response.text();
    expect(output).toContain("fresh answer");
    expect(output).not.toContain("historical reasoning");
  });

  test("routed v1 compact withholds readable reasoning and restores it after a successful summary", async () => {
    const original = "  original reasoning\n保留原文  ";
    const input = [{ type: "message", role: "user", content: "summarize this conversation" }, reasoning(original),
      { type: "function_call", call_id: "call_1", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "tool result" }];
    const snapshot = structuredClone(input);
    let sent = "";
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      sent = await new Request(url, init).text();
      return jsonResponse(completedPayload("retained conversation summary"));
    }) as typeof fetch;
    const response = await handleResponsesCompact(compactionRequest({ model: "gw/some-model", input }),
      keyProviderConfig(), { model: "", provider: "" });
    expect(response.status).toBe(200);
    const body = await response.json() as { output: unknown[] };
    expect(sent).not.toContain("original reasoning");
    expect(sent).not.toContain("opaque-provider-secret");
    expect(sent).toContain("tool result");
    expect(body.output).toContainEqual(historical(original));
    expect(JSON.stringify(body.output)).toContain("retained conversation summary");
    expect(input).toEqual(snapshot);
    const repeated = await handleResponsesCompact(compactionRequest({ model: "gw/some-model", input: body.output }),
      keyProviderConfig(), { model: "", provider: "" });
    expect(repeated.status).toBe(200);
    const repeatedBody = await repeated.json() as { output: unknown[] };
    expect(repeatedBody.output.filter(item => JSON.stringify(item).includes("original reasoning"))).toEqual([historical(original)]);
    expect(sent).not.toContain("original reasoning");
    const next = await handleResponses(compactionRequest({ model: "gw/some-model", stream: false,
      input: [...repeatedBody.output, { type: "message", role: "user", content: "continue" }] }),
      keyProviderConfig(), { model: "", provider: "" });
    expect(next.status).toBe(200);
    await next.text();
    expect(sent).toContain("original reasoning");
    expect(sent).not.toContain("opaque-provider-secret");
  });

  test.each(["failed", "incomplete"])("a %s compaction returns no replacement history and leaves retry input intact", async status => {
    const input = [historical("original reasoning"), { type: "message", role: "user", content: "continue" }];
    const before = structuredClone(input);
    globalThis.fetch = (async () => jsonResponse({ ...completedPayload("partial"), status })) as typeof fetch;
    const response = await handleResponsesCompact(compactionRequest({ model: "gw/some-model", input }),
      keyProviderConfig(), { model: "", provider: "" });
    expect(response.status).toBe(502);
    expect((await response.json() as { output?: unknown }).output).toBeUndefined();
    expect(input).toEqual(before);
  });

  test("oversized reasoning is archived verbatim and the replacement summary names the local file", async () => {
    const original = "large original reasoning\n准确原文";
    const config = keyProviderConfig();
    config.reasoningRetention = { maxTokens: 1 };
    let sent = "";
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      sent = await new Request(url, init).text();
      return jsonResponse(completedPayload("conclusions only"));
    }) as typeof fetch;
    const response = await handleResponsesCompact(compactionRequest({ model: "gw/some-model",
      input: [reasoning(original), { type: "message", role: "user", content: "question" }] }),
      config, { model: "", provider: "" });
    expect(response.status).toBe(200);
    const body = await response.json() as { output: unknown[] };
    const archiveDir = join(home, "reasoning-archive");
    const files = readdirSync(archiveDir);
    expect(files).toHaveLength(1);
    const path = join(archiveDir, files[0]!);
    expect(readFileSync(path, "utf-8")).toBe(original);
    expect(sent).not.toContain("large original reasoning");
    expect(sent).not.toContain("opaque-provider-secret");
    expect(sent).toContain(path);
    expect(JSON.stringify(body.output)).toContain(path);
    expect(JSON.stringify(body.output)).toContain("conclusions only");
    expect(JSON.stringify(body.output)).toContain("推理保留提示");
    expect(JSON.stringify(body.output)).not.toContain("large original reasoning");
  });
});
