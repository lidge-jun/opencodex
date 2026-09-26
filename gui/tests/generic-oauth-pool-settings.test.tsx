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
  supported?: string[];
};

function stubPool(initial: PoolPayload): { gets: string[]; puts: Record<string, unknown>[] } {
  const puts: Record<string, unknown>[] = [];
  const gets: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/pool/settings") && init?.method === "PUT") {
      const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      puts.push(body);
      return new Response(JSON.stringify({
        ...body,
        supported: ["enabled", "strategy", "stickyLimit", "autoSwitchThreshold"],
      }), { status: 200 });
    }
    if (url.includes("/api/pool/settings")) {
      gets.push(url);
      return new Response(JSON.stringify({
        ...initial,
        supported: initial.supported ?? ["enabled", "strategy", "stickyLimit", "autoSwitchThreshold"],
      }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
  }) as typeof fetch;
  return { gets, puts };
}

async function mountPool(accountCount = 2): Promise<HTMLElement> {
  const host = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(host as never);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    const root = createRoot(host);
    mountedRoots.push(root);
    root.render(
      <LanguageProvider>
        <AnthropicAccountPoolSettings
          apiBase="http://proxy"
          accountCount={accountCount}
          provider="google-antigravity"
        />
      </LanguageProvider>,
    );
  });
  await act(async () => { await flush(); });
  return host as unknown as HTMLElement;
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

