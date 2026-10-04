/**
 * The Devin adapter resolves its stated-reset wait allowance from
 * OPENCODEX_DEVIN_STATED_RESET_WAIT_MS and defaults to 0, so an admitted HTTP
 * turn never holds shared capacity while sleeping out a provider 429 unless
 * the operator explicitly opts in. The helper-level tests cannot see this:
 * they pass their own maxWaitMs. This file drives the real adapter end to end
 * and asserts the default refusal surfaces without a replay while an opted-in
 * allowance waits and replays — a mock.module spy would also work, but a
 * module mock registered at file scope leaks into every sibling test file Bun
 * loads into the same process.
 *
 * Dropping the adapter's wait resolution for the default case fails these
 * tests fast: the helper would sleep out the stated window, the 5s abort
 * signal cancels that sleep, and the turn ends in the 499 client-closed error
 * instead of the provider's refusal.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevinAdapter } from "../../src/adapters/devin";
import { parseCatalogBuffer, setCachedCatalogForTests } from "../../src/adapters/devin/cloud-direct/catalog";
import { encodeMessage, encodeString, encodeVarintField, iterFields } from "../../src/adapters/devin/cloud-direct/wire";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { saveCredential } from "../../src/oauth/store";
import type { AdapterEvent } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const apiKey = "ocx-devin-reset-wait-fixture";
const host = "https://server.codeium.com";
const CHAT_URL = `${host}/exa.api_server_pb.ApiServerService/GetChatMessage`;
let home = "";
const previousHome = process.env.OPENCODEX_HOME;
const previousFetch = globalThis.fetch;
const previousWait = process.env.OPENCODEX_DEVIN_STATED_RESET_WAIT_MS;
let chatPosts = 0;
let seenUrls: string[] = [];
let trajectories: string[] = [];

function seed(tenantHost = host): void {
  const buffer = Buffer.concat([encodeMessage(1, Buffer.concat([
    encodeString(1, "swe-2-high"),
    encodeString(22, "swe-2-high"),
    encodeVarintField(18, 262_000),
    encodeVarintField(4, 0),
  ]))]);
  setCachedCatalogForTests(parseCatalogBuffer(buffer, apiKey, tenantHost));
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
  seenUrls = [];
  trajectories = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // The seeded catalog cache means GetChatMessage is the only RPC this turn
    // performs; count it anyway so a replay is visible as a second send.
    seenUrls.push(String(input));
    if (String(input).endsWith(new URL(CHAT_URL).pathname)) {
      chatPosts += 1;
      const request = Buffer.from(await (init!.body as Blob).arrayBuffer()).subarray(5);
      const reference = [...iterFields(request)].find(field => field.num === 15)!.value as Buffer;
      trajectories.push(([...iterFields(reference)].find(field => field.num === 1)!.value as Buffer).toString());
    }
    return refusalResponse(message);
  }) as typeof fetch;
}

async function runOneTurn(abortSignal: AbortSignal = AbortSignal.timeout(5_000), comboAttempt = false, headers = new Headers()): Promise<AdapterEvent[]> {
  const adapter = createDevinAdapter({ adapter: "devin", apiKey, baseUrl: host });
  const events: AdapterEvent[] = [];
  await adapter.runTurn!({
    modelId: "swe-2-high",
    stream: true,
    context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    options: {},
  }, {
    headers,
    translatorBudget: createTranslatorBudget(),
    abortSignal,
    comboAttempt,
  }, event => { events.push(event); });
  return events;
}

describe("devin adapter stated-reset wait", () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-devin-reset-wait-"));
    process.env.OPENCODEX_HOME = home;
    delete process.env.OPENCODEX_DEVIN_STATED_RESET_WAIT_MS;
    seed();
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
    setCachedCatalogForTests(null);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (previousWait === undefined) delete process.env.OPENCODEX_DEVIN_STATED_RESET_WAIT_MS;
    else process.env.OPENCODEX_DEVIN_STATED_RESET_WAIT_MS = previousWait;
    removeTreeWithRetry(home);
  });

  test("a stated reset beyond the allowance surfaces instead of holding the turn", async () => {
    stubTransport(`Your limit will reset in 21 minutes; credential=${apiKey}`);

    const events = await runOneTurn();

    // Preserve reset timing without forwarding the provider's credential-reflecting text.
    const error = events.find((event): event is Extract<AdapterEvent, { type: "error" }> => event.type === "error");
    expect(error).toMatchObject({ status: 429, errorType: "rate_limit_error", code: "resource_exhausted" });
    expect(error?.message).toContain("retry after ~1260s");
    expect(JSON.stringify(events)).not.toContain(apiKey);
    expect(error?.message).not.toContain("Your limit");
    expect(events.some(event => event.type === "done")).toBe(false);
    expect(chatPosts).toBe(1);
  });

  test("even a one-second stated reset is not waited out", async () => {
    stubTransport("Your limit will reset in 1 second");

    const events = await runOneTurn();

    const error = events.find((event): event is Extract<AdapterEvent, { type: "error" }> => event.type === "error");
    expect(error?.message).toContain("retry after ~1s");
    expect(chatPosts).toBe(1);
  });

  test("an opted-in wait allowance sleeps out the stated reset and replays", async () => {
    process.env.OPENCODEX_DEVIN_STATED_RESET_WAIT_MS = "3000";
    stubTransport("Your limit will reset in 1 second");

    const headers = new Headers({ "session-id": crypto.randomUUID() });
    const events = await runOneTurn(AbortSignal.timeout(5_000), false, headers);

    expect(chatPosts).toBe(3);
    expect(events.some(event => event.type === "heartbeat" && event.preflightReady === true)).toBe(true);
    const error = events.find((event): event is Extract<AdapterEvent, { type: "error" }> => event.type === "error");
    expect(error).toMatchObject({ status: 429, errorType: "rate_limit_error", code: "resource_exhausted" });
    expect(error?.message).toContain("retry after ~1s");
    expect(events.some(event => event.type === "done")).toBe(false);
    expect(trajectories).toHaveLength(3);
    expect(new Set(trajectories).size).toBe(1);
    // Once retries finish, the next named turn reacquires the same retained id.
    await runOneTurn(AbortSignal.timeout(3_000), true, headers);
    expect(trajectories).toHaveLength(4);
    expect(trajectories[3]).toBe(trajectories[0]);
  });

  test("a combo child returns the stated reset immediately despite a standalone wait allowance", async () => {
    process.env.OPENCODEX_DEVIN_STATED_RESET_WAIT_MS = "3000";
    stubTransport("Your limit will reset in 1 second");

    const events = await runOneTurn(AbortSignal.timeout(500), true);

    expect(events.find(event => event.type === "error")).toMatchObject({
      type: "error", status: 429, errorType: "rate_limit_error", code: "resource_exhausted",
    });
    expect(events.some(event => event.type === "heartbeat" && event.preflightReady === true)).toBe(false);
    expect(chatPosts).toBe(1);
  });

  test("an invalid wait allowance fails closed without replay", async () => {
    process.env.OPENCODEX_DEVIN_STATED_RESET_WAIT_MS = "not-a-duration";
    stubTransport("Your limit will reset in 1 second");

    const events = await runOneTurn();

    expect(chatPosts).toBe(1);
    expect(events.some(event => event.type === "error")).toBe(true);
  });

  test("an alias-bound tenant refusal keeps one send and content-free reset timing", async () => {
    const tenantHost = "https://server.eu.windsurf.com";
    await saveCredential("devin-cli", {
      access: apiKey, refresh: apiKey, expires: Number.MAX_SAFE_INTEGER,
      source: "local-cli", apiBaseUrl: tenantHost,
    });
    seed(tenantHost);
    stubTransport(`Your limit will reset in 1 second; credential=${apiKey}`);

    const events = await runOneTurn();

    expect(seenUrls).toEqual([`${tenantHost}${new URL(CHAT_URL).pathname}`]);
    const error = events.find((event): event is Extract<AdapterEvent, { type: "error" }> => event.type === "error");
    expect(error).toMatchObject({ status: 429, code: "resource_exhausted" });
    expect(error?.message).toContain("retry after ~1s");
    expect(JSON.stringify(events)).not.toContain(apiKey);
    expect(chatPosts).toBe(1);
  });
});
