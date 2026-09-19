import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCursorAdapter } from "../../src/adapters/cursor";
import {
  clearCursorOverflowRemintForTests,
  clearCursorThreadContinuityForTests,
} from "../../src/adapters/cursor/thread-continuity";
import type { CursorTransport } from "../../src/adapters/cursor/transport";
import { createKiroAdapter } from "../../src/adapters/kiro";
import { createDevinAdapter, DEVIN_API_SERVER } from "../../src/adapters/devin";
import { setCachedCatalogForTests } from "../../src/adapters/devin/cloud-direct/catalog";
import { resetKiroThrottleStateForTests } from "../../src/adapters/kiro-retry";
import type { AdapterFetchContext } from "../../src/adapters/base";
import { encodeMessage } from "../../src/lib/eventstream-decoder";
import { createRequestExecutionBudget, type RequestExecutionBudgetPolicy } from "../../src/lib/request-execution-budget";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * The two legs where the inner-retry mechanism reaches the adapters that needed it.
 *
 * tests/adapters/adapter-inner-send-budget.test.ts pins the mechanism itself against the retry
 * helpers. It cannot see whether anything SUPPLIES them: a budget that no caller forwards bounds
 * nothing, and an observer the Kiro text fallback never receives leaves that leg uncountable.
 * Both are asserted here through the production adapters, from the same entry points the
 * Responses path uses.
 */

/** Exactly `sends` physical sends allowed, with no reserve and no alternate target. */
function budgetOf(sends: number) {
  const policy: RequestExecutionBudgetPolicy = {
    maxTotalModelSends: sends,
    baseSendAllowance: sends,
    finalRecoveryAllowance: 0,
    maxAlternateTargetSends: 0,
    maxTargetTransitions: 0,
  };
  return createRequestExecutionBudget(policy, "lr-adapter-wiring-test");
}

const realFetch = globalThis.fetch;

const cursorProvider = {
  adapter: "cursor",
  baseUrl: "https://api2.cursor.sh",
  apiKey: "cursor-token",
} as unknown as OcxProviderConfig;

function cursorTurn(): OcxParsedRequest {
  return {
    modelId: "cursor/auto",
    stream: false,
    options: {},
    context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
  } as unknown as OcxParsedRequest;
}

/** Fails before the run request is committed, which is the only class Cursor retries. */
function uncommittedResetTransport(): CursorTransport {
  return {
    async *run() {
      throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    },
    writeClient() {},
    close() {},
    requestCommitted: () => false,
  };
}

