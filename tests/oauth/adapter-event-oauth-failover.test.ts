import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "../../src/adapters/base";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";
import { getAccountSet, getCredential, saveCredential, setActiveAccount } from "../../src/oauth/store";
import type { AdapterEvent, OcxConfig, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const actualResolver = await import("../../src/server/adapter-resolve");
const actualResolveAdapter = actualResolver.resolveAdapter;
let attempts: AdapterEvent[][] = [];
let attemptKeys: string[] = [];
let attemptProjects: Array<string | undefined> = [];
/** Set by the delivery test: an attempt that emits, then blocks before completing the turn. */
let slowAttempt: ((emit: (event: AdapterEvent) => void) => Promise<void>) | undefined;
let beforePhysicalSend: (() => Promise<void>) | undefined;
let physicalSends = 0;
const originalFetch = globalThis.fetch;

function fixtureAdapter(provider: OcxProviderConfig): ProviderAdapter {
  return {
    name: "cursor",
    buildRequest: () => ({ url: provider.baseUrl, method: "POST", headers: {}, body: "" }),
    async *parseStream() {
      yield { type: "error", message: "fixture uses runTurn" } as AdapterEvent;
    },
    async runTurn(_parsed, incoming, emit) {
      const index = attemptKeys.length;
      attemptKeys.push(provider.apiKey ?? "");
      attemptProjects.push(provider.project);
      const gate = beforePhysicalSend;
      beforePhysicalSend = undefined;
      await gate?.();
      for (let send = 0; send < physicalSends; send++) {
        await incoming.providerFetch!(provider.baseUrl, {
          method: "POST", headers: { Authorization: `Bearer ${provider.apiKey}` }, body: "{}",
        });
      }
      if (slowAttempt) return await slowAttempt(emit);
      for (const event of attempts[index] ?? []) emit(event);
    },
  };
}

mock.module("../../src/server/adapter-resolve", () => ({
  ...actualResolver,
  resolveAdapter(provider: OcxProviderConfig, cacheRetention?: "none" | "short" | "long") {
    if (provider.adapter === "cursor" || provider.googleMode === "cloud-code-assist") return fixtureAdapter(provider);
    return actualResolveAdapter(provider, cacheRetention);
  },
}));

const { handleResponses } = await import("../../src/server/responses");
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
  attemptProjects = [];
  slowAttempt = undefined;
  beforePhysicalSend = undefined;
  physicalSends = 0;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearGenericFailoverHealth();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});

