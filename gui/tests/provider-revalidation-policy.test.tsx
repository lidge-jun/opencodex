import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import Providers from "../src/pages/Providers";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";

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
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let quotaCalls: string[] = [];
let apiBase = "";
let apiBaseSequence = 0;
let configuredProviders: Record<string, Record<string, unknown>>;
let codexAccountReads = 0;
let codexAccountsForRead: (read: number) => unknown;
let codexAccountDelayMs = 0;

const PROVIDERS = ["anthropic", "cursor", "kimi"];
const OPENAI_PROVIDER = {
  adapter: "openai-responses",
  authMode: "forward",
  baseUrl: "https://chatgpt.com/backend-api/codex",
};

function codexMainAccounts(observed: boolean) {
  return {
    accounts: [{
      id: "__main__",
      email: "Codex App login",
      isMain: true,
      paused: false,
      priority: 0,
      hasCredential: true,
      authStatus: "authenticated",
      credentialSource: "codex-managed",
      ...(observed
        ? {
            plan: "pro",
            quota: {
              weeklyPercent: 5,
              weeklyResetAt: 1_788_369_220,
              updatedAt: 1_788_000_000,
            },
          }
        : { quota: null }),
    }],
    mode: "pool",
  };
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
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
  apiBase = `/provider-revalidation-${++apiBaseSequence}`;
  configuredProviders = Object.fromEntries(
    PROVIDERS.map(p => [p, { authMode: "oauth", hasApiKey: false }]),
  );
  codexAccountReads = 0;
  codexAccountDelayMs = 0;
  codexAccountsForRead = () => ({ accounts: [], mode: "single" });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string, init?: RequestInit) => {
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
        return ok({ activeAccountId: `${provider}-account-1`, accounts: [{ id: `${provider}-account-1` }] });
      }
      if (url.includes("/api/providers/keys")) return ok({ keys: [] });
      if (url.includes("/api/config")) {
        // `authMode: "oauth"` is what makes the page read account sets for these providers.
        // With an empty provider map no account read happens at all and the churn this test
        // exists to catch never occurs.
        return ok({ providers: configuredProviders });
      }
      if (url.includes("/api/selected-models")) return ok({ models: {} });
      if (url.includes("/api/usage")) return ok({ providers: [] });
      if (url.includes("/api/provider-presets")) return ok({ presets: [] });
      if (url.includes("/api/codex-auth/accounts")) {
        codexAccountReads += 1;
        if (codexAccountDelayMs > 0) {
          await new Promise(r => setTimeout(r, codexAccountDelayMs));
        }
        return ok(codexAccountsForRead(codexAccountReads));
      }
      if (url.includes("/api/codex-auth/active")) return ok({ activeCodexAccountId: null });
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
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mount(settleMs = 120) {
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><Providers apiBase={apiBase} /></LanguageProvider>);
  });
  // Account responses land across several microtask/macrotask turns.
  await act(async () => { await new Promise(r => setTimeout(r, settleMs)); });
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

test("a newly observed Codex main account revalidates the overview quota once", async () => {
  configuredProviders = { openai: OPENAI_PROVIDER };
  codexAccountsForRead = read => codexMainAccounts(read > 1);

  await mount();
  expect(quotaCalls.length).toBe(1);

  // The account controller retries a credentialed row whose observation has not landed
  // yet. Once that retry sees plan/quota, Overview must re-read its separate aggregate;
  // a second inference or a manual dashboard action must not be necessary.
  await act(async () => { await new Promise(r => setTimeout(r, 500)); });
  await act(async () => { await new Promise(r => setTimeout(r, 30)); });

  expect(codexAccountReads).toBeGreaterThanOrEqual(2);
  expect(quotaCalls.length).toBe(2);
  expect(quotaCalls.every(url => !url.includes("refresh=1"))).toBe(true);

  await act(async () => { await new Promise(r => setTimeout(r, 500)); });
  expect(quotaCalls.length).toBe(2);
});

test("a first observed Codex response closes the initial overview race", async () => {
  configuredProviders = { openai: OPENAI_PROVIDER };
  codexAccountDelayMs = 80;
  codexAccountsForRead = () => codexMainAccounts(true);

  await mount(10);
  expect(quotaCalls.length).toBe(1);
  await act(async () => { await new Promise(r => setTimeout(r, 120)); });
  await act(async () => { await new Promise(r => setTimeout(r, 30)); });

  expect(codexAccountReads).toBe(1);
  expect(quotaCalls.length).toBe(2);
  expect(quotaCalls.every(url => !url.includes("refresh=1"))).toBe(true);
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