describe("generic OAuth account pool settings", () => {
  test("loads google-antigravity through the unified pool settings contract", async () => {
    const { gets } = stubPool({
      enabled: true,
      autoSwitchThreshold: 80,
      strategy: "quota",
      stickyLimit: 1,
    });
    const host = await mountPool();

    expect(gets.some((url) => url.includes("provider=google-antigravity"))).toBe(true);
    expect(host.textContent).toContain("Account pool");
    expect(host.querySelector("#google-antigravity-pool-quota-window")).toBeNull();
    expect(host.textContent).not.toContain("Quota window");
  });

  test("renders minimal strategy status info for generic providers", async () => {
    stubPool({
      enabled: true,
      autoSwitchThreshold: 80,
      strategy: "quota",
      stickyLimit: 1,
    });
    const host = await mountPool();
    expect(host.textContent).toContain("Quota");
  });

  test("supports soonest reset strategy for generic providers", async () => {
    stubPool({
      enabled: true,
      autoSwitchThreshold: 80,
      strategy: "reset-first",
      stickyLimit: 1,
    });
    const host = await mountPool();
    expect(host.textContent).toContain("Soonest reset first");
    expect(host.textContent).toContain("Consumes the account whose 7-day weekly allowance resets earliest");
  });

  test("renders fill-first strategy for generic providers", async () => {
    stubPool({
      enabled: true,
      autoSwitchThreshold: 90,
      strategy: "fill-first",
      stickyLimit: 1,
    });
    const host = await mountPool();
    expect(host.textContent).toContain("Fill-first");
  });

  test("omits quotaWindow from generic saves", async () => {
    const { puts } = stubPool({
      enabled: true,
      autoSwitchThreshold: 80,
      strategy: "quota",
      stickyLimit: 1,
    });
    const host = await mountPool();
    const toggle = host.querySelector<HTMLButtonElement>("button.toggle");
    if (!toggle) throw new Error("toggle missing");

    await act(async () => {
      toggle.click();
      await flush();
    });

    expect(puts).toHaveLength(1);
    expect(puts[0]).toEqual({
      provider: "google-antigravity",
      enabled: false,
      autoSwitchThreshold: 80,
      strategy: "quota",
      stickyLimit: 1,
    });
    expect(puts[0]).not.toHaveProperty("quotaWindow");
  });

  test("keeps the proactive toggle off until two accounts exist", async () => {
    stubPool({
      enabled: false,
      autoSwitchThreshold: 80,
      strategy: "quota",
      stickyLimit: 1,
    });
    const host = await mountPool(1);
    const toggle = host.querySelector<HTMLButtonElement>("button.toggle");
    if (!toggle) throw new Error("toggle missing");
    expect(toggle.disabled).toBe(true);
    expect(host.textContent).toContain("at least two OAuth accounts");
  });
})

  test(
    "ignores stale GET and PUT completions after switching providers",
    async () => {
      const strategies: Record<string, string> = { "provider-a": "quota", "provider-b": "reset-first" };
      const payload = (provider: string) => ({ enabled: true, autoSwitchThreshold: 80, strategy: strategies[provider], stickyLimit: 1, supported: ["enabled", "strategy", "stickyLimit", "autoSwitchThreshold"] });
      const pendingGets = new Map<string, (v: Response) => void>();
      const pendingPuts = new Map<string, { resolve: (v: Response) => void; body: Record<string, unknown> }>();
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const params = new URL(url, "http://proxy").searchParams;
        if (url.includes("/api/pool/settings") && init?.method === "PUT") {
          const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
          const key = typeof body.provider === "string" ? (body.provider as string) : (params.get("provider") ?? "");
          return new Promise<Response>((resolve) => { pendingPuts.set(key, { resolve, body }); });
        }
        if (url.includes("/api/pool/settings")) {
          const provider = params.get("provider") ?? "";
          if (provider === "provider-a") return new Promise<Response>((resolve) => { pendingGets.set(provider, resolve); });
          return new Response(JSON.stringify(payload(provider)), { status: 200 });
        }
        throw new Error("unexpected fetch: " + url);
      }) as typeof fetch;

      const host = testWindow.document.createElement("div");
      testWindow.document.body.appendChild(host as never);
      const { createRoot } = await import("react-dom/client");
      let root: Root | null = null;
      const renderProvider = async (provider: string) => {
        await act(async () => {
          if (!root) { root = createRoot(host); mountedRoots.push(root); }
          root.render(
            <LanguageProvider>
              <AnthropicAccountPoolSettings apiBase="http://proxy" accountCount={2} provider={provider} />
            </LanguageProvider>,
          );
        });
        await act(async () => { await flush(); });
      };
      const strategyLabel = (): string | null => {
        const cands = [...testWindow.document.querySelectorAll("button")] as HTMLButtonElement[];
        const el = cands.find((b) => (b.id || "").slice(-9) === "-strategy");
        return el ? (el.textContent ?? "") : null;
      };
      const poolToggle = (): HTMLButtonElement | null => host.querySelector("button.toggle");

      await renderProvider("provider-a");
      await renderProvider("provider-b");
      expect(strategyLabel()).toBe("Soonest reset first");
      const resolveA = pendingGets.get("provider-a");
      if (!resolveA) throw new Error("A GET was never issued");
      await act(async () => {
        resolveA(new Response(JSON.stringify(payload("provider-a")), { status: 200 }));
        await flush();
      });
      expect(strategyLabel()).toBe("Soonest reset first");

      const toggle = poolToggle();
      if (!toggle) throw new Error("toggle missing");
      await act(async () => { toggle.click(); await flush(); });
      const put = pendingPuts.get("provider-b");
      if (!put) throw new Error("B PUT was never issued");
      await renderProvider("provider-a");
      expect(strategyLabel()).toBeNull();
      const resolveA2 = pendingGets.get("provider-a");
      if (!resolveA2) throw new Error("second A GET was never issued");
      await act(async () => {
        resolveA2(new Response(JSON.stringify(payload("provider-a")), { status: 200 }));
        await flush();
      });
      expect(strategyLabel()).toBe("Quota");
      expect(poolToggle()?.getAttribute("aria-pressed")).toBe("true");
      await act(async () => {
        put.resolve(new Response(JSON.stringify({ ...put.body, supported: payload("provider-b").supported }), { status: 200 }));
        await flush();
      });
      expect(strategyLabel()).toBe("Quota");
      expect(poolToggle()?.getAttribute("aria-pressed")).toBe("true");
    },
  );