describe("#2568 adapter-event OAuth failover", () => {
  test.each([false, true])("runTurn first physical send follows a changed selection (image loop=%s)", async imageLoop => {
    await seedAccounts(2);
    const accounts = getAccountSet("cursor")!.accounts;
    beforePhysicalSend = async () => { await setActiveAccount("cursor", accounts[0]!.id); };
    physicalSends = 1;
    slowAttempt = async emit => { emit({ type: "text_delta", text: "selected answer" }); emit({ type: "done" }); };
    const sent: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      sent.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response("{}");
    }) as typeof fetch;
    const cfg = config(false);
    if (imageLoop) {
      cfg.images = { bridgeEnabled: true };
      cfg.providers.xai = { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "key", apiKey: "synthetic-image-key" };
    }
    const req = imageLoop ? new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "cursor/model", input: "answer", stream: true, tools: [{ type: "image_generation" }] }),
    }) : request(true);
    const response = await handleResponses(req, cfg, { model: "", provider: "" });
    expect(await response.text()).toContain("selected answer");
    expect(sent).toEqual(["Bearer cursor-access-0"]);
  });

  test("an already started multi-message turn keeps its original credential", async () => {
    await seedAccounts(2);
    const accounts = getAccountSet("cursor")!.accounts;
    physicalSends = 2;
    slowAttempt = async emit => { emit({ type: "text_delta", text: "same turn" }); emit({ type: "done" }); };
    const sent: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      sent.push(new Headers(init?.headers).get("authorization") ?? "");
      if (sent.length === 1) await setActiveAccount("cursor", accounts[0]!.id);
      return new Response("{}");
    }) as typeof fetch;
    const response = await handleResponses(request(false), config(false), { model: "", provider: "" });
    expect(await response.text()).toContain("same turn");
    expect(sent).toEqual(["Bearer cursor-access-1", "Bearer cursor-access-1"]);
    expect(getCredential("cursor")?.access).toBe("cursor-access-0");
  });

  test("every CCA request pairs the persisted active account with its own project", async () => {
    for (const id of ["a", "b"]) await saveCredential("google-antigravity", {
      access: `ga-access-${id}`, refresh: `ga-refresh-${id}`, expires: Date.now() + 3_600_000,
      accountId: id, projectId: `project-${id}`,
    });
    const cfg = config();
    cfg.defaultProvider = "google-antigravity";
    cfg.providers = { "google-antigravity": { ...cfg.providers.cursor!, googleMode: "cloud-code-assist", project: "project-a" } };
    attempts = [
      [{ type: "text_delta", text: "first" }, { type: "done" }],
      [{ type: "text_delta", text: "second" }, { type: "done" }],
    ];
    for (let i = 0; i < 2; i++) {
      const req = new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "google-antigravity/model", input: "answer", stream: false }),
      });
      const res = await handleResponses(req, cfg, { model: "", provider: "" });
      const responseBody = await res.text();
      expect(res.status, responseBody).toBe(200);
    }
    expect(attemptKeys).toEqual(["ga-access-b", "ga-access-b"]);
    expect(attemptProjects).toEqual(["project-b", "project-b"]);
  });
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
      expect(getCredential("cursor")?.access).toBe("cursor-access-0");
    });
  }

  test("a newer manual choice wins a pending request's 429 proposal", async () => {
    await seedAccounts(3);
    const accounts = getAccountSet("cursor")!.accounts;
    slowAttempt = async emit => {
      if (attemptKeys.length === 1) {
        await setActiveAccount("cursor", accounts[1]!.id);
        emit({ type: "error", message: "Cursor rate limit exceeded: resource_exhausted" });
      } else {
        emit({ type: "text_delta", text: "manual choice answered" });
        emit({ type: "done" });
      }
    };
    const response = await handleResponses(request(false), config(false), { model: "", provider: "" });
    expect(await response.text()).toContain("manual choice answered");
    expect(attemptKeys).toEqual(["cursor-access-2", "cursor-access-1"]);
    expect(getCredential("cursor")?.access).toBe("cursor-access-1");
  });

  test("a single account is a strict no-op", async () => {
    await seedAccounts(1);
    attempts = [[{ type: "error", message: "Cursor rate limit exceeded: resource_exhausted" }]];

    const body = await (await handleResponses(request(true), config(), { model: "", provider: "" })).text();

    expect(attemptKeys).toEqual(["cursor-access-0"]);
    expect(body).toContain("rate_limit_exceeded");
  });

  test("an explicit opt-out no longer strands a 429 when a second account is stored", async () => {
    // Reversed deliberately. `enabled: false` used to keep pre-#2568d single-account behaviour
    // on a 429; it now governs only the proactive pre-dispatch preference. Stranding a rate
    // limit while a second logged-in account sits idle is a defect rather than a preference,
    // and the operator who wants one account expresses that by storing one account.
    await seedAccounts(2);
    attempts = [
      [{ type: "error", message: "Cursor rate limit exceeded: resource_exhausted" }],
      [{ type: "text", text: "ok" }],
    ];

    const response = await handleResponses(request(true), config(false), { model: "", provider: "" });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(attemptKeys).toEqual(["cursor-access-1", "cursor-access-0"]);
    expect(body).toContain("ok");
    expect(body).not.toContain("rate_limit_exceeded");
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
