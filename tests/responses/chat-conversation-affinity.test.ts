import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleChatCompletions } from "../../src/server/chat-completions";
import type { OcxConfig } from "../../src/types";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// #3433 transport contract only: these client-assigned fixture IDs are not a capture of Hermes.
const originalFetch = globalThis.fetch;
const identityHeaders = ["session_id", "session-id", "thread-id", "x-codex-parent-thread-id"];
let isolated: IsolatedCodexHome;
let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  isolated = installIsolatedCodexHome("ocx-chat-identity-");
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-chat-identity-config-"));
  process.env.OPENCODEX_HOME = home;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  isolated.restore();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

interface Capture { headers: Headers; body: Record<string, unknown> }
function mockNativeWire(): Capture[] {
  const seen: Capture[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://chatgpt.com/backend-api/codex/responses");
    seen.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return Response.json({ id: "resp_chat_identity", object: "response", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11, input_tokens_details: { cached_tokens: 0 } } });
  }) as typeof fetch;
  return seen;
}

async function chat(headers: Record<string, string>, cacheKey: string | undefined, continued: boolean) {
  const token = fakeChatGptJwt({ chatgpt_account_id: "fixture-chat-caller", exp: Math.floor(Date.now() / 1000) + 86400 });
  const config = { defaultProvider: "openai", openaiProviderTierVersion: 2, providers: {
    openai: { adapter: "openai-responses", authMode: "forward", codexAccountMode: "direct",
      baseUrl: "https://chatgpt.com/backend-api/codex", models: ["gpt-5.6-luna"] },
  } } as OcxConfig;
  const messages = [{ role: "system", content: "A shared prefix is not a conversation identity." },
    { role: "user", content: "first turn" },
    ...(continued ? [{ role: "assistant", content: "first answer" }, { role: "user", content: "next turn" }] : [])];
  const req = new Request("http://localhost/v1/chat/completions", { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`,
      "chatgpt-account-id": "fixture-chat-caller", ...headers },
    body: JSON.stringify({ model: "openai/gpt-5.6-luna", messages, stream: false, reasoning_effort: "medium",
      ...(cacheKey === undefined ? {} : { prompt_cache_key: cacheKey }) }),
  });
  const response = await handleChatCompletions(req, config, { model: "", provider: "" });
  await response.text();
  expect(response.status).toBe(200);
}

describe("Chat conversation identity at canonical Responses outbound boundary", () => {
  for (const keyPresent of [false, true]) {
    for (const shape of ["underscore", "hyphen-pair"] as const) {
      test(`${shape}, key=${keyPresent}: A/A/B retains caller identity and independent request IDs`, async () => {
        const seen = mockNativeWire();
        const key = keyPresent ? "shared-cache-cohort" : undefined;
        for (const [index, conversation] of ["a", "a", "b"].entries()) {
          const identity: Record<string, string> = shape === "underscore"
            ? { session_id: `conversation-${conversation}` }
            : { "session-id": `session-${conversation}`, "thread-id": `thread-${conversation}` };
          await chat({ ...identity, "x-client-request-id": `request-${index}` }, key, index === 1);
          expect(seen).toHaveLength(index + 1);
          const wire = seen[index]!;
          for (const name of identityHeaders) expect(wire.headers.get(name)).toBe(identity[name] ?? null);
          expect(wire.headers.get("x-client-request-id")).toBe(`request-${index}`);
          expect(wire.body.prompt_cache_key).toBe(key);
          expect(Object.hasOwn(wire.body, "prompt_cache_key")).toBe(keyPresent);
          expect(wire.body.reasoning).toMatchObject({ effort: "medium" });
        }
        expect(JSON.stringify(seen[1]!.body.input).length).toBeGreaterThan(JSON.stringify(seen[0]!.body.input).length);
        expect(seen[0]!.body.input).toEqual(seen[2]!.body.input);
      });
    }

    test(`identity absent, key=${keyPresent}: no session is synthesized`, async () => {
      const seen = mockNativeWire();
      for (const continued of [false, true]) await chat({}, keyPresent ? "shared-cache-cohort" : undefined, continued);
      expect(seen).toHaveLength(2);
      for (const wire of seen) {
        for (const name of identityHeaders) expect(wire.headers.has(name)).toBe(false);
        expect(wire.body.prompt_cache_key).toBe(keyPresent ? "shared-cache-cohort" : undefined);
      }
    });
  }
});
