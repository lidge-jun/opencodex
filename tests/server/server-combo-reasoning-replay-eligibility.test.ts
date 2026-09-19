import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { clearReasoningReplayCacheForTests } from "../../src/responses/reasoning-replay-cache";
import {
  clearResponseStateForTests,
  flushResponseState,
  responseStatePersistPendingForTests,
} from "../../src/responses/state";
import { handleResponses } from "../../src/server/responses";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
import { TARGET_INCOMPATIBLE_MESSAGE } from "../../src/server/responses/core-errors";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

type HandleOptions = NonNullable<Parameters<typeof handleResponses>[3]>;

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
const servers: Array<ReturnType<typeof Bun.serve>> = [];
let releaseSpendHome: (() => void) | undefined;

// Acquire only for rows that physically dispatch, after their temporary home is installed.
const takeSpendHome = (): void => { releaseSpendHome = acquireOwnedSpendHome(); };

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-combo-reasoning-replay-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-combo-reasoning-replay-"));
  process.env.OPENCODEX_HOME = testDir;
  clearComboSelectionState();
  clearComboRecallForTests();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
  clearResponseStateForTests();
  clearReasoningReplayCacheForTests();
});

afterEach(async () => {
  // Release before home teardown to prevent Windows removal failures and a live unlinked database.
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  let responseStatePending = true;
  try {
    for (const server of servers.splice(0)) await server.stop(true);
    await flushResponseState();
    responseStatePending = responseStatePersistPendingForTests();
  } finally {
    clearResponseStateForTests();
    clearReasoningReplayCacheForTests();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    isolatedCodexHome?.restore();
    isolatedCodexHome = null;
    if (testDir) removeTreeWithRetry(testDir);
    clearComboSelectionState();
    clearComboRecallForTests();
    clearComboTargetCooldowns();
    clearKeyCooldowns();
  }
  expect(responseStatePending).toBe(false);
});

function serve(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  return server;
}

function baseUrl(server: ReturnType<typeof Bun.serve>): string {
  return `${server.url.toString().replace(/\/$/, "")}/v1`;
}

function chatSuccess(text: string, model = "model"): Response {
  return Response.json({
    id: `chatcmpl-${model}`,
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  });
}

function responsesSuccess(text: string, model = "responses-model"): Record<string, unknown> {
  return {
    id: `resp-${model}`,
    object: "response",
    status: "completed",
    model,
    output: [{
      id: "msg_backup",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    }],
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
  };
}

function provider(
  adapter: string,
  url: string,
  apiKey: string,
  extra: Partial<OcxProviderConfig> = {},
): OcxProviderConfig {
  return {
    adapter,
    baseUrl: url,
    allowPrivateNetwork: url.includes("127.0.0.1"),
    authMode: "key",
    apiKey,
    ...extra,
  };
}

function comboConfig(
  providers: OcxConfig["providers"],
  targets = Object.keys(providers).map((name, index) => ({ provider: name, model: `m${index + 1}` })),
): OcxConfig {
  return {
    port: 0,
    defaultProvider: Object.keys(providers)[0]!,
    providers,
    combos: { free: { strategy: "failover", targets } },
  };
}

async function post(
  config: OcxConfig,
  raw: Record<string, unknown> = {},
  options: HandleOptions = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  return handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "combo/free", input: "hello", stream: false, ...raw }),
  }), config, { model: "", provider: "" }, options);
}

