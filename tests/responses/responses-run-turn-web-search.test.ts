import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "../../src/adapters/base";
import type { AdapterEvent, OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";
import { saveCredential } from "../../src/oauth/store";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const resolver = await import("../../src/server/adapter-resolve");
const resolveAdapter = resolver.resolveAdapter;
let attempts: OcxParsedRequest[] = [];
let events: AdapterEvent[][] = [];
let onAttempt: ((index: number, parsed: OcxParsedRequest) => void | Promise<void>) | undefined;
let onPacingSlotWait: (() => void | Promise<void>) | undefined;
function fixture(provider: OcxProviderConfig): ProviderAdapter {
  return {
    name: "cursor",
    buildRequest: () => ({ url: provider.baseUrl, method: "POST", headers: {}, body: "" }),
    async *parseStream() { yield { type: "done" } as AdapterEvent; },
    async runTurn(parsed, _incoming, emit) {
      const index = attempts.length;
      attempts.push(structuredClone(parsed));
      for (const event of events[index] ?? []) emit(event);
      await onAttempt?.(index, parsed);
    },
  };
}
function fetchFixture(provider: OcxProviderConfig): ProviderAdapter {
  return {
    name: "fetchonly",
    buildRequest: () => ({ url: provider.baseUrl, method: "POST", headers: {}, body: "{}" }),
    fetchResponse: async () => new Response("{}", { status: 200 }),
    async *parseStream() {
      yield { type: "text_delta", text: "search-enabled answer" } as AdapterEvent;
      yield { type: "done" } as AdapterEvent;
    },
    async parseResponse() { return [{ type: "done" }] as AdapterEvent[]; },
  };
}
mock.module("../../src/server/adapter-resolve", () => ({ ...resolver,
  resolveAdapter: (provider: OcxProviderConfig, cache?: "none" | "short" | "long") =>
    provider.adapter === "cursor" ? fixture(provider)
      : provider.adapter === "fetchonly" ? fetchFixture(provider)
      : resolveAdapter(provider, cache),
}));
const pacing = await import("../../src/providers/request-pacing");
const originalWaitForSlot = pacing.waitForProviderRequestSlot;
mock.module("../../src/providers/request-pacing", () => ({ ...pacing,
  waitForProviderRequestSlot: async (...args: Parameters<typeof originalWaitForSlot>) => {
    await onPacingSlotWait?.();
    return originalWaitForSlot(...args);
  },
}));
const sidecarAuth = await import("../../src/server/responses/request-sidecar-auth");
const prepareResponsesSidecarAuth = sidecarAuth.prepareResponsesSidecarAuth;
let releasedFixtureProbe = false;
mock.module("../../src/server/responses/request-sidecar-auth", () => ({ ...sidecarAuth,
  prepareResponsesSidecarAuth: async (...args: Parameters<typeof sidecarAuth.prepareResponsesSidecarAuth>) => {
    if (args[0].req.headers.get("x-fixture-probe") !== "held") {
      return prepareResponsesSidecarAuth(...args);
    }
    return {
      routedCompaction: false,
      openAiSidecar: { releaseProbeLease: () => { releasedFixtureProbe = true; } },
    } as Awaited<ReturnType<typeof sidecarAuth.prepareResponsesSidecarAuth>>;
  },
}));
const { handleResponses } = await import("../../src/server/responses");
const originalHome = process.env.OPENCODEX_HOME;
let home = "";
let release: (() => void) | undefined;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ocx-runturn-search-"));
  process.env.OPENCODEX_HOME = home;
  release = acquireOwnedSpendHome();
  clearGenericFailoverHealth();
  attempts = [];
  onAttempt = undefined;
  onPacingSlotWait = undefined;
  for (let i = 0; i < 2; i++) await saveCredential("cursor", {
    access: `fixture-access-${i}`, refresh: `fixture-refresh-${i}`,
    expires: Date.now() + 3_600_000, accountId: `fixture-${i}`,
  });
});
afterEach(() => {
  release?.();
  clearGenericFailoverHealth();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});
