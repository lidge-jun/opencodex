import { describe, expect, test } from "bun:test";
import {
  CURSOR_STATIC_MODELS,
  CURSOR_ULTRA_1M_MODEL_IDS,
  cursorUltraBaseModelId,
  filterCursorConfiguredModelsByLiveDiscovery,
} from "../src/adapters/cursor/discovery";
import { createCursorRequest } from "../src/adapters/cursor/request-builder";
import { encodeCursorRunRequest } from "../src/adapters/cursor/protobuf-request";
import { fromBinary } from "@bufbuild/protobuf";
import { AgentClientMessageSchema, type AgentRunRequest } from "../src/adapters/cursor/gen/agent_pb";
import type { OcxParsedRequest } from "../src/types/request";

function decodeRunRequest(bytes: Uint8Array): AgentRunRequest {
  const msg = fromBinary(AgentClientMessageSchema, bytes);
  if (msg.message.case !== "runRequest") throw new Error("expected runRequest");
  return msg.message.value;
}

function parsedFor(modelId: string, reasoning?: string): OcxParsedRequest {
  return {
    modelId,
    context: { systemPrompt: [], messages: [{ role: "user", content: "hi" }] },
    options: reasoning ? { reasoning } : {},
  } as OcxParsedRequest;
}

describe("cursor ultra (-1m / Max Mode) toggle (devlog 260826 070)", () => {
  // Umbrella merge (devlog 260828_cursor_umbrella_catalog): the synthetic
  // kimi-k3-1m picker row folded into the kimi-k3 base row (1M context,
  // maxModeVerified). The alias stays routable; the separate row is gone.
  test("kimi-k3 base row carries the 1M context; the synthetic -1m row is folded in", () => {
    const row = CURSOR_STATIC_MODELS.find(model => model.id === "kimi-k3");
    expect(row).toBeDefined();
    expect(row?.contextWindow).toBe(1_000_000);
    expect(row?.supportsReasoningEffort).toBe(true);
    expect(CURSOR_STATIC_MODELS.some(model => model.id === "kimi-k3-1m")).toBe(false);
  });

  test("ultra marker resolves to its wire base and never leaks", () => {
    expect(cursorUltraBaseModelId("cursor/kimi-k3-1m")).toBe("kimi-k3");
    expect(cursorUltraBaseModelId("kimi-k3-1m")).toBe("kimi-k3");
    expect(cursorUltraBaseModelId("kimi-k3")).toBeUndefined();
    expect(cursorUltraBaseModelId("claude-4-sonnet-1m")).toBeUndefined();
  });

  test("kimi-k3-1m + max resolves to wire kimi-k3-max with maxMode on the request", () => {
    const request = createCursorRequest(parsedFor("cursor/kimi-k3-1m", "max"));
    expect(request.modelId).toBe("kimi-k3-max");
    expect(request.maxMode).toBe(true);
  });

  test("plain kimi-k3 stays maxMode-off", () => {
    const request = createCursorRequest(parsedFor("cursor/kimi-k3", "max"));
    expect(request.modelId).toBe("kimi-k3-max");
    expect(request.maxMode).toBeUndefined();
  });

  test("wire raises maxMode on BOTH RequestedModel and ModelDetails", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "kimi-k3-max",
      maxMode: true,
      conversationId: "c1",
      system: [],
      messages: [{ role: "user", content: "hi" }],
    });
    const decoded = decodeRunRequest(bytes);
    expect(decoded.requestedModel?.maxMode).toBe(true);
    expect(decoded.requestedModel?.modelId).toBe("kimi-k3-max");
    expect(decoded.modelDetails?.maxMode).toBe(true);
  });

  test("non-ultra requests keep maxMode=false wire behavior", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "kimi-k3-max",
      conversationId: "c1",
      system: [],
      messages: [{ role: "user", content: "hi" }],
    });
    const decoded = decodeRunRequest(bytes);
    expect(decoded.requestedModel).toBeUndefined();
    // ModelDetails.maxMode is proto-optional; absent (undefined) means off.
    expect(decoded.modelDetails?.maxMode ?? false).toBe(false);
  });

  test("account filter admits the synthetic row through its base availability", () => {
    const configured = [{ id: "kimi-k3-1m" }, { id: "kimi-k3" }];
    const live = ["kimi-k3-high", "kimi-k3-max"];
    const filtered = filterCursorConfiguredModelsByLiveDiscovery(configured, live);
    expect(filtered.map(model => model.id)).toEqual(["kimi-k3-1m", "kimi-k3"]);
  });

  test("ultra id set stays narrow and every entry rides its base's static row", () => {
    for (const id of CURSOR_ULTRA_1M_MODEL_IDS) {
      const base = id.slice(0, -"-1m".length);
      expect(CURSOR_STATIC_MODELS.some(model => model.id === base)).toBe(true);
    }
  });
});
