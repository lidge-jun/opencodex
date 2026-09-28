import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevinAdapter } from "../../src/adapters/devin";
import { parseCatalogBuffer, setCachedCatalogForTests } from "../../src/adapters/devin/cloud-direct/catalog";
import { encodeMessage, encodeString, encodeVarintField, iterFields } from "../../src/adapters/devin/cloud-direct/wire";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildGetChatMessageRequestForTests,
  devinCacheIdentity,
  invalidateSessionIdentity,
} from "../../src/adapters/devin/cloud-direct/chat";

function buildRequest(overrides: Record<string, unknown> = {}): Buffer {
  return buildGetChatMessageRequestForTests({
    apiKey: "k",
    modelUid: "swe-2-high",
    messages: [{ role: "user", content: "hi" }],
    cascadeId: "cascade-1",
    sessionId: "session-1",
    requestId: 1n,
    triggerId: "trigger-1",
    ...overrides,
  } as never);
}

describe("prompt cache options on the wire", () => {
  // Reusing a session id is only half of prompt caching. Without this field the
  // server creates no cache entry and every turn re-reads the whole prefix.
  // Bytes: tag (13<<3)|2 = 0x6a, length 0x02, inner field 1 varint 1 = 08 01.
  const EXPECTED = Buffer.from([0x6a, 0x02, 0x08, 0x01]);

  test("the request carries PromptCacheOptions{EPHEMERAL}", () => {
    expect(buildRequest().includes(EXPECTED)).toBe(true);
  });

  test("it is sent even when the turn has no tools", () => {
    // CLIProxyAPIPlus appends it outside its tools gate, and the native client
    // caches the system prefix regardless of whether tools were declared.
    expect(buildRequest({ tools: [] }).includes(EXPECTED)).toBe(true);
    expect(buildRequest({ tools: undefined }).includes(EXPECTED)).toBe(true);
  });

  test("exactly one cache-options field is emitted", () => {
    const buf = buildRequest();
    let count = 0;
    for (let i = 0; i + EXPECTED.length <= buf.length; i += 1) {
      if (buf.subarray(i, i + EXPECTED.length).equals(EXPECTED)) count += 1;
    }
    expect(count).toBe(1);
  });
});