async function run(stream: boolean, retry = false, media?: "image" | "video", search = true, comboAttempt = false) {
  const config = {
    port: 0, defaultProvider: "cursor", emptyCompletionRetry: retry,
    webSearchSidecar: { backend: "exa", exaApiKey: "fixture-search-key" },
    ...(media ? { images: { bridgeEnabled: media === "image", videoBridgeEnabled: media === "video" } } : {}),
    providers: {
      cursor: { adapter: "cursor", baseUrl: "https://api2.cursor.sh", authMode: "oauth", models: ["model"] },
      xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", apiKey: "fixture-xai-key", models: ["fixture"] },
    },
  } as OcxConfig;
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "cursor/model", input: "answer", stream,
      tools: [...(search ? [{ type: "web_search" }] : []), ...(media === "image" ? [{ type: "image_generation" }] : [])] }),
  }), config, { model: "", provider: "" }, { comboAttempt });
  return response.text();
}
for (const streaming of [true, false]) {
  test(`combo preflight permits the injected search tool (stream=${streaming})`, async () => {
    events = [[{ type: "tool_call_start", id: "search", name: "web_search" },
      { type: "tool_call_delta", arguments: '{"query":"fixture"}' }, { type: "tool_call_end" },
      { type: "error", message: "fixture terminal failure" }]];
    expect(await run(streaming, false, undefined, true, true)).toContain("fixture terminal failure");
    expect(attempts).toHaveLength(1);
  });
  for (const media of ["image", "video"] as const) {
    test(`search takes priority over ${media} bridge (stream=${streaming})`, async () => {
      events = [[{ type: "text_delta", text: "search-enabled answer" }, { type: "done" }]];
      expect(await run(streaming, false, media)).toContain("search-enabled answer");
      expect(attempts).toHaveLength(1);
      expect(attempts[0].context.tools?.some(t => t.webSearch)).toBe(true);
      // Hosted image tools are already normalized by the request parser;
      // video_gen, in contrast, is injected only by the media bridge.
      expect(attempts[0].context.tools?.some(t => t.name === "video_gen")).toBe(false);
    });
  }
  test(`translation budget bounds accumulated UTF-8 output (stream=${streaming})`, async () => {
    events = [Array.from({ length: 6 }, () => ({ type: "text_delta" as const, text: "中".repeat(2_000_000) }))];
    events[0].push({ type: "done" });
    const output = await run(streaming);
    expect(output).toContain("translation_buffer_limit");
    expect(attempts).toHaveLength(1);
  });
  test(`429 replay retains synthetic search and refreshes route scope (stream=${streaming})`, async () => {
    events = [[{ type: "error", status: 429, message: "Cursor rate limit exceeded: resource_exhausted" }],
      [{ type: "text_delta", text: "alternate answer" }, { type: "done" }]];
    expect(await run(streaming)).toContain("alternate answer");
    expect(attempts).toHaveLength(2);
    for (const attempt of attempts) expect(attempt.context.tools?.some(t => t.webSearch)).toBe(true);
    expect(attempts[1]._providerContinuationOwner?.credentialIdentity)
      .not.toBe(attempts[0]._providerContinuationOwner?.credentialIdentity);
  });
  test(`search request honors empty retry (stream=${streaming})`, async () => {
    events = [[{ type: "done" }], [{ type: "text_delta", text: "retried answer" }, { type: "done" }]];
    expect(await run(streaming, true)).toContain("retried answer");
    expect(attempts).toHaveLength(2);
    expect(attempts[1].context.tools?.some(t => t.webSearch)).toBe(true);
  });
}

test.each(["image", "video"] as const)("media-only %s bridge still injects its tool", async media => {
  events = [[{ type: "text_delta", text: "media answer" }, { type: "done" }]];
  expect(await run(true, false, media, false)).toContain("media answer");
  expect(attempts[0].context.tools?.some(t => t.name === `${media}_gen`)).toBe(true);
  expect(attempts[0].context.tools?.some(t => t.webSearch)).toBe(false);
});

test("releases a search probe when pre-dispatch validation rejects the request", async () => {
  releasedFixtureProbe = false;
  const config = {
    port: 0, defaultProvider: "cursor",
    webSearchSidecar: { backend: "exa", exaApiKey: "fixture-search-key" },
    providers: {
      cursor: { adapter: "cursor", baseUrl: "https://api2.cursor.sh", authMode: "oauth", models: ["model"] },
    },
  } as OcxConfig;
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json", "x-fixture-probe": "held" },
    body: JSON.stringify({ model: "cursor/model", input: [{
      type: "function_call_output", output: "fixture result",
    }], tools: [{ type: "web_search" }] }),
  }), config, { model: "", provider: "" });

  expect(response.status).toBe(400);
  expect(releasedFixtureProbe).toBe(true);
  expect(attempts).toHaveLength(0);
});

