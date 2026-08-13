import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  noteSubagentModelFailure,
  resetSubagentModelFallbackStateForTests,
} from "../src/codex/subagent-model-fallback";
import { resetAgentTaskRecoveryState } from "../src/server/responses/agent-task-recovery";
import {
  codexHeaders,
  encryptedInput,
  originalFetch,
  post,
  providerResponse,
  recoverySse,
  routedConfig,
} from "./helpers/agent-task-recovery";

describe("agent task recovery fallback routing", () => {
  beforeEach(() => {
    resetAgentTaskRecoveryState();
    resetSubagentModelFallbackStateForTests();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetAgentTaskRecoveryState();
    resetSubagentModelFallbackStateForTests();
  });

  test("routes a recovered task through the healthy routed fallback", async () => {
    const config = routedConfig();
    config.subagentModelFallback = ["xai/grok-4.6"];
    noteSubagentModelFailure("xai/grok-4.5", "429", config);

    const fetchedUrls: string[] = [];
    const providerModels: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url.includes("chatgpt.com")) {
        return new Response(recoverySse("Dispatch this recovered task through the healthy fallback."), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }

      const raw = typeof init?.body === "string" ? init.body : "{}";
      const body = JSON.parse(raw) as { model?: string };
      providerModels.push(body.model ?? "");
      return providerResponse();
    }) as typeof fetch;

    const response = await post(
      config,
      "xai/grok-4.5",
      encryptedInput(),
      codexHeaders(),
    );

    expect(response.status).toBe(200);
    expect(fetchedUrls).toHaveLength(2);
    expect(fetchedUrls[0]).toContain("chatgpt.com/backend-api/codex");
    expect(fetchedUrls[1]).toContain("api.x.ai");
    expect(providerModels).toEqual(["grok-4.6"]);
  });
});
