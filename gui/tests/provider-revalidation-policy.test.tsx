import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import Providers from "../src/pages/Providers";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests, pollBucketCountForTests } from "../src/client-resource";

/**
 * Quota revalidation policy.
 *
 * The derived `provider:activeAccountId` key looked stable but was not: on a cold load each
 * provider's account response fills in its own active id, so the joined string changed once
 * per provider and the shell re-read `/api/provider-quotas` every time. Measured on a live
 * instance before the fix: six reads inside 15ms.
 *
 * These tests pin the behaviour, not the source text — a source-level assertion passed
 * through the whole WP3 migration while four runtime defects went undetected.
 */

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let quotaCalls: string[] = [];

const PROVIDERS = ["anthropic", "cursor", "kimi"];

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)])) as typeof previousGlobals;
  clearClientResourceStoresForTests();
  testWindow = new Window({ url: "http://localhost/#providers" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  quotaCalls = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string) => {
      const url = String(input);
      const ok = (body: unknown) => ({
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      }) as unknown as Response;

      if (url.includes("/api/provider-quotas")) {
        quotaCalls.push(url);
        return ok({ reports: [] });
      }
      if (url.includes("/api/oauth/providers")) return ok({ providers: PROVIDERS });
      if (url.includes("/api/oauth/status")) return ok({ loggedIn: true });
      if (url.includes("/api/oauth/accounts")) {
        /*
         * Each provider answers with its OWN active id, and they land at staggered times.
         * Both halves matter: the derived key was a join over every provider's active id, so
         * it only churned because the entries filled in one at a time. Resolving them all in
         * the same turn would collapse the churn and hide the very regression under test.
         */
        const provider = new URL(url, "http://localhost").searchParams.get("provider") ?? "x";
        const delay = (PROVIDERS.indexOf(provider) + 1) * 15;
        await new Promise(r => setTimeout(r, delay));
        return ok({ activeAccountId: `${provider}-account-1`, accounts: [{ id: `${provider}-account-1`, quotaMode: "probe" }] });
      }
      if (url.includes("/api/providers/keys")) return ok({ keys: [] });
      if (url.includes("/api/config")) {
        // `authMode: "oauth"` is what makes the page read account sets for these providers.
        // With an empty provider map no account read happens at all and the churn this test
        // exists to catch never occurs.
        return ok({
          providers: Object.fromEntries(PROVIDERS.map(p => [p, { authMode: "oauth", hasApiKey: false }])),
        });
      }
      if (url.includes("/api/selected-models")) return ok({ models: {} });
      if (url.includes("/api/usage")) return ok({ providers: [] });
      if (url.includes("/api/provider-presets")) return ok({ presets: [] });
      if (url.includes("/api/codex-auth")) return ok({ accounts: [], mode: "single" });
      return ok({});
    },
  });

  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  clearClientResourceStoresForTests();
  for (const key of globals) {
    const descriptor = previousGlobals[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function mount() {
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><Providers apiBase="" /></LanguageProvider>);
  });
  // Account responses land across several microtask/macrotask turns.
  await act(async () => { await new Promise(r => setTimeout(r, 120)); });
}

test("account data arriving per provider does not re-read the quota endpoint", async () => {
  await mount();

  // One read for the whole cold load, no matter how many providers report an active id.
  expect(quotaCalls.length).toBe(1);
  // And the cold read must not force the server past its TTL.
  expect(quotaCalls[0]).not.toContain("refresh=1");
});

test("the cold read stays single even after every provider has settled", async () => {
  await mount();
  await act(async () => { await new Promise(r => setTimeout(r, 250)); });
  expect(quotaCalls.length).toBe(1);
});