test("a streamed sidecar response keeps the search probe until the stream settles", async () => {
  releasedFixtureProbe = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    if (url.includes("exa")) {
      return new Response(JSON.stringify({ results: [{ title: "fixture", url: "https://fixture.test" }] }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(
      'event: response.completed\ndata: {"type":"response.completed","response":{"output":[]}}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const config = {
      port: 0, defaultProvider: "fetchonly",
      webSearchSidecar: { backend: "exa", exaApiKey: "fixture-search-key" },
      providers: {
        fetchonly: { adapter: "fetchonly", baseUrl: "https://fetchonly.test/v1", apiKey: "fixture-key", models: ["model"] },
      },
    } as OcxConfig;
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json", "x-fixture-probe": "held" },
      body: JSON.stringify({ model: "fetchonly/model", input: "search this", stream: true,
        tools: [{ type: "web_search" }] }),
    }), config, { model: "", provider: "" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("event-stream");
    expect(releasedFixtureProbe).toBe(false);
    await response.text();
    // The routed model answered without a web_search call, so no sidecar outcome
    // settled the lease — the stream's own completion hands the probe back.
    expect(releasedFixtureProbe).toBe(true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a cancelled streamed sidecar response releases the search probe", async () => {
  releasedFixtureProbe = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    'event: response.completed\ndata: {"type":"response.completed","response":{"output":[]}}\n\n',
    { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
  try {
    const config = {
      port: 0, defaultProvider: "fetchonly",
      webSearchSidecar: { backend: "exa", exaApiKey: "fixture-search-key" },
      providers: {
        fetchonly: { adapter: "fetchonly", baseUrl: "https://fetchonly.test/v1", apiKey: "fixture-key", models: ["model"] },
      },
    } as OcxConfig;
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json", "x-fixture-probe": "held" },
      body: JSON.stringify({ model: "fetchonly/model", input: "search this", stream: true,
        tools: [{ type: "web_search" }] }),
    }), config, { model: "", provider: "" });

    expect(response.status).toBe(200);
    expect(releasedFixtureProbe).toBe(false);
    // Client disconnect: the tracked stream's cancel path must settle the lease the same
    // way a completed stream does, or the probe stays held until process exit.
    await response.body!.cancel();
    expect(releasedFixtureProbe).toBe(true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a media-bridge stream releases the search probe when it settles", async () => {
  releasedFixtureProbe = false;
  events = [[{ type: "text_delta", text: "media answer" }, { type: "done" }]];
  const config = {
    port: 0, defaultProvider: "cursor",
    images: { bridgeEnabled: true },
    providers: {
      cursor: { adapter: "cursor", baseUrl: "https://api2.cursor.sh", authMode: "oauth", models: ["model"] },
    },
  } as OcxConfig;
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json", "x-fixture-probe": "held" },
    body: JSON.stringify({ model: "cursor/model", input: "draw a fixture", stream: true,
      tools: [{ type: "image_generation" }] }),
  }), config, { model: "", provider: "" });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("event-stream");
  expect(releasedFixtureProbe).toBe(false);
  await response.text();
  expect(releasedFixtureProbe).toBe(true);
});

// Streaming only: a first-event 429 replays the turn while the superseded
// attempt is still in-flight (the buffered path awaits it before collecting
// events, so the race cannot exist there). When that attempt finally returns,
// its copy-back must not restore the failed account's route state over the
// rotation's rebind.
test("superseded 429 attempt cannot restore stale route state", async () => {
  let releaseAttempt0!: () => void;
  const attempt0Gate = new Promise<void>(resolve => { releaseAttempt0 = resolve; });
  let gateReleasedByHook = false;
  onAttempt = async (index, parsed) => {
    if (index !== 0) return;
    // Bounded wait: a broken pacing hook must fail the test, not hang the file.
    await Promise.race([attempt0Gate, new Promise(r => setTimeout(r, 15_000))]);
    parsed._providerContinuationOwner = {
      version: 1, providerName: "cursor", providerDestinationIdentity: "stale",
      adapterName: "cursor", modelId: "model", credentialIdentity: "stale-superseded",
    };
  };
  // The replay's pacing-slot wait is the last hookable point before its
  // copy-in reads parsed. Releasing the superseded attempt here is not enough
  // on its own — its copy-back is still a few microtasks out — so the hook
  // yields a macrotask: attempt 0's runTurn return and copy-back settle before
  // the replay resumes and copies route state in.
  onPacingSlotWait = async () => {
    if (attempts.length < 1) return;
    gateReleasedByHook = true;
    releaseAttempt0();
    await new Promise(r => setTimeout(r, 0));
  };
  events = [
    [{ type: "error", status: 429, message: "Cursor rate limit exceeded: resource_exhausted" }],
    [{ type: "text_delta", text: "rotated answer" }, { type: "done" }],
  ];
  try {
    expect(await run(true)).toContain("rotated answer");
  } finally {
    onAttempt = undefined;
    onPacingSlotWait = undefined;
    releaseAttempt0();
  }
  expect(attempts).toHaveLength(2);
  expect(gateReleasedByHook).toBe(true);
  const owner = (parsed: OcxParsedRequest) => parsed._providerContinuationOwner?.credentialIdentity;
  expect(owner(attempts[1])).not.toBe(owner(attempts[0]));
  expect(owner(attempts[1])).not.toBe("stale-superseded");
});