describe("combo mandatory reasoning replay failover", () => {
  const tools = [{
    type: "function",
    name: "get_weather",
    description: "Get weather",
    parameters: { type: "object", properties: {} },
  }];
  const toolContinuation = (reasoning: Record<string, unknown>) => [
    reasoning,
    { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "rain" },
  ];
  const strictPlaintextProvider = (url: string, apiKey: string): OcxProviderConfig => provider(
    "openai-responses",
    url,
    apiKey,
    {
      preserveResponsesReasoningContent: true,
      requiresAdjacentResponsesToolResults: true,
    },
  );

  test("a missing provider row preserves the existing combo-unavailable response", async () => {
    const config = comboConfig({}, [{ provider: "missing", model: "bad-model" }]);

    const response = await post(config);

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe(
      '{"error":{"message":"No available targets for combo: free","type":"server_error","code":"combo_unavailable"}}',
    );
  });

  test("upstream_server_error failover to strict Responses preserves existing reasoning_text", async () => {
    takeSpendHome();
    const failed = serve(() => Response.json({
      error: { type: "server_error", code: "upstream_server_error", message: "busy" },
    }, { status: 500 }));
    let strictBody: Record<string, unknown> | undefined;
    const strict = serve(async request => {
      strictBody = await request.json() as Record<string, unknown>;
      return Response.json(responsesSuccess("strict replay accepted", "deepseek-v4-flash"));
    });
    const config = comboConfig({
      failed: provider("openai-responses", baseUrl(failed), "key-failed"),
      strict: strictPlaintextProvider(baseUrl(strict), "key-strict"),
    }, [
      { provider: "failed", model: "m1" },
      { provider: "strict", model: "deepseek-v4-flash" },
    ]);

    const response = await post(config, {
      tools,
      input: toolContinuation({
        type: "reasoning",
        id: "rs_plaintext",
        summary: [],
        content: [{ type: "reasoning_text", text: "keep this reasoning" }],
      }),
    }, {}, { session_id: "combo-plaintext-replay" });

    expect(response.status).toBe(200);
    expect(strictBody).toBeDefined();
    const strictInput = strictBody!.input as Record<string, unknown>[];
    expect(strictInput[0]).toMatchObject({
      type: "reasoning",
      content: [{ type: "reasoning_text", text: "keep this reasoning" }],
    });
  });

  test("a foreign opaque-only replay skips the strict target without forwarding or fabrication", async () => {
    takeSpendHome();
    let firstTargetFails = false;
    const first = serve(() => firstTargetFails
      ? Response.json({ error: { type: "server_error", code: "upstream_server_error", message: "busy" } }, { status: 500 })
      : Response.json(responsesSuccess("seed identity", "m1")));
    let strictHits = 0;
    const strict = serve(() => {
      strictHits += 1;
      return Response.json(responsesSuccess("must not be reached", "deepseek-v4-flash"));
    });
    let backupBody = "";
    const backup = serve(async request => {
      backupBody = await request.text();
      return chatSuccess("compatible backup", "m3");
    });
    const config = comboConfig({
      first: provider("openai-responses", baseUrl(first), "key-first"),
      strict: strictPlaintextProvider(baseUrl(strict), "key-strict"),
      backup: provider("openai-chat", baseUrl(backup), "key-backup"),
    }, [
      { provider: "first", model: "m1" },
      { provider: "strict", model: "deepseek-v4-flash" },
      { provider: "backup", model: "m3" },
    ]);
    const headers = { session_id: "combo-foreign-opaque-replay" };

    const seeded = await post(config, { input: "seed" }, {}, headers);
    expect(seeded.status).toBe(200);
    await seeded.text();
    firstTargetFails = true;

    const response = await post(config, {
      tools,
      input: toolContinuation({
        type: "reasoning",
        id: "rs_foreign",
        summary: [],
        encrypted_content: "foreign-provider-blob",
        content: [],
      }),
    }, {}, headers);

    expect(response.status).toBe(200);
    expect(strictHits).toBe(0);
    expect(backupBody).not.toContain("foreign-provider-blob");
    expect(backupBody).not.toContain("reasoning_text");
    expect(await response.text()).toContain("compatible backup");
  });

  test("an exhausted combo reports target_incompatible when mandatory plaintext is unavailable", async () => {
    takeSpendHome();
    let firstTargetFails = false;
    const first = serve(() => firstTargetFails
      ? Response.json({ error: { type: "server_error", code: "upstream_server_error", message: "busy" } }, { status: 500 })
      : Response.json(responsesSuccess("seed identity", "m1")));
    let strictHits = 0;
    const strict = serve(() => {
      strictHits += 1;
      return Response.json(responsesSuccess("must not be reached", "deepseek-v4-flash"));
    });
    const config = comboConfig({
      first: provider("openai-responses", baseUrl(first), "key-first"),
      strict: strictPlaintextProvider(baseUrl(strict), "key-strict"),
    }, [
      { provider: "first", model: "m1" },
      { provider: "strict", model: "deepseek-v4-flash" },
    ]);
    const headers = { session_id: "combo-incompatible-replay" };

    const seeded = await post(config, { input: "seed" }, {}, headers);
    expect(seeded.status).toBe(200);
    await seeded.text();
    firstTargetFails = true;

    const response = await post(config, {
      tools,
      input: toolContinuation({
        type: "reasoning",
        id: "rs_foreign",
        summary: [],
        encrypted_content: "foreign-provider-blob",
        content: [],
      }),
    }, {}, headers);
    const error = await response.json() as { error?: { code?: string; message?: string } };

    expect(response.status).toBe(400);
    expect(error.error?.code).toBe("target_incompatible");
    expect(error.error?.message).toBe(TARGET_INCOMPATIBLE_MESSAGE);
    expect(strictHits).toBe(0);
  });
});