// Guard the other half of the contract: the base account read still happens before the quota
// probe, so account controls paint without waiting on a slow provider usage endpoint. The
// plan originally proposed merging these two reads; that would have hidden the controls
// entirely whenever the quota probe was slow, which is the symptom this whole unit targets.
test("the cheap account read still precedes the quota enrichment for every provider", async () => {
  const order: string[] = [];
  const inner = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/oauth/accounts")) {
        order.push(url.includes("quota=1") ? "enrich" : "base");
      }
      return inner(input as never, init as never);
    },
  });

  await mount();
  await act(async () => { await new Promise(r => setTimeout(r, 250)); });

  expect(order.filter(kind => kind === "base").length).toBe(PROVIDERS.length);
  expect(order.filter(kind => kind === "enrich").length).toBe(PROVIDERS.length);
  // Every base read lands before the first enrichment read.
  expect(order.indexOf("enrich")).toBeGreaterThan(order.lastIndexOf("base") - 1);
  expect(order[0]).toBe("base");
});

for (const kind of ["oauth", "key", "codex"] as const) {
  test(`the real Providers page refresh selects ${kind} and awaits account plus report`, async () => {
    const name = kind === "codex" ? "openai" : `${kind}-fixture`;
    const seen: string[] = [];
    let finishReport!: (response: Response) => void;
    let finishAccounts!: (response: Response) => void;
    let reportStarted!: () => void;
    const reportReady = new Promise<void>(resolve => { reportStarted = resolve; });
    const accountBody = kind === "codex"
      ? { accounts: [{ id: "main", email: "fixture@example.test", isMain: true, priority: 0, hasCredential: true, quota: null }] }
      : kind === "oauth"
        ? { activeAccountId: "account", accounts: [{ id: "account", active: true, quotaMode: "probe" }] }
        : { keys: [{ id: "key", masked: "masked", active: true, quotaMode: "probe" }] };
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      seen.push(url.pathname + url.search);
      if (url.pathname === "/api/config") return Response.json({ port: 10100, defaultProvider: name, providers: {
        [name]: kind === "codex"
          ? { adapter: "openai-responses", authMode: "forward", codexAccountMode: "pool", baseUrl: "https://chatgpt.com/backend-api/codex" }
          : { adapter: "openai-chat", authMode: kind, hasApiKey: kind === "key", baseUrl: "https://fixture.test/v1" },
      } });
      if (url.pathname === "/api/oauth/providers") return Response.json({ providers: kind === "oauth" ? [name] : [] });
      if (url.pathname === "/api/oauth/status") return Response.json({ loggedIn: true });
      if (url.pathname === "/api/provider-quotas") {
        if (!url.searchParams.has("refresh")) return Response.json({ reports: [] });
        const result = new Promise<Response>(resolve => { finishReport = resolve; });
        reportStarted();
        return result;
      }
      if (url.pathname === "/api/oauth/accounts" || url.pathname === "/api/providers/keys"
        || (kind === "codex" && url.pathname === "/api/codex-auth/accounts")) {
        return url.searchParams.has("refresh")
          ? new Promise<Response>(resolve => { finishAccounts = resolve; }) : Response.json(accountBody);
      }
      if (url.pathname === "/api/codex-auth/accounts") return Response.json({ accounts: [] });
      if (url.pathname === "/api/codex-auth/active") return Response.json({ activeCodexAccountId: null, autoSwitchThreshold: 80, accountPoolStrategy: "round-robin", accountPoolStickyLimit: 1 });
      if (url.pathname === "/api/selected-models") return Response.json({ models: {} });
      if (url.pathname === "/api/usage") return Response.json({ providers: [], models: [] });
      if (url.pathname === "/api/provider-presets") return Response.json({ providers: [] });
      return Response.json({});
    } });
    await mount();
    const provider = container.querySelector<HTMLButtonElement>(".providers-workspace-rail-row");
    expect(provider).not.toBeNull();
    await act(async () => { provider!.click(); });
    const refresh = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find(button => button.textContent?.includes("Refresh quotas"));
    expect(refresh).toBeDefined();
    seen.length = 0;
    await act(async () => { refresh!.click(); });
    await act(async () => { await reportReady; });
    const expected = kind === "codex" ? "/api/codex-auth/accounts?refresh=1"
      : kind === "oauth" ? `/api/oauth/accounts?provider=${name}&quota=1&refresh=1`
        : `/api/providers/keys?name=${name}&quota=1&refresh=1`;
    expect(seen).toContain(expected);
    if (kind !== "oauth") expect(seen.some(path => path.startsWith("/api/oauth/accounts"))).toBe(false);
    if (kind === "oauth") expect(seen.some(path => path.startsWith("/api/providers/keys"))).toBe(false);
    expect(container.textContent).toContain("Refreshing...");
    await act(async () => { finishReport(Response.json({ reports: [] })); });
    expect(container.textContent).not.toContain("Quota check completed");
    expect(container.textContent).toContain("Refreshing...");
    await act(async () => { finishAccounts(Response.json(accountBody)); });
    expect(container.textContent).toContain("Quota check completed");
  });
}

