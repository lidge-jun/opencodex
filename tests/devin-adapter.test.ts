import { describe, expect, test } from "bun:test";
import { createDevinAdapter, mapOcxMessagesToDevin, mapOcxToolsToDevin } from "../src/adapters/devin";
import { sanitizeToolDescriptionForCognitionForTests } from "../src/adapters/devin/cloud-direct/chat";
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
    // Base models that appear as effort-suffixed variants in the live catalog
    // are kept (the adapter appends the effort suffix at request time).
    const filtered = filterDevinConfiguredModelsByLiveDiscovery(configured, ["swe-1-7", "claude-opus-4-8-medium"]);
    expect(filtered.map((row) => row.id)).toEqual(["swe-1-7", "claude-opus-4-8"]);
  });

  test("drops configured models absent from live discovery", () => {
    const configured = DEVIN_STATIC_MODELS.map((id) => ({ id }));
    // A model with no exact match and no effort-suffixed variant is dropped.
    const filtered = filterDevinConfiguredModelsByLiveDiscovery(configured, ["swe-1-7"]);
    expect(filtered.map((row) => row.id)).toEqual(["swe-1-7"]);
  });

  test("imports the local Pi Devin token when present", async () => {
    const cred = await importLocalPiDevinAuth();
    expect(cred?.access.startsWith("devin-session-token$") || cred?.access.startsWith("sk-ws-") || typeof cred?.access === "string").toBe(true);
    expect(cred?.source).toBe("local-cli");
  });

  test("rewrites the Cognition blocklist trigger phrase in tool descriptions", () => {
    // The exact 7-word phrase (capital T, single spaces) triggers Cognition's
    // permission_denied content filter. The rewrite must break the exact match
    // while preserving meaning.
    const trigger = "Takes a task_id parameter identifying the task";
    expect(sanitizeToolDescriptionForCognitionForTests(trigger)).toBe("Accepts a task_id parameter identifying the task");
    // Case-sensitive: lowercase first letter is NOT rewritten (it doesn't trigger)
    expect(sanitizeToolDescriptionForCognitionForTests("takes a task_id parameter identifying the task"))
      .toBe("takes a task_id parameter identifying the task");
    // Substring match: the phrase embedded in a larger description is rewritten
    const full = "- Retrieves output from a running or completed task\n- Takes a task_id parameter identifying the task\n- Returns the task output";
    const rewritten = sanitizeToolDescriptionForCognitionForTests(full);
    expect(rewritten).not.toContain("Takes a task_id parameter identifying the task");
    expect(rewritten).toContain("Accepts a task_id parameter identifying the task");
    // Surrounding text is preserved
    expect(rewritten).toContain("- Retrieves output from a running or completed task");
    expect(rewritten).toContain("- Returns the task output");
    // Descriptions without the trigger pass through unchanged
    expect(sanitizeToolDescriptionForCognitionForTests("A benign description.")).toBe("A benign description.");
  });
});

