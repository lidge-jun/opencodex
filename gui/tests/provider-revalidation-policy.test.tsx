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

const PROVIDERS = ["anthropic", "cursor", "kimi"];

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
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
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
