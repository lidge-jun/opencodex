import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "../src/adapters/base";
import { saveConfig } from "../src/config";
import { clearKeyCooldowns } from "../src/providers/key-failover";
import { reasoningReplayKeyCredentialIdentity } from "../src/responses/reasoning-replay-cache";
import {
  clearResponseStateForTests,
  previousResponseProviderState,
} from "../src/responses/state";
import type {
  AdapterEvent,
  OcxConfig,
  OcxParsedRequest,
  OcxProviderConfig,
} from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

interface BuildObservation {
  key: string;
  continuation?: string;
}

let builds: BuildObservation[] = [];

function eventsForPhase(phase: string): AdapterEvent[] {
  if (phase === "seed") {
    return [
      { type: "text_delta", text: "seeded" },
      {
        type: "done",
        stopReason: "end_turn",
        providerState: { kiro: { conversationId: "private-a" } },
      },
    ];
  }
  if (phase === "plan") {
    return [
      { type: "text_delta", text: "I will modify the file now." },
      {
        type: "done",
        stopReason: "end_turn",
        providerState: { kiro: { conversationId: "private-a-plan" } },
      },
    ];
  }
  if (phase === "rotated") {
    return [
      { type: "text_delta", text: "completed on the rotated key" },
      {
        type: "done",
        stopReason: "end_turn",
        providerState: { kiro: { conversationId: "private-b" } },
      },
    ];
  }
  if (phase === "follow") {
    return [
      { type: "text_delta", text: "continued on the rotated key" },
      {
        type: "done",
        stopReason: "end_turn",
        providerState: { kiro: { conversationId: "private-b-next" } },
      },
    ];
  }
  throw new Error(`unexpected test phase: ${phase}`);
}

const actualResolver = await import("../src/server/adapter-resolve");
const actualResolveAdapter = actualResolver.resolveAdapter;

mock.module("../src/server/adapter-resolve", () => ({
  ...actualResolver,
  resolveAdapter(provider: OcxProviderConfig, cacheRetention?: "none" | "short" | "long") {
    if (provider.adapter !== "test-terminal-owned") {
      return actualResolveAdapter(provider, cacheRetention);
    }
    const key = provider.apiKey ?? "";
    const adapter: ProviderAdapter = {
      // The terminal guard is enabled for Anthropic adapters. The transport is otherwise a
      // narrow test double so the test can emit provider-private state deterministically.
      name: "anthropic",
      buildRequest(parsed: OcxParsedRequest) {
        const continuation = parsed._providerContinuation?.kiro?.conversationId;
        builds.push({ key, ...(continuation ? { continuation } : {}) });
        return {
          url: "https://owned-terminal.test/v1/messages",
          method: "POST",
          headers: { authorization: `Bearer ${key}` },
          body: "{}",
        };
      },
      async *parseStream(response: Response): AsyncGenerator<AdapterEvent> {
        yield* eventsForPhase(response.headers.get("x-test-phase") ?? "");
      },
      async parseResponse(response: Response): Promise<AdapterEvent[]> {
        return eventsForPhase(response.headers.get("x-test-phase") ?? "");
      },
    };
    return adapter;
  },
}));

const { handleResponses } = await import("../src/server/responses");

describe("terminal continuation provider-owner rotation", () => {
  let originalFetch: typeof fetch;
  let previousHome: string | undefined;
  let testHome = "";

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    previousHome = process.env.OPENCODEX_HOME;
    testHome = mkdtempSync(join(tmpdir(), "ocx-terminal-owner-"));
    process.env.OPENCODEX_HOME = testHome;
    builds = [];
    clearKeyCooldowns();
    clearResponseStateForTests();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    clearKeyCooldowns();
    clearResponseStateForTests();
    removeTreeWithRetry(testHome);
  });

  test("429 rotation fences inherited state and persists the rotated owner", async () => {
    const keyA = "key-alpha-000111222333";
    const keyB = "key-beta-444555666777";
    const config: OcxConfig = {
      port: 0,
      defaultProvider: "owned",
      providers: {
        owned: {
          adapter: "test-terminal-owned",
          baseUrl: "https://owned-terminal.test/v1",
          authMode: "key",
          apiKey: keyA,
          apiKeyPool: [
            { id: "k1", key: keyA, addedAt: 1 },
            { id: "k2", key: keyB, addedAt: 2 },
          ],
        },
      },
    } as OcxConfig;
    const keyAIdentity = reasoningReplayKeyCredentialIdentity({ apiKey: keyA });
    saveConfig(config);

    const phases = ["seed", "plan", "rate-limit", "rotated", "follow"];
    const seenAuthorization: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      seenAuthorization.push(new Headers(init?.headers).get("authorization") ?? "");
      const phase = phases.shift();
      if (!phase) throw new Error("unexpected extra upstream request");
      if (phase === "rate-limit") {
        return Response.json(
          { error: { message: "rotate" } },
          { status: 429, headers: { "retry-after": "30" } },
        );
      }
      return new Response("", { headers: { "x-test-phase": phase } });
    }) as typeof fetch;

    const post = (body: Record<string, unknown>) => handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      config,
      { model: "", provider: "" },
    );

    const seed = await post({
      model: "owned/model",
      input: "seed",
      stream: false,
      store: true,
    });
    expect(seed.status).toBe(200);
    const seedJson = await seed.json() as { id: string };
    expect(previousResponseProviderState(seedJson.id)).toMatchObject({
      __ocxOwner: { credentialIdentity: keyAIdentity },
      kiro: { conversationId: "private-a" },
    });

    const rotated = await post({
      model: "owned/model",
      previous_response_id: seedJson.id,
      input: "Please modify the file now",
      stream: false,
      store: true,
      tools: [{
        type: "function",
        name: "read_file",
        description: "read a file",
        parameters: { type: "object" },
      }],
    });
    expect(rotated.status).toBe(200);
    const rotatedJson = await rotated.json() as { id: string };
    const keyBIdentity = reasoningReplayKeyCredentialIdentity(config.providers.owned!);
    expect(keyBIdentity).toBeDefined();
    expect(keyBIdentity).not.toBe(keyAIdentity);
    expect(previousResponseProviderState(rotatedJson.id)).toMatchObject({
      __ocxOwner: { credentialIdentity: keyBIdentity },
      kiro: { conversationId: "private-b" },
    });

    const follow = await post({
      model: "owned/model",
      previous_response_id: rotatedJson.id,
      input: "follow up",
      stream: false,
      store: true,
    });
    expect(follow.status).toBe(200);
    const followJson = await follow.json() as { id: string };
    expect(previousResponseProviderState(followJson.id)).toMatchObject({
      __ocxOwner: { credentialIdentity: keyBIdentity },
      kiro: { conversationId: "private-b-next" },
    });

    expect(seenAuthorization).toEqual([
      `Bearer ${keyA}`,
      `Bearer ${keyA}`,
      `Bearer ${keyA}`,
      `Bearer ${keyB}`,
      `Bearer ${keyB}`,
    ]);
    expect(builds).toEqual([
      { key: keyA },
      { key: keyA, continuation: "private-a" },
      { key: keyA, continuation: "private-a" },
      { key: keyB },
      { key: keyB, continuation: "private-b" },
    ]);
    expect(phases).toEqual([]);
  });
});
