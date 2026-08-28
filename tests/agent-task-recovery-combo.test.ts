import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearResponseStateForTests,
  clearResponseStateMemoryForTests,
  responseContinuationRetainedStoreSnapshot,
  runPendingResponseStatePersistForTests,
} from "../src/responses/state";
import { resetAgentTaskRecoveryState } from "../src/server/responses/agent-task-recovery";
import {
  codexHeaders,
  encryptedInput,
  FERNET_TASK,
  originalFetch,
  post,
  providerResponse,
  recoverySse,
  routedConfig,
} from "./helpers/agent-task-recovery";

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
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetAgentTaskRecoveryState();
    clearResponseStateForTests();
    rmSync(home, { recursive: true, force: true });
    if (priorHome === undefined) delete process.env["OPENCODEX_HOME"];
    else process.env["OPENCODEX_HOME"] = priorHome;
  });

  test("recovers an all-third-party combo once without retaining plaintext continuation state", async () => {
    const assignment = "RECOVERED-COMBO-PLAINTEXT-SENTINEL";
    const fetchedUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url.includes("chatgpt.com")) {
        return new Response(recoverySse(assignment), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
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
    expect(responseContinuationRetainedStoreSnapshot().count).toBe(0);
    const snapshotPath = join(home, "responses-state.json");
    const snapshot = existsSync(snapshotPath) ? readFileSync(snapshotPath, "utf8") : "";
    expect(snapshot).not.toContain(assignment);
    expect(snapshot).not.toContain(responsePayload.id!);
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
});
