import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import QuotaSummaryBar from "../src/components/quota-summary-bar/QuotaSummaryBar";
import { LanguageProvider } from "../src/i18n/provider";
import { PassiveKeyLimitCache } from "../../src/providers/quota/passive-key-limits";

const globals = ["document", "window", "navigator", "fetch", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let root: Root | undefined;
let now: number;
let nextTimer: number;
const timers = new Map<number, { at: number; run: () => void; interval?: number }>();
let restoreClock: () => void;
let restorePolling: () => void;

beforeEach(() => {
  clearClientResourceStoresForTests();
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    requestAnimationFrame: { configurable: true, value: () => 0 },
    cancelAnimationFrame: { configurable: true, value: () => {} },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  now = Date.parse("2026-10-28T00:00:00Z");
  nextTimer = 0;
  timers.clear();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  restoreClock = () => clock.mockRestore();
  const schedule = (run: () => void, delay: number, interval?: number) => {
    const id = ++nextTimer;
    timers.set(id, { at: now + delay, run, interval });
    return id;
  };
  testWindow.setTimeout = ((run: () => void, delay: number) => schedule(run, delay)) as typeof testWindow.setTimeout;
  testWindow.clearTimeout = (id: number) => { timers.delete(id); };
  testWindow.setInterval = ((run: () => void, delay: number) => schedule(run, delay, delay)) as typeof testWindow.setInterval;
  testWindow.clearInterval = (id: number) => { timers.delete(id); };
  // The resource store polls through global timers; the countdown uses window timers.
  const polling = spyOn(globalThis, "setInterval").mockImplementation(testWindow.setInterval as never);
  const clearPolling = spyOn(globalThis, "clearInterval").mockImplementation(testWindow.clearInterval as never);
  restorePolling = () => { polling.mockRestore(); clearPolling.mockRestore(); };
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  clearClientResourceStoresForTests();
  restorePolling();
  restoreClock();
  timers.clear();
  await testWindow.happyDOM.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
});

/** Advance scheduled callbacks in order, with React commits between timer turns. */
async function advance(ms: number) {
  const target = now + ms;
  for (;;) {
    const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    if (!next || next[1].at > target) break;
    const [id, timer] = next;
    now = timer.at;
    if (timer.interval) timer.at += timer.interval;
    else timers.delete(id);
    await act(async () => { timer.run(); });
  }
  now = target;
}

async function mount(source: string, percent = 100, extraReports: unknown[] = [], passiveKeyLimits: unknown = [], passiveOnly = false) {
  let polls = 0;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL) => {
    if (String(input) !== "/api/provider-quotas") return new Response(null, { status: 404 });
    if (++polls > 1) return new Response(null, { status: 503 });
    return Response.json({ passiveKeyLimits, reports: passiveOnly ? [] : [
      { provider: "meta-muse", label: "Muse Code", source, observed: true, updatedAt: now,
        quota: { customWindows: [{ label: "Muse Code", percent, resetAt: now + 5_000 }], updatedAt: now } },
      { provider: "openai", label: "OpenAI", updatedAt: now, quota: { weeklyPercent: 20, updatedAt: now } },
      ...extraReports,
    ] });
  } });
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><QuotaSummaryBar apiBase="" /></LanguageProvider>);
  });
  return {
    host,
    polls: () => polls,
    muse: () => host.querySelector('a[href="#providers?provider=meta-muse&tab=accounts"]'),
    openai: () => host.querySelector('a[href="#providers?provider=openai&tab=accounts"]'),
  };
}

