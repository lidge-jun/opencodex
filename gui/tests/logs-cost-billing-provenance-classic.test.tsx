import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { installClassicSourceOverlay } from "./helpers/classic-source-overlay";
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
 * The classic dashboard (served at /classic/) has its own frozen copy of the Logs page, and it
 * carried the same #8452 defect: the credit total printed the token catalog key as its price
 * source, and a Priority-floor token rate put `>=` over an exact charge. A fix in the current
 * page alone would leave every operator on the classic edition with the old attribution.
 *
 * The page is loaded through `installClassicSourceOverlay()` so these cases run the shipped
 * classic source, with rows built by the production `requestLogDto`.
 */
installClassicSourceOverlay();

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
  testWindow = new Window({ url: "http://localhost/classic/#logs" });
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
  const { default: ClassicLogs } = await import("../classic/src/pages/Logs");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><ClassicLogs apiBase="http://localhost" /></LanguageProvider>);
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

test("classic: a credit charge names no token price key or source and no lower bound", async () => {
  mockLogs([creditRow("classic-credit-only")]);
  const { root } = await mountAndOpen("classic-credit-only");
  try {
    const text = costSection().textContent ?? "";
    expect(text).toContain("Credit-priced total");
    expect(text).toContain("2 credits × $0.04 per credit");
    expect(text).not.toContain("Matched price key");
    expect(text).not.toContain("Price source");
    expect(text).not.toContain("grok-4.7");
    expect(text).toContain("$0.0800");
    expect(text).not.toContain("≥");
    expect(text).not.toContain("known lower bound");
    // The token rate's caveats are not caveats about a credit charge.
    expect(text).not.toContain("Cache details were unavailable");
    expect(text).not.toContain("A verified expected list price was used");
  } finally { await act(async () => { root.unmount(); }); }
});

test("classic: a token-priced Priority row keeps its key, source, and lower bound", async () => {
  mockLogs([tokenPriorityRow("classic-token-priority")]);
  const { root } = await mountAndOpen("classic-token-priority");
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

test("classic: a mixed combo attributes only the token leg, and the sum is not a floor", async () => {
  mockLogs([mixedComboRow("classic-mixed-combo")]);
  const { root } = await mountAndOpen("classic-mixed-combo");
  try {
    const parentText = costSection().textContent ?? "";
    expect(parentText).toContain("Combined total (per-attempt basis)");
    expect(parentText).not.toContain("Matched price key");
    expect(parentText).not.toContain("Price source");
    expect(parentText).toContain("$1.2900");
    expect(parentText).not.toContain("≥");

    const attempts = [...document.querySelectorAll<HTMLTableRowElement>(".log-detail-attempts tbody tr")];
    expect(attempts).toHaveLength(2);
    const [creditLeg, tokenLeg] = attempts.map(row => row.textContent ?? "");
    expect(creditLeg).toContain("$0.0780");
    expect(creditLeg).not.toContain("≥");
    expect(creditLeg).not.toContain("grok-4.7");
    expect(creditLeg).not.toContain("jawcode catalog");
    expect(creditLeg).not.toContain("Verified");
    expect(tokenLeg).toContain("≥$1.2120");
    expect(tokenLeg).toContain("grok-4.7");
    expect(tokenLeg).toContain("Expected price overlay");
  } finally { await act(async () => { root.unmount(); }); }
});

test("classic: a credit row from an older billing-aware build drops its stale token provenance", async () => {
  mockLogs([staleCreditProvenanceRow("classic-stale-credit")]);
  const { root } = await mountAndOpen("classic-stale-credit");
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

test("classic: an older row without a billing field is still read as token-priced", async () => {
  mockLogs([legacyTokenRowWithoutBilling("classic-legacy-token")]);
  const { root } = await mountAndOpen("classic-legacy-token");
  try {
    const text = costSection().textContent ?? "";
    expect(text).toContain("Matched price key");
    expect(text).toContain("Price source");
    expect(text).toContain("≥$1.2120");
  } finally { await act(async () => { root.unmount(); }); }
});
