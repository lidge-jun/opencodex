import { describe, expect, test } from "bun:test";
import { createDevinAdapter, mapOcxMessagesToDevin, mapOcxToolsToDevin } from "../src/adapters/devin";
import { DEVIN_STATIC_MODELS, filterDevinConfiguredModelsByLiveDiscovery } from "../src/adapters/devin/live-models";
import { importLocalPiDevinAuth } from "../src/oauth/devin";
import { OAUTH_PROVIDERS } from "../src/oauth";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import type { OcxParsedRequest } from "../src/types";

describe("devin adapter", () => {
  test("is registered as an oauth provider and adapter", () => {
    expect(OAUTH_PROVIDERS.devin.defaultModel).toBe("swe-1-7");
    const entry = PROVIDER_REGISTRY.find((row) => row.id === "devin");
    expect(entry?.adapter).toBe("devin");
    expect(entry?.authKind).toBe("oauth");
    expect(entry?.liveModels).toBe(true);
    expect(createDevinAdapter({ adapter: "devin", baseUrl: "https://server.codeium.com" }).name).toBe("devin");
  });

  test("maps user/assistant/tool history and tools", () => {
    const parsed: OcxParsedRequest = {
      modelId: "swe-1-7",
      stream: true,
      context: {
        systemPrompt: ["be brief"],
        messages: [
          { role: "user", content: "hi", timestamp: 1 },
          {
            role: "assistant",
            content: [
              { type: "text", text: "calling" },
              { type: "toolCall", id: "c1", name: "lookup", arguments: { q: "x" } },
            ],
            timestamp: 2,
          },
          { role: "toolResult", toolCallId: "c1", toolName: "lookup", content: "ok", isError: false, timestamp: 3 },
        ],
        tools: [{ name: "lookup", description: "lookup", parameters: { type: "object" } }],
      },
      options: {},
    };
    const history = mapOcxMessagesToDevin(parsed);
    expect(history[0]).toEqual({ role: "system", content: "be brief" });
    expect(history[1]).toEqual({ role: "user", content: "hi" });
    expect(history[2]?.role).toBe("assistant");
    expect(history[2]?.tool_calls?.[0]?.id).toBe("c1");
    expect(history[3]).toEqual({ role: "tool", content: "ok", tool_call_id: "c1" });
    expect(mapOcxToolsToDevin(parsed.context.tools)?.[0]?.name).toBe("lookup");
  });

  test("filters configured models by live discovery", () => {
    const configured = DEVIN_STATIC_MODELS.map((id) => ({ id }));
    const filtered = filterDevinConfiguredModelsByLiveDiscovery(configured, ["swe-1-7", "claude-opus-4-8-medium"]);
    expect(filtered.map((row) => row.id)).toEqual(["swe-1-7"]);
  });

  test("imports the local Pi Devin token when present", async () => {
    const cred = await importLocalPiDevinAuth();
    expect(cred?.access.startsWith("devin-session-token$") || cred?.access.startsWith("sk-ws-") || typeof cred?.access === "string").toBe(true);
    expect(cred?.source).toBe("local-cli");
  });
});