describe("Cursor runTurn and the request send budget", () => {
  afterEach(() => {
    clearCursorThreadContinuityForTests();
    clearCursorOverflowRemintForTests();
  });

  test("a turn carrying an exhausted budget stops before it opens another transport", async () => {
    const budget = budgetOf(2);
    let transports = 0;
    const adapter = createCursorAdapter(cursorProvider, {
      createTransport: () => {
        transports += 1;
        return uncommittedResetTransport();
      },
    });
    const events: AdapterEvent[] = [];

    await adapter.runTurn?.(
      cursorTurn(),
      { headers: new Headers(), translatorBudget: createTestTranslatorBudget(), sendBudget: budget },
      event => events.push(event),
    );

    // Two turns went upstream, and the third — the one the adapter's own ladder would have run —
    // never built a transport. That third send is what the request cap could not see before:
    // Cursor re-sends the WHOLE turn, and the outer counter charged one entry for all of them.
    expect(transports).toBe(2);
    expect(budget.used).toBe(2);
    expect(events.at(-1)?.type).toBe("error");
  });

  test("a turn without a budget keeps the adapter's own attempt count", async () => {
    let transports = 0;
    const adapter = createCursorAdapter(cursorProvider, {
      createTransport: () => {
        transports += 1;
        return uncommittedResetTransport();
      },
    });
    const events: AdapterEvent[] = [];

    await adapter.runTurn?.(
      cursorTurn(),
      { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
      event => events.push(event),
    );

    // Absent means unlimited. Every runTurn caller that predates this field, and every adapter
    // unit test that builds a bare meta, behaves exactly as it did.
    expect(transports).toBe(3);
    expect(events.at(-1)?.type).toBe("error");
  });
});

describe("Devin runTurn execution wiring", () => {
  test("forwards the provider executor, shared budget, and physical-send observer", async () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const previousJwtFlag = process.env.OPENCODEX_DEVIN_SEND_USER_JWT;
    const home = mkdtempSync(join(tmpdir(), "devin-send-wiring-"));
    process.env.OPENCODEX_HOME = home;
    delete process.env.OPENCODEX_DEVIN_SEND_USER_JWT;
    const apiKey = "devin-test-key";
    setCachedCatalogForTests({
      apiKey,
      host: DEVIN_API_SERVER,
      fetchedAt: Date.now(),
      byUid: new Map([["swe-2", { modelUid: "swe-2", label: "SWE-2", disabled: false }]]),
    });
    const budget = budgetOf(1);
    const observed: Array<{ ordinal: number; recovery?: string }> = [];
    const urls: string[] = [];
    const events: AdapterEvent[] = [];
    const adapter = createDevinAdapter({
      adapter: "devin", baseUrl: DEVIN_API_SERVER, apiKey,
    } as unknown as OcxProviderConfig);

    try {
      await adapter.runTurn?.(
        {
          modelId: "swe-2", stream: true, options: {},
          context: { messages: [{ role: "user", content: "hi" }] },
        } as unknown as OcxParsedRequest,
        {
          headers: new Headers(),
          translatorBudget: createTestTranslatorBudget(),
          sendBudget: budget,
          providerFetch: (async input => {
            urls.push(String(input));
            return new Response("busy", { status: 500 });
          }) as typeof fetch,
          onPhysicalSend: send => { observed.push(send); },
        },
        event => events.push(event),
      );
    } finally {
      setCachedCatalogForTests(null);
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      if (previousJwtFlag === undefined) delete process.env.OPENCODEX_DEVIN_SEND_USER_JWT;
      else process.env.OPENCODEX_DEVIN_SEND_USER_JWT = previousJwtFlag;
      removeTreeWithRetry(home);
    }

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("GetChatMessage");
    expect(budget.used).toBe(1);
    expect(observed).toEqual([{ ordinal: 1 }]);
    expect(events.at(-1)).toMatchObject({ type: "error", status: 500 });
  });

  test("a first send the budget refuses makes no request and reports no send", async () => {
    // The accounting defect this pins: the caller used to log this turn's first send before the
    // adapter ran, so an allowance already spent by earlier recovery produced a logged send the
    // wire never made. Nothing is dispatched here, so nothing may be observed either.
    const previousHome = process.env.OPENCODEX_HOME;
    const previousJwtFlag = process.env.OPENCODEX_DEVIN_SEND_USER_JWT;
    const home = mkdtempSync(join(tmpdir(), "devin-send-denied-"));
    process.env.OPENCODEX_HOME = home;
    delete process.env.OPENCODEX_DEVIN_SEND_USER_JWT;
    const apiKey = "devin-denied-key";
    setCachedCatalogForTests({
      apiKey,
      host: DEVIN_API_SERVER,
      fetchedAt: Date.now(),
      byUid: new Map([["swe-2", { modelUid: "swe-2", label: "SWE-2", disabled: false }]]),
    });
    // Nothing left to spend: the same state an earlier combo fan-out or empty-response recovery
    // leaves behind before this turn starts.
    const budget = budgetOf(0);
    const observed: Array<{ ordinal: number; recovery?: string }> = [];
    const urls: string[] = [];
    const events: AdapterEvent[] = [];
    const adapter = createDevinAdapter({
      adapter: "devin", baseUrl: DEVIN_API_SERVER, apiKey,
    } as unknown as OcxProviderConfig);

    try {
      await adapter.runTurn?.(
        {
          modelId: "swe-2", stream: true, options: {},
          context: { messages: [{ role: "user", content: "hi" }] },
        } as unknown as OcxParsedRequest,
        {
          headers: new Headers(),
          translatorBudget: createTestTranslatorBudget(),
          sendBudget: budget,
          providerFetch: (async input => {
            urls.push(String(input));
            return new Response("busy", { status: 500 });
          }) as typeof fetch,
          onPhysicalSend: send => { observed.push(send); },
        },
        event => events.push(event),
      ).catch(() => { /* the refusal escapes the adapter for the caller to map */ });
    } finally {
      setCachedCatalogForTests(null);
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      if (previousJwtFlag === undefined) delete process.env.OPENCODEX_DEVIN_SEND_USER_JWT;
      else process.env.OPENCODEX_DEVIN_SEND_USER_JWT = previousJwtFlag;
      removeTreeWithRetry(home);
    }

    expect(urls.filter(url => url.includes("GetChatMessage"))).toHaveLength(0);
    expect(observed).toEqual([]);
    expect(budget.used).toBe(0);
  });
});

const kiroProvider = {
  adapter: "kiro",
  baseUrl: "https://runtime.us-east-1.kiro.dev",
  authMode: "oauth",
  apiKey: "tok-123",
} as unknown as OcxProviderConfig;

const bashTool = { name: "bash", description: "Run a shell command", parameters: { type: "object" } };
const enc = new TextEncoder();

function inferredEventType(event: Record<string, unknown>): string {
  if ("conversationId" in event) return "messageMetadataEvent";
  return "assistantResponseEvent";
}

function eventFrame(event: Record<string, unknown>): Uint8Array {
  return encodeMessage(
    { ":message-type": "event", ":event-type": inferredEventType(event) },
    enc.encode(JSON.stringify(event)),
  );
}

function streamOf(...frames: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < frames.length) controller.enqueue(frames[index++]!);
      else controller.close();
    },
  });
}

