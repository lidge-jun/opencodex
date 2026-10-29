import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import QuotaSummaryBar from "../src/components/quota-summary-bar/QuotaSummaryBar";
import { LanguageProvider } from "../src/i18n/provider";

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

async function mount(source: string, percent = 100) {
  let polls = 0;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL) => {
    expect(String(input)).toBe("/api/provider-quotas");
    if (++polls > 1) return new Response(null, { status: 503 });
    return Response.json({ reports: [
      { provider: "meta-muse", label: "Muse Code", source, observed: true, updatedAt: now,
        quota: { customWindows: [{ label: "Muse Code", percent, resetAt: now + 5_000 }], updatedAt: now } },
      { provider: "openai", label: "OpenAI", updatedAt: now, quota: { weeklyPercent: 20, updatedAt: now } },
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
