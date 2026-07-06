import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../src/adapters/openai-responses";
import { selectForwardHeaders } from "../src/server/ws-bridge";

const forwardProvider = { adapter: "openai-responses", baseUrl: "https://chat.openai.com/backend-api/codex", authMode: "forward" as const };

describe("passthrough token override", () => {
  test("buildRequest uses original auth when no override", () => {
    const adapter = createResponsesPassthroughAdapter(forwardProvider);
    const headers = new Headers({ authorization: "Bearer original", "chatgpt-account-id": "main_acc" });
    const req = adapter.buildRequest({ modelId: "gpt-5.3", input: [], _rawBody: {} }, { headers });
    expect(req.headers["authorization"]).toBe("Bearer original");
    expect(req.headers["chatgpt-account-id"]).toBe("main_acc");
  });

  test("buildRequest replaces auth when _codexAccountOverride present", () => {
    const override = { accessToken: "pool_token", chatgptAccountId: "pool_acc" };
    const provider = { ...forwardProvider, _codexAccountOverride: override } as typeof forwardProvider;
    const adapter = createResponsesPassthroughAdapter(provider);
    const headers = new Headers({ authorization: "Bearer original", "chatgpt-account-id": "main_acc" });
    const req = adapter.buildRequest({ modelId: "gpt-5.3", input: [], _rawBody: {} }, { headers });
    expect(req.headers["authorization"]).toBe("Bearer pool_token");
    expect(req.headers["chatgpt-account-id"]).toBe("pool_acc");
  });

  test("buildRequest rejects pool-required provider before copying inbound auth", () => {
    const provider = { ...forwardProvider, _codexAccountRequired: true } as typeof forwardProvider;
    const adapter = createResponsesPassthroughAdapter(provider);
    const headers = new Headers({ authorization: "Bearer original", "chatgpt-account-id": "main_acc" });
    expect(() => adapter.buildRequest({ modelId: "gpt-5.3", input: [], _rawBody: {} }, { headers }))
      .toThrow("Codex pool account auth is required");
  });

  test("selectForwardHeaders works without override (backward compat)", () => {
    const headers = new Headers({ authorization: "Bearer test", "chatgpt-account-id": "acc" });
    const selected = selectForwardHeaders(headers);
    expect(selected.get("authorization")).toBe("Bearer test");
    expect(selected.get("chatgpt-account-id")).toBe("acc");
  });

  test("selectForwardHeaders applies override after forwarding", () => {
    const headers = new Headers({ authorization: "Bearer original", "chatgpt-account-id": "main" });
    const selected = selectForwardHeaders(headers, { accessToken: "override_tk", chatgptAccountId: "override_acc" });
    expect(selected.get("authorization")).toBe("Bearer override_tk");
    expect(selected.get("chatgpt-account-id")).toBe("override_acc");
  });
});
