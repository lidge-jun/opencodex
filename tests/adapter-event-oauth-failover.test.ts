import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "../src/adapters/base";
import { clearGenericFailoverHealth } from "../src/oauth/generic-account-failover";
import { saveCredential } from "../src/oauth/store";
import type { AdapterEvent, OcxConfig, OcxProviderConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const actualResolver = await import("../src/server/adapter-resolve");
const actualResolveAdapter = actualResolver.resolveAdapter;
let attempts: AdapterEvent[][] = [];
let attemptKeys: string[] = [];
/** Set by the delivery test: an attempt that emits, then blocks before completing the turn. */
let slowAttempt: ((emit: (event: AdapterEvent) => void) => Promise<void>) | undefined;

function fixtureAdapter(provider: OcxProviderConfig): ProviderAdapter {
  return {
    name: "cursor",
    buildRequest: () => ({ url: provider.baseUrl, method: "POST", headers: {}, body: "" }),
    async *parseStream() {
      yield { type: "error", message: "fixture uses runTurn" } as AdapterEvent;
    },
    async runTurn(_parsed, _incoming, emit) {
      const index = attemptKeys.length;
      attemptKeys.push(provider.apiKey ?? "");
      if (slowAttempt) return await slowAttempt(emit);
      for (const event of attempts[index] ?? []) emit(event);
    },
  };
}

mock.module("../src/server/adapter-resolve", () => ({
  ...actualResolver,
  resolveAdapter(provider: OcxProviderConfig, cacheRetention?: "none" | "short" | "long") {
    if (provider.adapter === "cursor") return fixtureAdapter(provider);
    return actualResolveAdapter(provider, cacheRetention);
  },
}));

const { handleResponses } = await import("../src/server/responses");
const originalHome = process.env.OPENCODEX_HOME;
let home = "";

/**
 * `enabled: undefined` is the case that matters after #2568d — the key absent entirely, which is
 * what every install that never edited its config looks like.
 */
function config(enabled?: boolean): OcxConfig {
  return {
    port: 0,
    defaultProvider: "cursor",
    providers: {
      cursor: {
        adapter: "cursor",
        baseUrl: "https://api2.cursor.sh",
        authMode: "oauth",
        models: ["model"],
      },
    },
    ...(enabled === undefined ? {} : { oauthAccountFailover: { enabled } }),
  } as OcxConfig;
}

function request(stream: boolean): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "cursor/model", input: "answer", stream }),
  });
}

async function seedAccounts(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await saveCredential("cursor", {
      access: `cursor-access-${i}`,
      refresh: `cursor-refresh-${i}`,
      expires: Date.now() + 3_600_000,
      accountId: `cursor-account-${i}`,
    }, { addAccount: true });
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-adapter-event-failover-"));
  process.env.OPENCODEX_HOME = home;
  clearGenericFailoverHealth();
  attempts = [];
  attemptKeys = [];
  slowAttempt = undefined;
});

afterEach(() => {
  clearGenericFailoverHealth();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});

describe("#2568 adapter-event OAuth failover", () => {
  for (const stream of [true, false]) {
    test(`${stream ? "streaming" : "non-streaming"} first-event 429 rotates and replays`, async () => {
      await seedAccounts(2);
      attempts = [
        [{ type: "error", message: "Cursor rate limit exceeded: resource_exhausted" }],
        [{ type: "text_delta", text: "alternate answer" }, { type: "done" }],
      ];

      const response = await handleResponses(request(stream), config(), { model: "", provider: "" });
      const body = await response.text();

      expect(attemptKeys).toEqual(["cursor-access-1", "cursor-access-0"]);
      expect(body).toContain("alternate answer");
      expect(body).not.toContain("Cursor rate limit exceeded");
    });
  }

  test("a single account is a strict no-op", async () => {
    await seedAccounts(1);
    attempts = [[{ type: "error", message: "Cursor rate limit exceeded: resource_exhausted" }]];

    const body = await (await handleResponses(request(true), config(), { model: "", provider: "" })).text();

    expect(attemptKeys).toEqual(["cursor-access-0"]);
    expect(body).toContain("rate_limit_exceeded");
  });

  test("an explicit opt-out keeps single-account behaviour with two accounts stored", async () => {
    // Presence is consent, but only when the operator has not already said no. Someone who wrote
    // `enabled: false` gets the pre-#2568d behaviour unchanged.
    await seedAccounts(2);
    attempts = [[{ type: "error", message: "Cursor rate limit exceeded: resource_exhausted" }]];

    const body = await (await handleResponses(request(true), config(false), { model: "", provider: "" })).text();

    expect(attemptKeys).toEqual(["cursor-access-1"]);
    expect(body).toContain("rate_limit_exceeded");
  });

  test("the first delta reaches the client before the turn completes", async () => {
    // Presence-driven activation puts every multi-account user behind preflightRunTurnFailover,
    // which holds events until the first meaningful one. Holding the FIRST DELTA would be a
    // silent time-to-first-token regression that a whole-body assertion cannot see, so this reads
    // the stream incrementally and refuses to wait for `done`.
    await seedAccounts(2);
    let releaseCompletion: (() => void) | undefined;
    const completionGate = new Promise<void>(resolve => { releaseCompletion = resolve; });
    slowAttempt = async emit => {
      emit({ type: "text_delta", text: "first token" });
      await completionGate;
      emit({ type: "done" });
    };

    const response = await handleResponses(request(true), config(), { model: "", provider: "" });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    // Bounded: if the delta never arrives before completion, this rejects instead of hanging the
    // suite, because the completion gate is still closed.
    while (!seen.includes("first token")) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("first delta withheld until completion")), 2_000)),
      ]);
      if (chunk.done) throw new Error("stream ended before the first delta");
      seen += decoder.decode(chunk.value, { stream: true });
    }

    expect(seen).toContain("first token");
    releaseCompletion?.();
    await reader.cancel();
  });

  test("Codex and Anthropic remain excluded", async () => {
    for (const providerName of ["openai", "anthropic"] as const) {
      attempts = [[{ type: "error", message: "Cursor rate limit exceeded: resource_exhausted" }]];
      attemptKeys = [];
      const excluded = config();
      excluded.defaultProvider = providerName;
      excluded.providers = { [providerName]: { ...excluded.providers.cursor! } };
      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: `${providerName}/model`, input: "answer", stream: true }),
      });
      const response = await handleResponses(req, excluded, { model: "", provider: "" });
      await response.text();
      expect(attemptKeys).toHaveLength(0);
      expect(response.status).toBe(401);
    }
  });

  test("an error after first output is terminal and is never replayed", async () => {
    await seedAccounts(2);
    attempts = [[
      { type: "text_delta", text: "already visible" },
      { type: "error", message: "Cursor rate limit exceeded: resource_exhausted" },
    ]];

    const body = await (await handleResponses(request(true), config(), { model: "", provider: "" })).text();

    expect(attemptKeys).toEqual(["cursor-access-1"]);
    expect(body).toContain("already visible");
    expect(body).toContain("rate_limit_exceeded");
  });
});
