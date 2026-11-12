import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import Logs from "../src/pages/Logs";
import {
  clearBillingFixturesPricing,
  creditRow,
  installBillingFixturesPricing,
  legacyTokenRowWithoutBilling,
  mixedComboRow,
  staleCreditProvenanceRow,
  tokenPriorityRow,
} from "./helpers/logs-cost-billing-fixture";

/**
 * #8452 review — the Logs detail panel named token provenance against a credit charge.
 *
 * The amount is right; the attribution was not. A credit total printed the token catalog
 * key as its "Price source", and a Priority-floor token rate put `>=` over an exact charge.
 * These cases render rows built by the production `requestLogDto`, so the panel is asserted
 * against the shape the proxy actually serves rather than a hand-written estimate.
 */

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT", "ResizeObserver"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

function installLayoutStubs(win: Window): void {
  const proto = win.HTMLElement.prototype as unknown as HTMLElement;
  Object.defineProperty(proto, "clientHeight", { configurable: true, get() { return 800; } });
  Object.defineProperty(proto, "clientWidth", { configurable: true, get() { return 1200; } });
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get() { return 800; } });
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get() { return 1200; } });
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get() { return 800; } });
  Object.defineProperty(proto, "getBoundingClientRect", {
    configurable: true,
    value() {
      return { x: 0, y: 0, top: 0, left: 0, bottom: 800, right: 1200, width: 1200, height: 800, toJSON() { return this; } };
    },
  });
  class ResizeObserverStub {
    #cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) { this.#cb = cb; }
    observe(target: Element) {
      this.#cb(
        [{
          target,
          contentRect: { x: 0, y: 0, top: 0, left: 0, bottom: 800, right: 1200, width: 1200, height: 800, toJSON() { return this; } },
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
  Object.defineProperty(win, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#logs" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  installLayoutStubs(testWindow);
  jest.useFakeTimers({ now: 1_700_000_000_000 });
  clearClientResourceStoresForTests();
  installBillingFixturesPricing();
});

afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
  clearClientResourceStoresForTests();
  testWindow.close();
  clearBillingFixturesPricing();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

function mockLogs(rows: Record<string, unknown>[]) {
  globalThis.fetch = (async input => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    return Response.json({ logs: rows, generatedAt: 1_700_000_000_000, timeZone: "UTC" });
  }) as typeof fetch;
}

async function mountAndOpen(requestId: string) {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><Logs apiBase="http://localhost" /></LanguageProvider>);
  });
  await act(async () => { jest.advanceTimersByTime(0); await Promise.resolve(); });
  const row = [...container.querySelectorAll<HTMLTableRowElement>(".logs-table tbody tr")]
    .find(candidate => candidate.textContent?.includes(requestId));
  expect(row).toBeDefined();
  await act(async () => { row!.querySelector<HTMLButtonElement>(".log-detail-btn")!.click(); });
  return { root, container };
}

function costSection(): HTMLElement {
  const section = document.querySelector<HTMLElement>('[aria-labelledby="log-detail-cost"]');
  expect(section).not.toBeNull();
  return section!;
}

test("a credit charge names no token price key or source and no lower bound", async () => {
  mockLogs([creditRow("credit-only")]);
  const { root } = await mountAndOpen("credit-only");
  try {
    const section = costSection();
    const text = section.textContent ?? "";
    // The production row really does carry `estimate.price` (the resolved catalog key), which
    // is exactly why the panel has to suppress it: that key never priced this total.
    expect(text).toContain("Credit-priced total");
    expect(text).toContain("2 credits × $0.04 per credit");
    expect(text).not.toContain("Matched price key");
    expect(text).not.toContain("Price source");
    expect(text).not.toContain("grok-4.7");
    // Exact for the configured price, so no floor marker and no Priority caveat.
    expect(text).toContain("$0.0800");
    expect(text).not.toContain("≥");
    expect(text).not.toContain("known lower bound");
    // The token rate's caveats are not caveats about a credit charge.
    expect(text).not.toContain("Cache details were unavailable");
    expect(text).not.toContain("A verified expected list price was used");
  } finally { await act(async () => { root.unmount(); }); }
});

