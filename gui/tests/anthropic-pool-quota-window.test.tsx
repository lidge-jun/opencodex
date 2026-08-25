import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import AnthropicAccountPoolSettings from "../src/components/provider-workspace/AnthropicAccountPoolSettings";
import { LanguageProvider } from "../src/i18n/provider";

let previousLanguage: unknown;

const domGlobals = ["document", "window", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousDomGlobals: Record<(typeof domGlobals)[number], unknown>;
let testWindow: Window;
let mountedRoots: Root[];

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
  await Promise.resolve();
}

function setupDom(): void {
  previousDomGlobals = Object.fromEntries(
    domGlobals.map((key) => [key, Reflect.get(globalThis, key)]),
  ) as typeof previousDomGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mountedRoots = [];
}

async function teardownDom(): Promise<void> {
  for (const root of mountedRoots) {
    await act(async () => {
      root.unmount();
    });
  }
  mountedRoots = [];
  for (const key of domGlobals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousDomGlobals[key] });
  }
  await testWindow.happyDOM?.close?.();
}

type PoolPayload = {
  enabled: boolean;
  autoSwitchThreshold: number;
  strategy: string;
  stickyLimit: number;
  quotaWindow: string;
};

/**
 * Stubs both pool endpoints and returns the recorded PUT bodies. The GET carries a
 * `?provider=anthropic` query, so the URL match is a substring rather than a suffix.
 */
function stubPool(initial: PoolPayload): Record<string, unknown>[] {
  const puts: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/oauth/accounts/pool") && init?.method === "PUT") {
      const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      puts.push(body);
      return new Response(JSON.stringify({
        strategy: body.strategy,
        stickyLimit: body.stickyLimit,
        quotaWindow: body.quotaWindow,
      }), { status: 200 });
    }
    if (url.includes("/api/oauth/accounts/pool")) {
      return new Response(JSON.stringify(initial), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
  }) as typeof fetch;
  return puts;
}

async function mountPool(): Promise<HTMLElement> {
  const host = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(host as never);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    const root = createRoot(host);
    mountedRoots.push(root);
    root.render(
      <LanguageProvider>
        <AnthropicAccountPoolSettings apiBase="http://proxy" accountCount={2} />
      </LanguageProvider>,
    );
  });
  await act(async () => { await flush(); });
  return host as unknown as HTMLElement;
}

function windowTrigger(host: ParentNode): HTMLButtonElement {
  const el = host.querySelector<HTMLButtonElement>("#anthropic-pool-quota-window");
  if (!el) throw new Error("quota window select missing");
  return el;
}

beforeEach(() => {
  previousLanguage = (globalThis.navigator as { language?: unknown } | undefined)?.language;
  Object.defineProperty(globalThis.navigator, "language", {
    configurable: true,
    value: "en-US",
  });
  setupDom();
});

afterEach(async () => {
  await teardownDom();
  Object.defineProperty(globalThis.navigator, "language", {
    configurable: true,
    value: previousLanguage,
  });
});

describe("Anthropic account pool quota window", () => {
  test("quota window selector renders for quota and fill-first strategies", async () => {
    stubPool({
      enabled: true,
      autoSwitchThreshold: 80,
      strategy: "quota",
      stickyLimit: 1,
      quotaWindow: "weekly",
    });
    const quotaHost = await mountPool();

    expect(windowTrigger(quotaHost).disabled).toBe(false);
    expect(windowTrigger(quotaHost).textContent).toContain("Weekly bar");
    expect(quotaHost.textContent).toContain("Quota window");
    // The hint replaces the inert notice whenever the setting actually scores a bar.
    expect(quotaHost.textContent).toContain("breaks weekly ties by lower 5-hour usage");

    stubPool({
      enabled: true,
      autoSwitchThreshold: 80,
      strategy: "fill-first",
      stickyLimit: 1,
      quotaWindow: "five-hour",
    });
    const fillHost = await mountPool();

    expect(windowTrigger(fillHost).disabled).toBe(false);
    expect(windowTrigger(fillHost).textContent).toContain("5-hour bar");
  });

  test("quota window selector is disabled for round-robin and for fill-first with threshold 0", async () => {
    stubPool({
      enabled: true,
      autoSwitchThreshold: 80,
      strategy: "round-robin",
      stickyLimit: 1,
      quotaWindow: "weekly",
    });
    const rrHost = await mountPool();

    expect(windowTrigger(rrHost).disabled).toBe(true);
    expect(rrHost.textContent).toContain("scores a usage bar");

    stubPool({
      enabled: true,
      autoSwitchThreshold: 0,
      strategy: "fill-first",
      stickyLimit: 1,
      quotaWindow: "weekly",
    });
    const drainedHost = await mountPool();

    // fill-first only drains against a threshold; at 0 there is no bar to score.
    expect(windowTrigger(drainedHost).disabled).toBe(true);
    expect(drainedHost.textContent).toContain("scores a usage bar");
  });

  test("save sends quotaWindow in the PUT body", async () => {
    const puts = stubPool({
      enabled: true,
      autoSwitchThreshold: 80,
      strategy: "quota",
      stickyLimit: 1,
      quotaWindow: "five-hour",
    });
    const host = await mountPool();

    await act(async () => {
      windowTrigger(host).click();
      await flush();
    });
    const option = Array.from(testWindow.document.querySelectorAll<HTMLButtonElement>('[role="option"]'))
      .find((el) => (el.textContent ?? "").includes("Weekly bar"));
    if (!option) throw new Error("weekly option missing");
    await act(async () => {
      option.click();
      await flush();
    });

    expect(puts).toHaveLength(1);
    expect(puts[0]).toEqual({
      provider: "anthropic",
      enabled: true,
      autoSwitchThreshold: 80,
      strategy: "quota",
      stickyLimit: 1,
      quotaWindow: "weekly",
    });
    expect(windowTrigger(host).textContent).toContain("Weekly bar");
  });
});