for (const kind of ["oauth", "api-key"] as const) {
  test(`${kind} selection event updates the rendered active row without a poll tick or quota probe`, async () => {
    const name = kind === "oauth" ? "cursor" : "deepseek";
    let selected = "a";
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let streamSignal: AbortSignal | null | undefined;
    let subscriptions = 0;
    let rejectConnection = false;
    let cancelled = false;
    const reads: string[] = [];
    const encoder = new TextEncoder();
    const send = (event: string, data: unknown) => {
      const bytes = encoder.encode(`event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`);
      // Network chunks need not end on either a line or an event boundary.
      stream.enqueue(bytes.slice(0, 11));
      stream.enqueue(bytes.slice(11));
    };
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      reads.push(url.pathname + url.search);
      if (url.pathname === "/api/accounts/events") {
        subscriptions += 1;
        streamSignal = init?.signal;
        if (rejectConnection) return new Response(null, { status: 503 });
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { stream = controller; }, cancel() { cancelled = true; },
        }), { headers: { "Content-Type": "text/event-stream" } });
      }
      if (url.pathname === "/api/config") return Response.json({ port: 10100, defaultProvider: name, providers: {
        [name]: { adapter: "openai-chat", authMode: kind === "oauth" ? "oauth" : "key", hasApiKey: kind === "api-key", baseUrl: "https://fixture.test/v1" },
      } });
      if (url.pathname === "/api/oauth/providers") return Response.json({ providers: kind === "oauth" ? [name] : [] });
      if (url.pathname === "/api/oauth/status") return Response.json({ loggedIn: true });
      if (url.pathname === "/api/oauth/accounts" || url.pathname === "/api/providers/keys") {
        const rows = ["a", "b"].map(id => ({ id, alias: `Choice ${id.toUpperCase()}`, label: `Choice ${id.toUpperCase()}`, masked: id,
          active: selected === id, quotaMode: "probe", ...(url.searchParams.has("quota") ? {
            quota: { fiveHourPercent: id === "a" ? 30 : 11, updatedAt: 1_700_000_000_000 },
          } : {}),
        }));
        return Response.json({ activeAccountId: selected, activeId: selected, accounts: rows, keys: rows });
      }
      if (url.pathname === "/api/codex-auth/accounts") return Response.json({ accounts: [] });
      if (url.pathname === "/api/codex-auth/active") return Response.json({ activeCodexAccountId: null });
      if (url.pathname === "/api/provider-quotas") return Response.json({ reports: [] });
      if (url.pathname === "/api/selected-models") return Response.json({ models: {} });
      if (url.pathname === "/api/usage") return Response.json({ providers: [], models: [] });
      return Response.json({});
    } });
    await act(async () => { root = createRoot(container); root.render(<LanguageProvider><Providers apiBase="" /></LanguageProvider>); });
    await act(async () => { container.querySelector<HTMLButtonElement>(".providers-workspace-rail-row")!.click(); });
    const accountsTab = Array.from(container.querySelectorAll<HTMLButtonElement>("[role=tab]"))
      .find(button => /Accounts|Keys/.test(button.textContent ?? ""));
    expect(accountsTab).toBeDefined();
    await act(async () => { accountsTab!.click(); });
    expect(container.querySelector(".pwi-auth-acct--active")?.textContent).toContain("Choice A");
    expect(subscriptions).toBe(1);
    const quotaReads = () => reads.filter(path => path.includes("quota=1") || path.startsWith("/api/provider-quotas")).length;
    const initialQuotas = quotaReads();
    const initialReads = reads.length;
    await act(async () => { send("ready", { revision: 0 }); });
    expect(reads.length).toBeGreaterThan(initialReads);
    selected = "b";
    await act(async () => { send("account-selection", { provider: name, kind, revision: 1 }); });
    expect(container.querySelector(".pwi-auth-acct--active")?.textContent).toContain("Choice B");
    expect(container.querySelector(".pwi-auth-acct--active")?.textContent).not.toContain("Choice A");
    expect(quotaReads()).toBe(initialQuotas);
    expect(subscriptions).toBe(1);
    expect(pollBucketCountForTests()).toBe(1);
    const afterEvent = reads.length;
    await act(async () => {
      send("account-selection", { provider: name, kind, revision: 1 });
      send("account-selection", { provider: "unknown-provider", kind, revision: 2 });
    });
    expect(reads).toHaveLength(afterEvent);
    // Only the reconnect timeout advances. No 30-second scheduler tick or visibility wake.
    const retries = new Map<number, { run: () => void; delay: number }>();
    let timerId = 10_000;
    const setTimeoutBefore = testWindow.setTimeout.bind(testWindow);
    const clearTimeoutBefore = testWindow.clearTimeout.bind(testWindow);
    Object.defineProperty(testWindow, "setTimeout", { configurable: true, value: (run: () => void, delay: number) => {
      if (delay > 5_000) return setTimeoutBefore(run, delay);
      const id = ++timerId;
      retries.set(id, { run, delay });
      return id;
    } });
    Object.defineProperty(testWindow, "clearTimeout", { configurable: true, value: (id: number) => {
      if (!retries.delete(id)) clearTimeoutBefore(id);
    } });
    const retry = async (delay: number) => {
      expect(retries.size).toBe(1);
      const [id, pending] = [...retries][0];
      expect(pending.delay).toBe(delay);
      retries.delete(id);
      await act(async () => { pending.run(); });
    };
    await act(async () => { stream.close(); });
    selected = "a";
    await retry(250);
    expect(subscriptions).toBe(2);
    await act(async () => { send("ready", { revision: 0 }); });
    expect(container.querySelector(".pwi-auth-acct--active")?.textContent).toContain("Choice A");
    expect(quotaReads()).toBe(initialQuotas);

    await act(async () => { stream.error(new Error("connection interrupted")); });
    rejectConnection = true;
    await retry(500);
    expect(subscriptions).toBe(3);
    for (const delay of [1_000, 2_000, 4_000, 5_000]) await retry(delay);
    expect(subscriptions).toBe(7);
    rejectConnection = false;
    await retry(5_000);
    expect(subscriptions).toBe(8);
    selected = "b";
    await act(async () => { send("ready", { revision: 0 }); });
    expect(container.querySelector(".pwi-auth-acct--active")?.textContent).toContain("Choice B");
    expect(quotaReads()).toBe(initialQuotas);

    // Cleanup cancels scheduled retries, and a callback already dequeued cannot orphan a loop.
    await act(async () => { stream.close(); });
    expect(retries.size).toBe(1);
    const queuedRetry = [...retries.values()][0].run;
    await act(async () => { root!.unmount(); root = null; });
    expect(retries.size).toBe(0);
    await act(async () => { queuedRetry(); });
    expect(subscriptions).toBe(8);
    expect(streamSignal?.aborted).toBe(true);
    // Closed/error streams need no cancel callback; also prove cleanup of a live reader.
    await act(async () => {
      root = createRoot(container);
      root.render(<LanguageProvider><Providers apiBase="" /></LanguageProvider>);
    });
    expect(subscriptions).toBe(9);
    expect(streamSignal?.aborted).toBe(false);
    await act(async () => { root!.unmount(); root = null; });
    expect(streamSignal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
    expect(retries.size).toBe(0);
  });
}
