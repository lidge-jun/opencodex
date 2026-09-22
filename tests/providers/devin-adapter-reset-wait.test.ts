/**
 * The Devin adapter pins maxWaitMs to 0 when it calls the stated-reset retry
 * helper, so an admitted HTTP turn never holds shared capacity while sleeping
 * out a provider 429. The helper-level tests cannot see this: they pass their
 * own maxWaitMs. This file drives the real adapter end to end and asserts the
 * refusal surfaces without a replay — a mock.module spy would also work, but a
 * module mock registered at file scope leaks into every sibling test file Bun
 * loads into the same process.
 *
 * Removing the adapter's maxWaitMs: 0 fails both tests fast: the helper would
 * sleep out the stated window, the 5s abort signal cancels that sleep, and the
 * turn ends in the 499 client-closed error instead of the provider's refusal.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevinAdapter } from "../../src/adapters/devin";
import { parseCatalogBuffer, setCachedCatalogForTests } from "../../src/adapters/devin/cloud-direct/catalog";
import { encodeMessage, encodeString, encodeVarintField } from "../../src/adapters/devin/cloud-direct/wire";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import type { AdapterEvent } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const apiKey = "ocx-devin-reset-wait-fixture";
const host = "https://server.codeium.com";
const CHAT_URL = `${host}/exa.api_server_pb.ApiServerService/GetChatMessage`;
let home = "";
const previousHome = process.env.OPENCODEX_HOME;
const previousFetch = globalThis.fetch;
let chatPosts = 0;

function seed(): void {
  const buffer = Buffer.concat([encodeMessage(1, Buffer.concat([
    encodeString(1, "swe-2-high"),
    encodeString(22, "swe-2-high"),
    encodeVarintField(18, 262_000),
    encodeVarintField(4, 0),
  ]))]);
  setCachedCatalogForTests(parseCatalogBuffer(buffer, apiKey, host));
}

// A Connect-RPC stream whose only frame is an end-stream trailer carrying the
// provider's stated-reset refusal: flags 0x02, big-endian length, JSON body.
function refusalResponse(message: string): Response {
  const trailer = Buffer.from(JSON.stringify({
    error: { code: "resource_exhausted", message },
  }), "utf8");
  const frame = Buffer.alloc(5 + trailer.length);
  frame[0] = 0x02;
  frame.writeUInt32BE(trailer.length, 1);
  trailer.copy(frame, 5);
  return new Response(frame, {
    status: 200,
    headers: { "Content-Type": "application/connect+proto" },
  });
}

function stubTransport(message: string): void {
  chatPosts = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    // The seeded catalog cache means GetChatMessage is the only RPC this turn
    // performs; count it anyway so a replay is visible as a second send.
    if (String(input).startsWith(CHAT_URL)) chatPosts += 1;
    return refusalResponse(message);
  }) as typeof fetch;
}

async function runOneTurn(): Promise<AdapterEvent[]> {
  const adapter = createDevinAdapter({ adapter: "devin", apiKey, baseUrl: host });
  const events: AdapterEvent[] = [];
  await adapter.runTurn!({
    modelId: "swe-2-high",
    stream: true,
    context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    options: {},
  }, {
    headers: new Headers(),
    translatorBudget: createTranslatorBudget(),
    abortSignal: AbortSignal.timeout(5_000),
  }, event => { events.push(event); });
  return events;
}

describe("devin adapter stated-reset wait", () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-devin-reset-wait-"));
    process.env.OPENCODEX_HOME = home;
    seed();
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
    setCachedCatalogForTests(null);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  });

  test("a stated reset beyond the allowance surfaces instead of holding the turn", async () => {
    stubTransport("Your limit will reset in 21 minutes");

    const events = await runOneTurn();

    // The provider's refusal is preserved verbatim — including the stated
    // reset text — instead of the turn sleeping inside the shared slot.
    const error = events.find((event): event is Extract<AdapterEvent, { type: "error" }> => event.type === "error");
    expect(error?.message).toContain("reset in 21 minutes");
    expect(events.some(event => event.type === "done")).toBe(false);
    expect(chatPosts).toBe(1);
  });

  test("even a one-second stated reset is not waited out", async () => {
    stubTransport("Your limit will reset in 1 second");

    const events = await runOneTurn();

    const error = events.find((event): event is Extract<AdapterEvent, { type: "error" }> => event.type === "error");
    expect(error?.message).toContain("reset in 1 second");
    expect(chatPosts).toBe(1);
  });
});