test("a token-priced Priority row keeps its key, source, and lower bound", async () => {
  mockLogs([tokenPriorityRow("token-priority")]);
  const { root } = await mountAndOpen("token-priority");
  try {
    const text = costSection().textContent ?? "";
    expect(text).toContain("Matched price key");
    expect(text).toContain("grok-4.7");
    expect(text).toContain("Price source");
    expect(text).toContain("Expected price overlay");
    expect(text).toContain("≥$1.2120");
    expect(text).toContain("known lower bound");
  } finally { await act(async () => { root.unmount(); }); }
});

test("a mixed combo attributes only the token leg, and the sum is not a floor", async () => {
  mockLogs([mixedComboRow("mixed-combo")]);
  const { root } = await mountAndOpen("mixed-combo");
  try {
    const section = costSection();
    const parentText = section.textContent ?? "";
    expect(parentText).toContain("Combined total (per-attempt basis)");
    // The parent's `price` is only the first attempt's key; it did not price the sum.
    expect(parentText).not.toContain("Matched price key");
    expect(parentText).not.toContain("Price source");
    // One leg is an exact credit charge, so the total is not a known floor.
    expect(parentText).toContain("$1.2900");
    expect(parentText).not.toContain("≥");

    const attempts = [...document.querySelectorAll<HTMLTableRowElement>(".log-detail-attempts tbody tr")];
    expect(attempts).toHaveLength(2);
    const [creditLeg, tokenLeg] = attempts.map(row => row.textContent ?? "");
    // The credit leg: exact charge, no token key, no floor.
    expect(creditLeg).toContain("$0.0780");
    expect(creditLeg).not.toContain("≥");
    expect(creditLeg).not.toContain("grok-4.7");
    expect(creditLeg).not.toContain("jawcode catalog");
    expect(creditLeg).not.toContain("Verified");
    // The token leg keeps its own provenance, because that is the rate it was charged.
    expect(tokenLeg).toContain("≥$1.2120");
    expect(tokenLeg).toContain("grok-4.7");
    expect(tokenLeg).toContain("Expected price overlay");
  } finally { await act(async () => { root.unmount(); }); }
});

test("a credit row from an older billing-aware build drops its stale token provenance", async () => {
  mockLogs([staleCreditProvenanceRow("stale-credit")]);
  const { root } = await mountAndOpen("stale-credit");
  try {
    const text = costSection().textContent ?? "";
    expect(text).toContain("Credit-priced total");
    expect(text).toContain("$0.0800");
    // A cached seed (or an older proxy) still carries the marker and reasons the old estimator
    // produced. The basis is exact, so the panel must not repeat them.
    expect(text).not.toContain("≥");
    expect(text).not.toContain("known lower bound");
    expect(text).not.toContain("Cache details were unavailable");
    expect(text).not.toContain("A verified expected list price was used");
    expect(text).not.toContain("Matched price key");
    // `usage_estimated` is still true of the credit reading, so it survives the filter.
    expect(text).toContain("Provider usage is estimated.");
  } finally { await act(async () => { root.unmount(); }); }
});

test("an older row without a billing field is still read as token-priced", async () => {
  mockLogs([legacyTokenRowWithoutBilling("legacy-token")]);
  const { root } = await mountAndOpen("legacy-token");
  try {
    const text = costSection().textContent ?? "";
    // Absence of `billing` is the compatibility signal for a token-priced row; hiding its
    // provenance would remove information the row does have.
    expect(text).toContain("Matched price key");
    expect(text).toContain("Price source");
    expect(text).toContain("≥$1.2120");
  } finally { await act(async () => { root.unmount(); }); }
});