test("passive key and model readings remain separate from Mistral budgets and go stale at reset", async () => {
  const view = await mount("meta-muse:usage-frame", 42, [{
    provider: "mistral", source: "mistral:budget", updatedAt: now,
    quota: { updatedAt: now, customWindows: [{ label: "API budget", percent: 10 }] },
  }], [
    { provider: "mistral", keyId: "account-a", model: "model-a", windows: [
      { dimension: "requests", window: "minute", observedAt: now - 120_000, remaining: 4, limit: 10, resetAt: now + 5_000, stale: false },
      { dimension: "input-tokens", observedAt: now, limit: 200, stale: false },
    ] },
    { provider: "mistral", keyId: "account-b", model: "model-b", windows: [
      { dimension: "tokens", window: "month", observedAt: now, remaining: 0, stale: true },
    ] },
  ]);
  const chips = () => [...view.host.querySelectorAll('a[href="#providers?provider=mistral&tab=accounts"]')];
  expect(chips()).toHaveLength(3);
  expect(chips()[0]?.textContent).toContain("API budget: 10%");
  expect(chips()[1]?.textContent).toContain("model-a");
  expect(chips()[1]?.textContent).toContain("4 / 10");
  expect(chips()[2]?.textContent).toContain("model-b");
  expect(view.host.textContent).not.toContain("account-a");
  await act(async () => { chips()[1]!.dispatchEvent(new testWindow.PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }) as unknown as Event); });
  expect(view.host.textContent).toContain("Observed 2m ago");
  expect(view.host.textContent).toContain("Unknown / 200");
  expect(view.host.textContent).toContain("Resets");
  await advance(5_000);
  expect(view.polls()).toBe(1);
  expect(chips()[1]?.textContent).toContain("Stale");
  await advance(60_000);
  expect(view.host.textContent).toContain("Observed 3m ago");
});

test("a passive-only response keeps each model for the same account visible", async () => {
  const window = { dimension: "requests", observedAt: now, remaining: 1, limit: 2, stale: false };
  const view = await mount("", 0, [], [
    { provider: "groq", keyId: "opaque", model: "a", windows: [window] },
    { provider: "groq", keyId: "opaque", model: "b", windows: [window] },
  ], true);
  const chips = [...view.host.querySelectorAll('a[href="#providers?provider=groq&tab=accounts"]')];
  expect(chips).toHaveLength(2);
  expect(chips[0]?.textContent).toContain("Observed key 1 · a");
  expect(chips[1]?.textContent).toContain("Observed key 1 · b");
  expect(view.host.textContent).not.toContain("opaque");
});

test("Groq daily request and minute token windows retain their distinct periods", async () => {
  const view = await mount("", 0, [], [{ provider: "groq", keyId: "opaque", model: "a", windows: [
    { dimension: "requests", window: "day", observedAt: now, remaining: 5, limit: 10, stale: false },
    { dimension: "tokens", window: "minute", observedAt: now, remaining: 6, limit: 20, stale: false },
  ] }], true);
  const chip = view.host.querySelector('a[href="#providers?provider=groq&tab=accounts"]');
  expect(chip?.textContent).toContain("day");
  expect(chip?.textContent).toContain("5 / 10");
  expect(chip?.textContent).toContain("minute");
  expect(chip?.textContent).toContain("6 / 20");
});

test("the quota strip renders unknown families from passive cache with their observation time", async () => {
  const cache = new PassiveKeyLimitCache({ retentionMs: 120_000 });
  const identity = { home: "gui-home", owner: "gui-fixture", provider: "mistral" as const, model: "model" };
  cache.record(identity, new Headers({ "x-ratelimit-remaining-req-minute": "0" }), now - 60_000, 1, 200);
  const view = await mount("", 0, [], [{ provider: "mistral", keyId: "opaque", model: "model", windows: cache.get(identity, now) }], true);
  const chip = view.host.querySelector('a[href="#providers?provider=mistral&tab=accounts"]');
  expect(chip?.textContent).toContain("0 / Unknown");
  expect(chip?.textContent?.match(/Unknown \/ Unknown/g)).toHaveLength(2);
  expect(chip?.textContent).toContain("minute");
  expect(chip?.textContent).toContain("month");
  await act(async () => { chip!.dispatchEvent(new testWindow.PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }) as unknown as Event); });
  expect(view.host.textContent).toContain("Observed 1m ago");
  expect(view.host.textContent).not.toContain("Resets");
});

