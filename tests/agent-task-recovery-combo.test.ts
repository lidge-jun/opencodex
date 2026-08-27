import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAgentTaskRecoveryState } from "../src/server/responses/agent-task-recovery";
import {
  agentMessage,
  codexHeaders,
  encryptedInput,
  FERNET_TASK,
  originalFetch,
  post,
  providerResponse,
  recoverySse,
  routedConfig,
} from "./helpers/agent-task-recovery";

function comboConfig(): ReturnType<typeof routedConfig> {
  const config = routedConfig();
  config.combos = {
    fast: {
      targets: [
        { provider: "xai", model: "grok-4.5" },
      ],
    },
  };
  return config;
}

describe("combo path encrypted agent task recovery", () => {
  beforeEach(() => {
    resetAgentTaskRecoveryState();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetAgentTaskRecoveryState();
  });

  test("recovers a ciphertext-only spawn before the combo payload gate", async () => {
    const config = comboConfig();
    const fetchedUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url.includes("chatgpt.com")) {
        return new Response(recoverySse("plaintext assignment"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return providerResponse();
    }) as typeof fetch;

    const response = await post(config, "combo/fast", encryptedInput(), codexHeaders());

    expect(response.status).toBe(200);
    expect(fetchedUrls[0]).toContain("chatgpt.com/backend-api/codex");
    // One recovery call + one provider dispatch: recovery never repeats per child attempt.
    expect(fetchedUrls).toHaveLength(2);
  });

  test("still fails closed when recovery does not produce a readable task", async () => {
    const config = comboConfig();
    globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;

    const response = await post(config, "combo/fast", [
      ...agentMessage([
        { type: "input_text", text: "Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:" },
        { type: "encrypted_content", encrypted_content: FERNET_TASK },
      ]),
    ], codexHeaders());

    expect(response.status).toBe(400);
    const payload = await response.json() as { error?: { code?: string } };
    expect(payload.error?.code).toBe("unreadable_encrypted_agent_task");
  });
});