describe("the Kiro text-fallback leg reports its physical sends", () => {
  const origHome = process.env.HOME;
  const origLocalAppData = process.env.LOCALAPPDATA;
  const origUserProfile = process.env.USERPROFILE;
  const origRegion = process.env.KIRO_REGION;
  const origApiRegion = process.env.KIRO_API_REGION;
  const origArn = process.env.KIRO_PROFILE_ARN;
  const origCredsFile = process.env.KIRO_CREDS_FILE;
  const origCredentialsFile = process.env.KIRO_CREDENTIALS_FILE;
  const origOcxHome = process.env.OPENCODEX_HOME;
  let tmp: string;

  beforeEach(() => {
    // Empty HOME so no local Kiro credential store is read, and a deterministic region.
    tmp = mkdtempSync(join(tmpdir(), "kiro-send-wiring-"));
    process.env.HOME = tmp;
    process.env.LOCALAPPDATA = join(tmp, "AppData", "Local");
    process.env.USERPROFILE = tmp;
    process.env.OPENCODEX_HOME = tmp;
    process.env.KIRO_REGION = "us-east-1";
    delete process.env.KIRO_API_REGION;
    delete process.env.KIRO_PROFILE_ARN;
    delete process.env.KIRO_CREDS_FILE;
    delete process.env.KIRO_CREDENTIALS_FILE;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    resetKiroThrottleStateForTests();
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    if (origLocalAppData === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = origLocalAppData;
    if (origUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = origUserProfile;
    if (origRegion === undefined) delete process.env.KIRO_REGION; else process.env.KIRO_REGION = origRegion;
    if (origApiRegion === undefined) delete process.env.KIRO_API_REGION; else process.env.KIRO_API_REGION = origApiRegion;
    if (origArn === undefined) delete process.env.KIRO_PROFILE_ARN; else process.env.KIRO_PROFILE_ARN = origArn;
    if (origCredsFile === undefined) delete process.env.KIRO_CREDS_FILE; else process.env.KIRO_CREDS_FILE = origCredsFile;
    if (origCredentialsFile === undefined) delete process.env.KIRO_CREDENTIALS_FILE; else process.env.KIRO_CREDENTIALS_FILE = origCredentialsFile;
    if (origOcxHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = origOcxHome;
    removeTreeWithRetry(tmp);
  });

  test("a progress-only turn's rebuild is counted as the second send of the same request", async () => {
    const observed: Array<{ ordinal: number; recovery?: string }> = [];
    const translatorBudget = createTestTranslatorBudget();
    const adapter = createKiroAdapter(kiroProvider);
    const request = await adapter.buildRequest(
      {
        modelId: "claude-sonnet-4.5",
        stream: true,
        options: {},
        context: { messages: [{ role: "user", content: "do it" }], tools: [bashTool] },
      } as unknown as OcxParsedRequest,
      { headers: new Headers(), translatorBudget },
    );

    const bodies: string[] = [];
    globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
      bodies.push(String(init?.body ?? ""));
      return bodies.length === 1
        // Progress with no final answer: the condition that makes the adapter rebuild the turn.
        ? new Response(streamOf(
            eventFrame({ content: "I am checking." }),
            eventFrame({ conversationId: "returned-conversation-42" }),
          ))
        : new Response(streamOf(eventFrame({ content: "Final from fallback." })));
    }) as unknown as typeof fetch;

    const ctx: AdapterFetchContext = {
      timeoutMs: 5_000,
      onPhysicalSend: send => { observed.push(send); },
    };
    const first = await adapter.fetchResponse!(request, ctx);
    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(first, translatorBudget)) events.push(event);

    // Two real HTTP requests, and now two observations. The rebuild used to build its own fetch
    // context and forward no observer at all, so the second one was invisible: the turn reported
    // a single send however many it made, and no regression could pin the count.
    expect(bodies).toHaveLength(2);
    expect(observed.map(send => send.ordinal)).toEqual([1, 2]);
    // Ordinal 2, not a second ordinal 1. A caller that already recorded the entry send drops
    // ordinal 1, so a raw per-call ordinal would have dropped the rebuild's only send.
    expect(observed[1]?.recovery).toBe("empty-completion");
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
  });

  test("a fetch context without an observer leaves the rebuild exactly as it was", async () => {
    const translatorBudget = createTestTranslatorBudget();
    const adapter = createKiroAdapter(kiroProvider);
    const request = await adapter.buildRequest(
      {
        modelId: "claude-sonnet-4.5",
        stream: true,
        options: {},
        context: { messages: [{ role: "user", content: "do it" }], tools: [bashTool] },
      } as unknown as OcxParsedRequest,
      { headers: new Headers(), translatorBudget },
    );

    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return fetches === 1
        ? new Response(streamOf(
            eventFrame({ content: "I am checking." }),
            eventFrame({ conversationId: "returned-conversation-7" }),
          ))
        : new Response(streamOf(eventFrame({ content: "Final from fallback." })));
    }) as unknown as typeof fetch;

    const first = await adapter.fetchResponse!(request, { timeoutMs: 5_000 });
    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(first, translatorBudget)) events.push(event);

    expect(fetches).toBe(2);
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
  });
});