test("malformed passive readings do not render or invent counts", async () => {
  const view = await mount("meta-muse:usage-frame", 42, [], [
    null, { provider: "mistral", keyId: "x", model: "m", windows: "bad" },
    { provider: "mistral", keyId: "x", model: "m", windows: [
      { dimension: "invalid", observedAt: now, remaining: 10, stale: false },
      { dimension: "requests", observedAt: now, remaining: -1, limit: "10", stale: false },
    ] },
  ]);
  expect(view.host.querySelectorAll('a[href="#providers?provider=mistral&tab=accounts"]')).toHaveLength(1);
  expect(view.host.textContent).toContain("Unknown / Unknown");
  expect(view.host.textContent).not.toContain("-1");
});

test("Mistral header shows both named budgets and the critical Vibe severity", async () => {
  const view = await mount("meta-muse:usage-frame", 42, [{
    provider: "mistral", label: "Mistral", source: "mistral:budget", updatedAt: now,
    quota: { updatedAt: now, customWindows: [
      { label: "API budget (EUR 2.00 of EUR 20.00 used; EDU)", percent: 10 },
      { label: "Vibe budget (EUR 9.50 of EUR 10.00 used; EDU)", percent: 95 },
    ] },
  }]);
  const chip = view.host.querySelector('a[href="#providers?provider=mistral&tab=accounts"]');
  expect(chip?.textContent).toContain("API budget");
  expect(chip?.textContent).toContain("10%");
  expect(chip?.textContent).toContain("Vibe budget");
  expect(chip?.textContent).toContain("95%");
  expect(chip?.closest("li")?.className).toContain("critical");
  expect(chip?.querySelector(".quota-summary-pct--normal")?.textContent).toContain("API budget");
  expect(chip?.querySelector(".quota-summary-pct--critical")?.textContent).toContain("Vibe budget");
});

test("Mistral header retains unknown budgets alongside measured budgets", async () => {
  const view = await mount("meta-muse:usage-frame", 42, [{
    provider: "custom-mistral", source: "mistral:budget", updatedAt: now,
    quota: { updatedAt: now, customWindows: [{ label: "Vibe budget (EDU)", percent: 20 }],
      unknownBudgetWindows: [{ label: "API budget (EDU)" }] },
  }]);
  const chip = view.host.querySelector('a[href="#providers?provider=custom-mistral&tab=accounts"]');
  expect(chip?.textContent).toContain("API budget: -");
  expect(chip?.textContent).toContain("Vibe budget: 20%");
});

test("the observed Muse row expires at reset without a successful poll and stays absent after a failed poll", async () => {
  const view = await mount("meta-muse:rate-limit-observation");
  expect(view.muse()?.textContent).toContain("100%");
  expect(view.muse()?.textContent).toContain("00:00:05");
  await advance(4_999);
  expect(view.muse()?.textContent).toContain("00:00:01");
  expect(view.polls()).toBe(1);
  await advance(1);
  expect(view.muse()).toBeNull();
  expect(view.openai()?.textContent).toContain("20%");
  expect(view.polls()).toBe(1);
  await advance(55_000);
  expect(view.polls()).toBe(2);
  expect(view.host.querySelector(".quota-summary-updated--stale")).not.toBeNull();
  expect(view.muse()).toBeNull();
  expect(view.openai()?.textContent).toContain("20%");
});

test("a native Muse report stays visible after its reset and a failed poll", async () => {
  const view = await mount("meta-muse:usage-frame", 42);
  await advance(5_000);
  expect(view.polls()).toBe(1);
  expect(view.muse()?.textContent).toContain("42%");
  expect(view.muse()?.textContent).toContain("00:00:00");
  await advance(55_000);
  expect(view.polls()).toBe(2);
  expect(view.host.querySelector(".quota-summary-updated--stale")).not.toBeNull();
  expect(view.muse()?.textContent).toContain("42%");
});
