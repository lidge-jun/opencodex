import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearResponseStateForTests,
  clearResponseStateMemoryForTests,
  responseContinuationRetainedStoreSnapshot,
  runPendingResponseStatePersistForTests,
} from "../../src/responses/state";
import { resetAgentTaskRecoveryState } from "../../src/server/responses/agent-task-recovery";
import { agentTaskRecoveryCacheSnapshotForTests } from "../../src/server/responses/agent-task-recovery-cache";
import { clearComboTargetCooldowns, coolComboTarget } from "../../src/combos/failover";
import {
  clearCachedProviderQuotas,
  setCachedProviderQuotaForTests,
} from "../../src/providers/quota-routing-cache";
import {
  codexHeaders,
  encryptedInput,
  FERNET_TASK,
  originalFetch,
  post,
  providerResponse,
  recoverySse,
  routedConfig,
} from "../helpers/agent-task-recovery";
import { removeTreeWithRetry } from "../helpers/remove-tree";

function providerCompletion(): Response {
  return Response.json({
    id: "chatcmpl_combo_recovery",
    object: "chat.completion",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "done" },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

function comboConfig(targets: Array<{ provider: string; model: string }>) {
  const config = routedConfig();
  config.combos = {
    routed: {
      strategy: "failover",
      targets,
    },
  };
  return config;
}

describe("combo path encrypted agent task recovery", () => {
  const priorHome = process.env["OPENCODEX_HOME"];
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-agent-task-combo-"));
    process.env["OPENCODEX_HOME"] = home;
    clearResponseStateMemoryForTests();
    resetAgentTaskRecoveryState();
    clearCachedProviderQuotas();
    clearComboTargetCooldowns();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetAgentTaskRecoveryState();
    clearCachedProviderQuotas();
    clearComboTargetCooldowns();
    clearResponseStateForTests();
    removeTreeWithRetry(home);
    if (priorHome === undefined) delete process.env["OPENCODEX_HOME"];
    else process.env["OPENCODEX_HOME"] = priorHome;
  });

  test("recovers an all-third-party combo once without retaining plaintext continuation state", async () => {
    const assignment = "RECOVERED-COMBO-PLAINTEXT-SENTINEL";
    const fetchedUrls: string[] = [];
    const forwardedBodies: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url.includes("chatgpt.com")) {
        return new Response(recoverySse(assignment), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      forwardedBodies.push(typeof init?.body === "string" ? init.body : "");
      return providerCompletion();
    }) as typeof fetch;

    const response = await post(
      comboConfig([{ provider: "xai", model: "grok-4.5" }]),
      "combo/routed",
      encryptedInput(),
      codexHeaders(),
    );
    await runPendingResponseStatePersistForTests();
    const responsePayload = await response.clone().json() as { id?: string };

    expect(response.status).toBe(200);
    expect(typeof responsePayload.id).toBe("string");
    expect(fetchedUrls).toHaveLength(2);
    expect(fetchedUrls[0]).toContain("chatgpt.com/backend-api/codex/responses");
    expect(forwardedBodies).toHaveLength(1);
    expect(forwardedBodies[0]).toContain(assignment);
    expect(forwardedBodies[0]).not.toContain(FERNET_TASK);
    expect(forwardedBodies[0].match(/Message Type: NEW_TASK/g)).toHaveLength(1);
    expect(responseContinuationRetainedStoreSnapshot().count).toBe(0);
    const snapshotPath = join(home, "responses-state.json");
    const snapshot = existsSync(snapshotPath) ? readFileSync(snapshotPath, "utf8") : "";
    expect(snapshot).not.toContain(assignment);
    expect(snapshot).not.toContain(responsePayload.id!);
  });

  test("rejects an all-disabled combo before recovery creates or caches plaintext", async () => {
    const assignment = "MUST-NOT-BE-PRODUCED-OR-CACHED";
    const config = comboConfig([{ provider: "xai", model: "grok-4.5" }]);
    const headers = codexHeaders();
    config.providers.xai!.disabled = true;
    let recoveryFetches = 0;
    let providerFetches = 0;
    globalThis.fetch = (async (input) => {
      if (String(input).includes("chatgpt.com")) {
        recoveryFetches += 1;
        return new Response(recoverySse(assignment), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      providerFetches += 1;
      return providerCompletion();
    }) as typeof fetch;

    const coldResponse = await post(
      config,
      "combo/routed",
      encryptedInput(),
      headers,
    );
    const coldRaw = await coldResponse.text();

    expect(coldResponse.status).toBe(503);
    expect(JSON.parse(coldRaw)).toMatchObject({
      error: { type: "server_error", code: "combo_unavailable" },
    });
    expect(agentTaskRecoveryCacheSnapshotForTests()).toEqual({ entries: 0, bytes: 0 });
    expect(recoveryFetches).toBe(0);
    expect(providerFetches).toBe(0);
    expect(coldRaw).not.toContain(assignment);
    expect(coldRaw).not.toContain(FERNET_TASK);

    config.providers.xai!.disabled = false;
    expect((await post(
      config,
      "combo/routed",
      encryptedInput(),
      headers,
    )).status).toBe(200);
    expect(agentTaskRecoveryCacheSnapshotForTests()).toEqual({
      entries: 1,
      bytes: Buffer.byteLength(assignment),
    });
    expect(recoveryFetches).toBe(1);
    expect(providerFetches).toBe(1);

    config.providers.xai!.disabled = true;
    const warmResponse = await post(
      config,
      "combo/routed",
      encryptedInput(),
      headers,
    );

    expect(warmResponse.status).toBe(503);
    expect(agentTaskRecoveryCacheSnapshotForTests()).toEqual({ entries: 0, bytes: 0 });
    expect(recoveryFetches).toBe(1);
    expect(providerFetches).toBe(1);
  });

  test.each(["disabled", "cooldown"] as const)("recovers a mixed combo when the native target is blocked by %s", async (reason) => {
    const config = comboConfig([
      { provider: "xai", model: "grok-4.5" },
      { provider: "openai", model: "gpt-5.5" },
    ]);
    if (reason === "disabled") {
      config.providers.openai!.disabled = true;
    } else {
      coolComboTarget("routed", { provider: "openai", model: "gpt-5.5" }, { cooldownMs: 60_000 });
    }
    const assignment = "MIXED-RECOVERY-PRIVATE-ASSIGNMENT";
    const recoveryBodies: string[] = [];
    const forwardedBodies: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (String(input).includes("chatgpt.com")) {
        recoveryBodies.push(body);
        return new Response(recoverySse(assignment), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      forwardedBodies.push(body);
      return providerCompletion();
    }) as typeof fetch;

    const response = await post(config, "combo/routed", encryptedInput(), codexHeaders());
    await response.text();

    expect(response.status).toBe(200);
    expect(recoveryBodies).toHaveLength(1);
    expect(forwardedBodies).toHaveLength(1);
    expect(forwardedBodies[0]).toContain(assignment);
    expect(forwardedBodies[0]).not.toContain(FERNET_TASK);
    expect(responseContinuationRetainedStoreSnapshot().count).toBe(0);
  });

  test("fails closed without routed dispatch when mixed-combo recovery fails", async () => {
    const config = comboConfig([
      { provider: "xai", model: "grok-4.5" },
      { provider: "openai", model: "gpt-5.5" },
    ]);
    coolComboTarget("routed", { provider: "openai", model: "gpt-5.5" }, { cooldownMs: 60_000 });
    const urls: string[] = [];
    globalThis.fetch = (async (input) => {
      urls.push(String(input));
      return new Response("unavailable", { status: 503 });
    }) as typeof fetch;

    const response = await post(config, "combo/routed", encryptedInput(), codexHeaders());

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "unreadable_encrypted_agent_task" } });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("chatgpt.com/backend-api/codex/responses");
    expect(responseContinuationRetainedStoreSnapshot().count).toBe(0);
  });

  test("recovers once when the selected native target fails model authorization", async () => {
    const config = comboConfig([
      { provider: "openai", model: "gpt-5.5" },
      { provider: "xai", model: "grok-4.5" },
    ]);
    const assignment = "RECOVERED-AFTER-NATIVE-401";
    const chatgptBodies: string[] = [];
    const forwardedBodies: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (String(input).includes("chatgpt.com")) {
        chatgptBodies.push(body);
        if (body.includes("capture_assignment")) {
          return new Response(recoverySse(assignment), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return Response.json(
          { error: { message: "model is not enabled for this account", code: "model_not_found" } },
          { status: 401 },
        );
      }
      forwardedBodies.push(body);
      return providerCompletion();
    }) as typeof fetch;

    const response = await post(config, "combo/routed", encryptedInput(), codexHeaders());
    await response.text();

    expect(response.status).toBe(200);
    expect(chatgptBodies).toHaveLength(2);
    expect(chatgptBodies[0]).not.toContain("capture_assignment");
    expect(chatgptBodies[1]).toContain("capture_assignment");
    expect(forwardedBodies).toHaveLength(1);
    expect(forwardedBodies[0]).toContain(assignment);
    expect(forwardedBodies[0]).not.toContain(FERNET_TASK);
    expect(responseContinuationRetainedStoreSnapshot().count).toBe(0);
  });

  test("does not recover when every mixed-combo target is unavailable", async () => {
    const config = comboConfig([
      { provider: "xai", model: "grok-4.5" },
      { provider: "openai", model: "gpt-5.5" },
    ]);
    coolComboTarget("routed", { provider: "openai", model: "gpt-5.5" }, { cooldownMs: 60_000 });
    setCachedProviderQuotaForTests("xai", { updatedAt: Date.now(), weeklyPercent: 100 });
    globalThis.fetch = (async () => {
      throw new Error("No network call is permitted without an eligible execution target");
    }) as typeof fetch;

    const response = await post(config, "combo/routed", encryptedInput(), codexHeaders());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "combo_unavailable" } });
    expect(responseContinuationRetainedStoreSnapshot().count).toBe(0);
  });

  test("keeps an opted-in Responses target out of encrypted combo dispatch", async () => {
    const config = comboConfig([
      { provider: "relay", model: "relay-model" },
      { provider: "openai", model: "gpt-5.5" },
    ]);
    config.providers.relay = {
      adapter: "openai-responses",
      baseUrl: "https://relay.example.test/v1",
      authMode: "key",
      apiKey: "test-relay-key",
      allowEncryptedV2AgentTasks: true,
    };
    const fetchedUrls: string[] = [];
    const forwardedBodies: string[] = [];
    globalThis.fetch = (async (input, init) => {
      fetchedUrls.push(String(input));
      forwardedBodies.push(typeof init?.body === "string" ? init.body : "");
      return providerResponse();
    }) as typeof fetch;

    const response = await post(config, "combo/routed", encryptedInput(), codexHeaders());

    expect(response.status).toBe(200);
    expect(fetchedUrls).toEqual(["https://chatgpt.com/backend-api/codex/responses"]);
    expect(forwardedBodies).toHaveLength(1);
    expect(forwardedBodies[0]).toContain(FERNET_TASK);
    expect(forwardedBodies[0]).not.toContain("capture_assignment");
  });

  test("keeps fallback combo aliases out of direct encrypted dispatch", async () => {
    const config = comboConfig([
      { provider: "relay", model: "relay-model" },
      { provider: "openai", model: "gpt-5.5" },
    ]);
    delete config.agentTaskRecovery;
    config.subagentModelFallback = ["combo/routed"];
    config.providers.relay = {
      adapter: "openai-responses",
      baseUrl: "https://relay.example.test/v1",
      authMode: "key",
      apiKey: "test-relay-key",
      allowEncryptedV2AgentTasks: true,
    };
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return providerResponse();
    }) as typeof fetch;

    const response = await post(config, "xai/grok-4.5", encryptedInput(), codexHeaders());
    const payload = await response.json() as { error?: { code?: string } };

    expect(response.status).toBe(400);
    expect(payload.error?.code).toBe("unreadable_encrypted_agent_task");
    expect(fetchCalls).toBe(0);
  });

  test("keeps the canonical target bypass in a mixed combo without running recovery", async () => {
    const forwardedBodies: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      forwardedBodies.push(typeof init?.body === "string" ? init.body : "");
      return providerResponse();
    }) as typeof fetch;

    const response = await post(
      comboConfig([
        { provider: "xai", model: "grok-4.5" },
        { provider: "openai", model: "gpt-5.5" },
      ]),
      "combo/routed",
      encryptedInput(),
      codexHeaders(),
    );

    expect(response.status).toBe(200);
    expect(forwardedBodies).toHaveLength(1);
    expect(forwardedBodies[0]).toContain(FERNET_TASK);
    expect(forwardedBodies[0]).not.toContain("capture_assignment");
  });

  test.each([
    { site: "native-disabled", expectedNative: 0 },
    { site: "native-401", expectedNative: 1 },
  ] as const)("cancels $site recovery before routed dispatch or plaintext cache", async ({ site, expectedNative }) => {
    const config = comboConfig([
      { provider: "openai", model: "gpt-5.5" },
      { provider: "xai", model: "grok-4.5" },
    ]);
    if (site === "native-disabled") {
      config.providers.openai!.disabled = true;
    }
    const controller = new AbortController();
    let markRecoveryStarted: (() => void) | undefined;
    const recoveryStarted = new Promise<void>((resolve) => {
      markRecoveryStarted = resolve;
    });
    let nativeFetches = 0;
    let recoveryFetches = 0;
    let routedFetches = 0;
    globalThis.fetch = ((input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (!String(input).includes("chatgpt.com")) {
        routedFetches += 1;
        return Promise.resolve(providerCompletion());
      }
      if (body.includes("capture_assignment")) {
        recoveryFetches += 1;
        markRecoveryStarted?.();
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const rejectAbort = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
          if (signal?.aborted) rejectAbort();
          else signal?.addEventListener("abort", rejectAbort, { once: true });
        });
      }
      nativeFetches += 1;
      return Promise.resolve(Response.json(
        { error: { message: "model is not enabled for this account", code: "model_not_found" } },
        { status: 401 },
      ));
    }) as typeof fetch;

    const pending = post(
      config,
      "combo/routed",
      encryptedInput(),
      codexHeaders(),
      controller.signal,
    );
    await recoveryStarted;
    controller.abort(new DOMException("client disconnected", "AbortError"));
    const response = await pending;
    await runPendingResponseStatePersistForTests();
    const payload = await response.json() as { error?: { code?: string } };

    expect(response.status).toBe(499);
    expect(payload).toMatchObject({ error: { code: "client_cancelled" } });
    expect(nativeFetches).toBe(expectedNative);
    expect(recoveryFetches).toBe(1);
    expect(routedFetches).toBe(0);
    expect(agentTaskRecoveryCacheSnapshotForTests()).toEqual({ entries: 0, bytes: 0 });
    expect(responseContinuationRetainedStoreSnapshot().count).toBe(0);
  });
});