describe("devin cache identity", () => {
  test("the raw credential never becomes the cache key", () => {
    const apiKey = "devin-secret-token-value";
    const identity = devinCacheIdentity(apiKey, "https://server.example");
    expect(identity).not.toContain(apiKey);
    expect(identity).toMatch(/^[0-9a-f]{16}$/);
  });

  test("identity separates accounts and hosts", () => {
    const a = devinCacheIdentity("key-a", "https://h1");
    const b = devinCacheIdentity("key-b", "https://h1");
    const c = devinCacheIdentity("key-a", "https://h2");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  test("the same credential and host is stable across calls", () => {
    expect(devinCacheIdentity("key", "https://h")).toBe(devinCacheIdentity("key", "https://h"));
  });

  test("the host boundary cannot be forged by a crafted credential", () => {
    // The parts are joined with a separator that cannot appear in either half,
    // so "h" + key and host + "\x1fh" must not collide.
    expect(devinCacheIdentity("b", "a")).not.toBe(devinCacheIdentity("", "a\x1fb"));
  });
});

describe("session invalidation is scoped to one account", () => {
  test("invalidating an unknown identity is harmless", () => {
    expect(() => invalidateSessionIdentity(devinCacheIdentity("nobody", "https://h"))).not.toThrow();
  });

  test("the unsafe global clear is gone from the module surface", async () => {
    // A per-provider logout calling a global clear() would strip the session and
    // cascade of every other account mid-turn, which is why nothing ever called it.
    const mod = await import("../../src/adapters/devin/cloud-direct/chat");
    expect("clearSessionIds" in mod).toBe(false);
    expect(typeof mod.invalidateSessionIdentity).toBe("function");
  });
});


describe("one catalog read serves the cached chat path", () => {
  const apiKey = "ocx-devin-context-fixture";
  const host = "https://server.codeium.com";
  const previousHome = process.env.OPENCODEX_HOME;
  const previousJwt = process.env.OPENCODEX_DEVIN_SEND_USER_JWT;
  const previousFetch = globalThis.fetch;
  let home = "";
  let requests: Buffer[] = [];
  let urls: string[] = [];

  function frame(body: Buffer, flags = 0): Buffer {
    const header = Buffer.alloc(5);
    header[0] = flags;
    header.writeUInt32BE(body.length, 1);
    return Buffer.concat([header, body]);
  }
  function fields(buf: Buffer) {
    return new Map([...iterFields(buf)].map(field => [field.num, field]));
  }
  function seed(rows: Array<{ uid: string; window?: number; disabled?: boolean }>): void {
    const buffer = Buffer.concat(rows.map(row => encodeMessage(1, Buffer.concat([
      encodeString(1, row.uid),
      encodeString(22, row.uid),
      ...(row.window === undefined ? [] : [encodeVarintField(18, row.window)]),
      encodeVarintField(4, row.disabled ? 1 : 0),
    ]))));
    setCachedCatalogForTests(parseCatalogBuffer(buffer, apiKey, host));
  }
  async function run(
    modelId = "swe-2-high",
    provider: Partial<OcxProviderConfig> = {},
    options: OcxParsedRequest["options"] = {},
    signal?: AbortSignal,
  ): Promise<AdapterEvent[]> {
    const adapter = createDevinAdapter({ ...provider, adapter: "devin", apiKey, baseUrl: host });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!({
      modelId, stream: true,
      context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      options: { maxOutputTokens: 64, ...options },
    }, { headers: new Headers(), translatorBudget: createTranslatorBudget(), abortSignal: signal },
    event => { events.push(event); });
    return events;
  }
  function expectWire(uid = "swe-2-high"): void {
    expect(requests).toHaveLength(1);
    const outer = fields(requests[0]!);
    const completion = fields(outer.get(8)!.value as Buffer);
    // #3 is max_newlines, fixed; no context window reaches it.
    expect(completion.get(3)!.value).toBe(128_000n);
    expect(completion.get(2)!.value).toBe(64n);
    expect((outer.get(21)!.value as Buffer).toString()).toBe(uid);
    // A context fix must not remove prompt caching or replace the chosen model.
    expect(outer.has(13)).toBe(true);
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-devin-context-"));
    process.env.OPENCODEX_HOME = home;
    delete process.env.OPENCODEX_DEVIN_SEND_USER_JWT;
    requests = [];
    urls = [];
    setCachedCatalogForTests(null);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (!url.endsWith("/GetChatMessage")) return new Response("unavailable", { status: 503 });
      const framed = Buffer.from(await (init!.body as Blob).arrayBuffer());
      expect(framed[0]).toBe(0);
      expect(framed.readUInt32BE(1)).toBe(framed.length - 5);
      requests.push(framed.subarray(5));
      return new Response(Buffer.concat([
        frame(Buffer.concat([encodeString(3, "ok"), encodeVarintField(5, 2)])),
        frame(Buffer.from("{}"), 2),
      ]), { headers: { "content-type": "application/connect+proto" } });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
    setCachedCatalogForTests(null);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (previousJwt === undefined) delete process.env.OPENCODEX_DEVIN_SEND_USER_JWT;
    else process.env.OPENCODEX_DEVIN_SEND_USER_JWT = previousJwt;
    invalidateSessionIdentity(devinCacheIdentity(apiKey, host));
    removeTreeWithRetry(home);
  });

  test.each([262_000, 1_000_000])("a seeded catalog (window %i) serves the turn without a refetch", async window => {
    seed([{ uid: "swe-2-high", window }]);
    const events = await run();
    expect(events.some(event => event.type === "error")).toBe(false);
    expect(events).toContainEqual({ type: "text_delta", text: "ok" });
    expect(events.at(-1)?.type).toBe("done");
    expectWire();
    expect(urls).toHaveLength(1); // Seeded metadata stays cached through preflight.
  });

  test.each(["gpt-5-6-sol-high", "gpt-5-6-sol-high-1m"])("sends the exact variant %s", async uid => {
    seed([
      { uid: "gpt-5-6-sol-high", window: 200_000 },
      { uid: "gpt-5-6-sol-high-1m", window: 1_000_000 },
    ]);
    await run(uid);
    expectWire(uid);
  });

  test("resolves the final effort UID rather than the originally requested variant", async () => {
    seed([{ uid: "swe-2-medium", window: 240_000 }, { uid: "swe-2-high", window: 262_000 }]);
    await run("devin/swe-2-high", {}, { reasoning: "medium" });
    expectWire("swe-2-medium");
  });

  test("a failed catalog lookup is not retried within the turn", async () => {
    // No seed: the mocked endpoint 503s, so every uncached catalog read issues
    // a fetch (the user_jwt mint runs first and fails). The turn must make
    // exactly one metadata attempt - runTurn hands the result to UID
    // resolution and to the chat pre-flight.
    const events = await run("gpt-5-6-sol");
    expect(events).toContainEqual({ type: "text_delta", text: "ok" });
    expect(urls.filter(url => !url.endsWith("/GetChatMessage"))).toHaveLength(1);
    expect(urls.filter(url => url.endsWith("/GetChatMessage"))).toHaveLength(1);
  });

  test.each([true, false])("retains disabled/unlisted preflight rejection (%p)", async disabled => {
    seed([{ uid: disabled ? "swe-2-high" : "other-high", window: 262_000, disabled }]);
    const events = await run();
    expect(events.some(event => event.type === "error")).toBe(true);
    expect(requests).toHaveLength(0);
  });

  test("an already cancelled turn never fetches metadata or sends inference", async () => {
    const controller = new AbortController();
    controller.abort();
    const events = await run("swe-2-high", {}, {}, controller.signal);
    expect(events).toContainEqual({ type: "error", message: "client closed request", status: 499, retryable: false });
    expect(urls).toHaveLength(0);
  });
});
