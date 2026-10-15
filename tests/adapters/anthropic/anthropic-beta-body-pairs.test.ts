import { describe, expect, test } from "bun:test";
import { buildAnthropicMessagesPassthroughRequest } from "../../../src/adapters/anthropic/passthrough";
import { createAnthropicAdapter } from "../../../src/adapters/anthropic";
import { allowlistAnthropicBetas } from "../../../src/adapters/anthropic/beta-allowlist";
import { captureAnthropicClientIdentity } from "../../../src/adapters/anthropic/client-identity";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

const BINDING = "thinking-binding-controls-2026-08-01";
const CONTEXT = "context-management-2025-06-27";
const provider: OcxProviderConfig = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "key", apiKey: "fixture-key" };
const source = Object.freeze({
  model: "selector", max_tokens: 16, messages: [{ role: "user", content: "fixture" }],
  thinking: Object.freeze({ type: "adaptive", display: "summarized", block_binding: Object.freeze({ prefix_mismatch_behavior: "drop_block" }) }),
  context_management: Object.freeze({ edits: [{ type: "clear_tool_uses_20250919" }] }),
});
const observed = captureAnthropicClientIdentity(new Headers({
  "User-Agent": "claude-cli/2.1.296 (external, cli)", "X-App": "cli",
  "X-Claude-Code-Session-Id": "11111111-1111-4111-8111-111111111111",
  "X-Stainless-Lang": "js", "X-Stainless-Runtime": "node",
}));
const build = (overrides: Partial<OcxProviderConfig> = {}, callerAnthropicBeta?: string, clientIdentity = undefined as typeof observed) =>
  buildAnthropicMessagesPassthroughRequest({ ...provider, ...overrides }, "claude-haiku-5-5", source, undefined, { callerAnthropicBeta, clientIdentity });

describe("beta/body pairing (#7102)", () => {
  for (const authMode of ["key", "oauth"] as const) {
    test(`${authMode}: first-party generic client preserves binding with canonical beta`, () => {
      const built = build({ authMode }, ` ${BINDING.toUpperCase()},${BINDING} `);
      expect(new Headers(built.headers).get("anthropic-beta")?.split(",")).toContain(BINDING);
      expect(built.wireBody.thinking).toBe(source.thinking);
      expect(JSON.parse(built.body).thinking).toEqual(source.thinking);
      expect(built.droppedBetas).toBe(false);
    });
    test(`${authMode}: absent or oversized beta strips only the gated nested field`, () => {
      for (const header of [undefined, "", `${BINDING},${"x".repeat(2048)}`]) {
        const built = build({ authMode }, header);
        expect(built.wireBody.thinking).toEqual({ type: "adaptive", display: "summarized" });
        expect(built.wireBody.thinking).not.toBe(source.thinking);
        expect(JSON.parse(built.body).thinking).not.toHaveProperty("block_binding");
      }
      expect(source.thinking.block_binding.prefix_mismatch_behavior).toBe("drop_block");
    });
  }
  for (const baseUrl of ["https://compatible.example", "https://bedrock-runtime.us-east-1.amazonaws.com", "https://us-central1-aiplatform.googleapis.com", "http://api.anthropic.com", "https://api.anthropic.com.example"]) {
    test(`${baseUrl}: compatible destination strips both paired fields and caller betas`, () => {
      const built = build({ baseUrl }, `${BINDING},${CONTEXT}`, observed);
      expect(new Headers(built.headers).has("anthropic-beta")).toBe(false);
      expect(built.wireBody.thinking).not.toHaveProperty("block_binding");
      expect(built.wireBody).not.toHaveProperty("context_management");
      expect(built.droppedBetaNames).toEqual([BINDING, CONTEXT]);
      expect(built.droppedUnrecognizedBetas).toBe(0);
    });
  }
  test("context management and binding retain their distinct caller policies", () => {
    const generic = build({}, `${BINDING},${CONTEXT}`);
    expect(generic.wireBody.thinking).toBe(source.thinking);
    expect(generic.wireBody).not.toHaveProperty("context_management");
    const native = build({}, `${BINDING},${CONTEXT}`, observed);
    expect(native.wireBody.thinking).toBe(source.thinking);
    expect(native.wireBody.context_management).toBe(source.context_management);
    expect(build({}, CONTEXT, observed).wireBody.thinking).not.toHaveProperty("block_binding");
  });
  test("pairing follows the final operator header, case-insensitively", () => {
    const built = build({ headers: { "Anthropic-Beta": `${BINDING.toUpperCase()},${CONTEXT}` } });
    expect(built.wireBody.thinking).toBe(source.thinking);
    expect(built.wireBody.context_management).toBe(source.context_management);
    expect(built.headers).not.toHaveProperty("Anthropic-Beta");
  });
  test("a beta without the optional body field remains useful for transformation diagnostics", () => {
    const body = { ...source, thinking: { type: "adaptive" } };
    const built = buildAnthropicMessagesPassthroughRequest(provider, "m", body, undefined, { callerAnthropicBeta: BINDING });
    expect(built.wireBody.thinking).toEqual(body.thinking);
    expect(built.headers["anthropic-beta"]).toBe(BINDING);
  });
  test("binding does not forward with thinking modes that reject it", () => {
    for (const type of ["disabled", "between_tools"]) {
      const body = { ...source, thinking: { ...source.thinking, type } };
      const built = buildAnthropicMessagesPassthroughRequest(provider, "m", body, undefined, { callerAnthropicBeta: BINDING });
      expect(built.wireBody.thinking).toEqual({ type, display: "summarized" });
      expect(body.thinking).toHaveProperty("block_binding");
    }
  });
  test("enabled thinking retains the controls, unknown caller beta values stay unnamed", () => {
    const body = { ...source, thinking: { type: "enabled", budget_tokens: 1024, block_binding: source.thinking.block_binding } };
    const built = buildAnthropicMessagesPassthroughRequest(provider, "m", body, undefined, { callerAnthropicBeta: BINDING });
    expect(built.wireBody.thinking).toBe(body.thinking);
    expect(allowlistAnthropicBetas(`${BINDING},private-fixture-beta`, "compatible")).toMatchObject({ droppedNames: [BINDING], droppedUnrecognized: 1 });
  });
});

describe("translated Responses thinking isolation", () => {
  for (const authMode of ["key", "oauth"] as const) {
    test(`${authMode}: native body-only controls cannot leak into translated thinking`, async () => {
      const adapter = createAnthropicAdapter({ ...provider, authMode });
      const parsed = {
        modelId: "claude-haiku-5-5", stream: false,
        context: { messages: [{ role: "user", content: [{ type: "text", text: "fixture" }] }], tools: [] },
        options: { reasoning: "high", thinking: source.thinking, context_management: source.context_management },
      } as unknown as OcxParsedRequest;
      const built = await adapter.buildRequest(parsed);
      const body = JSON.parse(built.body as string);
      expect(body.thinking).toMatchObject({ type: "adaptive" });
      expect(body.thinking).not.toHaveProperty("block_binding");
      expect(body).not.toHaveProperty("context_management");
      expect(new Headers(built.headers).get("anthropic-beta") ?? "").not.toContain(BINDING);
    });
  }
});
