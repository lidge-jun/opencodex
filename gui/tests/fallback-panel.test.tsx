import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import FallbackPanel from "../src/components/FallbackPanel";
import { parseFallbackState } from "../src/fallback-api";
import { LanguageProvider } from "../src/i18n/provider";

const domGlobals = ["document", "window", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousDomGlobals: Record<(typeof domGlobals)[number], unknown>;
let testWindow: Window;
let mountedRoot: Root | null;

const LINK = "lnk_0123456789abcdef";
const baseState = {
  schema: "ocx.fallback/1",
  global: { model: true, provider: true },
  providers: {},
  routes: { "combo/coding": { provider: false } },
  devices: [{ id: LINK, kind: "link", alias: "mac-studio", localFallback: false, model: null, provider: null }],
  last: { at: "2026-10-22T00:00:00.000Z", route: "combo/coding", kind: "provider", from: "a/m", to: "b/n", trigger: "rate_limited", outcome: "refused" },
  recent: [],
};

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
  await Promise.resolve();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("FallbackPanel", () => {
  beforeEach(() => {
    previousDomGlobals = Object.fromEntries(domGlobals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousDomGlobals;
    testWindow = new Window({ url: "http://localhost/" });
    Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
    Object.defineProperties(globalThis, {
      document: { configurable: true, value: testWindow.document },
      window: { configurable: true, value: testWindow },
      navigator: { configurable: true, value: testWindow.navigator },
    });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mountedRoot = null;
  });

  afterEach(async () => {
    if (mountedRoot) {
      await act(async () => { mountedRoot?.unmount(); });
      mountedRoot = null;
    }
    for (const key of domGlobals) Object.defineProperty(globalThis, key, { configurable: true, value: previousDomGlobals[key] });
    await testWindow.happyDOM?.close?.();
  });

  async function mount(fetchMock: typeof fetch, section: "routing" | "devices", readOnly = false): Promise<HTMLElement> {
    globalThis.fetch = fetchMock;
    const host = testWindow.document.createElement("div");
    testWindow.document.body.appendChild(host as never);
    const { createRoot } = await import("react-dom/client");
    await act(async () => {
      mountedRoot = createRoot(host);
      mountedRoot.render(<LanguageProvider><FallbackPanel apiBase="http://proxy" section={section} readOnly={readOnly} /></LanguageProvider>);
    });
    await act(async () => { await flush(); });
    return host as unknown as HTMLElement;
  }

  test("parseFallbackState rejects foreign shapes", () => {
    expect(parseFallbackState({ schema: "other" })).toBeNull();
    expect(parseFallbackState(null)).toBeNull();
    expect(parseFallbackState(baseState)?.devices).toHaveLength(1);
  });

  test("routing: shows the switches, the override and the last refusal; turning provider off writes the global scope", async () => {
    const writes: unknown[] = [];
    const host = await mount((async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        writes.push(...(JSON.parse(String(init.body)) as { writes: unknown[] }).writes);
        return json({ ...baseState, global: { model: true, provider: false } });
      }
      return json(baseState);
    }) as unknown as typeof fetch, "routing");
    expect(host.textContent).toContain("Model fallback");
    expect(host.textContent).toContain("Route combo/coding");
    expect(host.textContent).toContain("refused");
    const providerToggle = host.querySelector<HTMLButtonElement>('button[aria-label="Provider fallback"]')!;
    expect(providerToggle.getAttribute("aria-pressed")).toBe("true");
    await act(async () => { providerToggle.click(); await flush(); });
    expect(writes).toEqual([{ scope: "global", setting: "provider", value: false }]);
    expect(host.querySelector('button[aria-label="Provider fallback"]')!.getAttribute("aria-pressed")).toBe("false");
  });

  test("devices: local fallback writes the device permission; chains off refuses both kinds", async () => {
    const requests: unknown[] = [];
    const host = await mount((async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        requests.push(JSON.parse(String(init.body)));
        return json(baseState);
      }
      return json(baseState);
    }) as unknown as typeof fetch, "devices");
    expect(host.textContent).toContain("mac-studio");
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Local fallback for mac-studio"]')!.click(); await flush(); });
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Fallback chains for mac-studio"]')!.click(); await flush(); });
    // One request per switch; the chains switch writes both kinds in one batch.
    expect(requests).toEqual([
      { writes: [{ scope: "device", key: LINK, setting: "localFallback", value: true }] },
      { writes: [
        { scope: "device", key: LINK, setting: "model", value: false },
        { scope: "device", key: LINK, setting: "provider", value: false },
      ] },
    ]);
  });

  test("devices: turning local fallback off sends a clearing write and the toggle shows off", async () => {
    const requests: unknown[] = [];
    const allowed = { ...baseState, devices: [{ ...baseState.devices[0]!, localFallback: true }] };
    const host = await mount((async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        requests.push(JSON.parse(String(init.body)));
        return json({ ...allowed, devices: [{ ...allowed.devices[0]!, localFallback: false }] });
      }
      return json(allowed);
    }) as unknown as typeof fetch, "devices");
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Local fallback for mac-studio"]')!.click(); await flush(); });
    expect(requests).toEqual([{ writes: [{ scope: "device", key: LINK, setting: "localFallback", value: null }] }]);
    expect(host.querySelector('button[aria-label="Local fallback for mac-studio"]')!.getAttribute("aria-pressed")).toBe("false");
  });

  test("on a Child the device rows are read-only and nothing is written", async () => {
    let puts = 0;
    const host = await mount((async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") puts += 1;
      return json(baseState);
    }) as unknown as typeof fetch, "devices", true);
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("button.toggle")];
    expect(buttons.length).toBe(2);
    expect(buttons.every(button => button.disabled)).toBe(true);
    expect(host.textContent).toContain("kept on this device's Home");
    expect(puts).toBe(0);
  });

  test("a failed load says so and offers a retry", async () => {
    const host = await mount((async () => json({ error: "nope" }, 500)) as unknown as typeof fetch, "routing");
    expect(host.textContent).toContain("Could not load fallback settings.");
  });

  test("a poll that started before a save cannot restore the state the save replaced", async () => {
    // Capture the 30 s poll so the test decides when the second GET starts.
    let poll: (() => void) | undefined;
    const realSetInterval = testWindow.setInterval.bind(testWindow);
    testWindow.setInterval = ((fn: () => void, ms?: number) => {
      if (ms === 30_000) { poll = fn; return 0; }
      return realSetInterval(fn, ms);
    }) as typeof testWindow.setInterval;
    let gets = 0;
    let releaseStale: (() => void) | undefined;
    const host = await mount((async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") return json({ ...baseState, global: { model: true, provider: false } });
      gets += 1;
      if (gets === 1) return json(baseState);
      await new Promise<void>(resolve => { releaseStale = resolve; });
      return json(baseState);
    }) as unknown as typeof fetch, "routing");
    expect(poll).toBeDefined();
    await act(async () => { poll!(); await flush(); });
    expect(gets).toBe(2);
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Provider fallback"]')!.click(); await flush(); });
    expect(host.querySelector('button[aria-label="Provider fallback"]')!.getAttribute("aria-pressed")).toBe("false");
    await act(async () => { releaseStale!(); await flush(); });
    expect(host.querySelector('button[aria-label="Provider fallback"]')!.getAttribute("aria-pressed")).toBe("false");
  });

  test("on a Child the routing switches and the Clear button are read-only", async () => {
    let puts = 0;
    const host = await mount((async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") puts += 1;
      return json(baseState);
    }) as unknown as typeof fetch, "routing", true);
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.some(button => button.textContent === "Clear")).toBe(true);
    expect(buttons.every(button => button.disabled)).toBe(true);
    expect(host.textContent).toContain("kept on this device's Home");
    for (const button of buttons) await act(async () => { button.click(); await flush(); });
    expect(puts).toBe(0);
  });
});
