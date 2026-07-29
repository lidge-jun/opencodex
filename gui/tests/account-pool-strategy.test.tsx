import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_ACCOUNT_POOL_STICKY_LIMIT,
  DEFAULT_ACCOUNT_POOL_STRATEGY,
  normalizeAccountPoolStickyLimit,
  normalizeAccountPoolStrategy,
  parseAccountPoolStickyLimitDraft,
  putCodexPoolStrategy,
} from "../src/account-pool-strategy";
import AccountPoolStrategyControls from "../src/components/AccountPoolStrategyControls";
import CodexPoolStrategySetting from "../src/components/CodexPoolStrategySetting";
import { LanguageProvider } from "../src/i18n/provider";

let previousLanguage: unknown;

const domGlobals = ["document", "window", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousDomGlobals: Record<(typeof domGlobals)[number], unknown>;
let testWindow: Window;
let mountedRoot: Root | null;

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
  await Promise.resolve();
}

beforeEach(() => {
  previousLanguage = (globalThis.navigator as { language?: unknown } | undefined)?.language;
  Object.defineProperty(globalThis.navigator, "language", {
    configurable: true,
    value: "en-US",
  });
});

afterEach(() => {
  Object.defineProperty(globalThis.navigator, "language", {
    configurable: true,
    value: previousLanguage,
  });
});

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
  mountedRoot = null;
}

async function teardownDom(): Promise<void> {
  if (mountedRoot) {
    await act(async () => {
      mountedRoot?.unmount();
    });
    mountedRoot = null;
  }
  for (const key of domGlobals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousDomGlobals[key] });
  }
  await testWindow.happyDOM?.close?.();
}

describe("account pool strategy helpers", () => {
  test("normalizes known strategies and defaults unknowns to quota", () => {
    expect(normalizeAccountPoolStrategy("quota")).toBe("quota");
    expect(normalizeAccountPoolStrategy("round-robin")).toBe("round-robin");
    expect(normalizeAccountPoolStrategy("fill-first")).toBe("fill-first");
    expect(normalizeAccountPoolStrategy("weighted")).toBe(DEFAULT_ACCOUNT_POOL_STRATEGY);
    expect(normalizeAccountPoolStrategy(undefined)).toBe("quota");
  });

  test("normalizes sticky limits to 1–100 integers", () => {
    expect(normalizeAccountPoolStickyLimit(3)).toBe(3);
    expect(normalizeAccountPoolStickyLimit(1)).toBe(1);
    expect(normalizeAccountPoolStickyLimit(100)).toBe(100);
    expect(normalizeAccountPoolStickyLimit(0)).toBe(DEFAULT_ACCOUNT_POOL_STICKY_LIMIT);
    expect(normalizeAccountPoolStickyLimit(101)).toBe(DEFAULT_ACCOUNT_POOL_STICKY_LIMIT);
    expect(normalizeAccountPoolStickyLimit(1.5)).toBe(DEFAULT_ACCOUNT_POOL_STICKY_LIMIT);
  });

  test("parses sticky-limit drafts strictly", () => {
    expect(parseAccountPoolStickyLimitDraft("1")).toBe(1);
    expect(parseAccountPoolStickyLimitDraft("42")).toBe(42);
    expect(parseAccountPoolStickyLimitDraft("100")).toBe(100);
    for (const invalid of ["", "0", "101", "1.5", "-1", "abc", " 2 "]) {
      // Leading/trailing spaces are trimmed; " 2 " is valid.
      if (invalid === " 2 ") {
        expect(parseAccountPoolStickyLimitDraft(invalid)).toBe(2);
        continue;
      }
      expect(parseAccountPoolStickyLimitDraft(invalid)).toBeNull();
    }
  });

  test("putCodexPoolStrategy sends strategy/stickyLimit body fields", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const result = await putCodexPoolStrategy(
      "http://proxy",
      { strategy: "round-robin", stickyLimit: 3 },
      async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({
          ok: true,
          accountPoolStrategy: "round-robin",
          accountPoolStickyLimit: 3,
        }), { status: 200 });
      },
    );
    expect(result).toEqual({ ok: true, strategy: "round-robin", stickyLimit: 3 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://proxy/api/codex-auth/pool-strategy");
    expect(calls[0]!.init.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      strategy: "round-robin",
      stickyLimit: 3,
    });
  });
});

describe("AccountPoolStrategyControls", () => {
  test("renders strategy options and hides sticky unless round-robin", () => {
    const quota = renderToStaticMarkup(
      <LanguageProvider>
        <AccountPoolStrategyControls
          strategy="quota"
          stickyDraft="1"
          onStrategyChange={() => {}}
          onStickyDraftChange={() => {}}
          onStickyCommit={() => {}}
        />
      </LanguageProvider>,
    );
    expect(quota).toContain("Quota");
    expect(quota).toContain("Round-robin");
    expect(quota).toContain("Fill-first");
    expect(quota).toContain("Applies to new sessions only");
    expect(quota).not.toContain("Sticky successes before rotate");

    const rr = renderToStaticMarkup(
      <LanguageProvider>
        <AccountPoolStrategyControls
          strategy="round-robin"
          stickyDraft="2"
          onStrategyChange={() => {}}
          onStickyDraftChange={() => {}}
          onStickyCommit={() => {}}
        />
      </LanguageProvider>,
    );
    expect(rr).toContain("Sticky successes before rotate");
    expect(rr).toContain('value="2"');
  });

  test("keeps the visual field label by default (Anthropic card has its own title)", () => {
    const markup = renderToStaticMarkup(
      <LanguageProvider>
        <AccountPoolStrategyControls
          strategy="quota"
          stickyDraft="1"
          onStrategyChange={() => {}}
          onStickyDraftChange={() => {}}
          onStickyCommit={() => {}}
        />
      </LanguageProvider>,
    );
    expect(markup).toContain('class="field-label"');
    expect(markup).not.toContain('class="sr-only"');
  });

  test("strategyLabelHidden drops the duplicate visual label but keeps the accessible name", () => {
    const markup = renderToStaticMarkup(
      <LanguageProvider>
        <AccountPoolStrategyControls
          strategy="quota"
          stickyDraft="1"
          strategyLabelHidden
          onStrategyChange={() => {}}
          onStickyDraftChange={() => {}}
          onStickyCommit={() => {}}
        />
      </LanguageProvider>,
    );
    expect(markup).not.toContain('class="field-label"');
    expect(markup).toContain('class="sr-only"');
    // The select must still expose an accessible name.
    expect(markup).toContain('aria-label="Rotation strategy"');
  });
});

describe("CodexPoolStrategySetting optimistic strategy select", () => {
  beforeEach(() => setupDom());
  afterEach(async () => {
    await teardownDom();
  });

  test("updates visible strategy before save completes", async () => {
    const put = deferred<Response>();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/codex-auth/active") && (!init || init.method === undefined)) {
        return new Response(JSON.stringify({
          accountPoolStrategy: "quota",
          accountPoolStickyLimit: 1,
        }), { status: 200 });
      }
      if (url.endsWith("/api/codex-auth/pool-strategy") && init?.method === "PUT") {
        return put.promise;
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    }) as typeof fetch;

    const host = testWindow.document.createElement("div");
    testWindow.document.body.appendChild(host as never);
    const { createRoot } = await import("react-dom/client");
    await act(async () => {
      mountedRoot = createRoot(host);
      mountedRoot.render(
        <LanguageProvider>
          <CodexPoolStrategySetting apiBase="http://proxy" />
        </LanguageProvider>,
      );
    });
    await act(async () => { await flush(); });

    const select = () => host.querySelector<HTMLSelectElement>("#codex-pool-strategy");
    expect(select()?.value).toBe("quota");

    await act(async () => {
      const el = select();
      if (!el) throw new Error("strategy select missing");
      Object.getOwnPropertyDescriptor(testWindow.HTMLSelectElement.prototype, "value")!
        .set!.call(el, "round-robin");
      el.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
      await flush();
    });

    expect(select()?.value).toBe("round-robin");
    expect(select()?.disabled).toBe(true);

    await act(async () => {
      put.resolve(new Response(JSON.stringify({
        ok: true,
        accountPoolStrategy: "round-robin",
        accountPoolStickyLimit: 1,
      }), { status: 200 }));
      await flush();
    });

    expect(select()?.value).toBe("round-robin");
    expect(select()?.disabled).toBe(false);
    expect(host.textContent).toContain("Sticky successes before rotate");
  });

  test("rolls back strategy when save fails", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/codex-auth/active") && (!init || init.method === undefined)) {
        return new Response(JSON.stringify({
          accountPoolStrategy: "quota",
          accountPoolStickyLimit: 1,
        }), { status: 200 });
      }
      if (url.endsWith("/api/codex-auth/pool-strategy") && init?.method === "PUT") {
        return new Response("fail", { status: 500 });
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    }) as typeof fetch;

    const host = testWindow.document.createElement("div");
    testWindow.document.body.appendChild(host as never);
    const { createRoot } = await import("react-dom/client");
    await act(async () => {
      mountedRoot = createRoot(host);
      mountedRoot.render(
        <LanguageProvider>
          <CodexPoolStrategySetting apiBase="http://proxy" />
        </LanguageProvider>,
      );
    });
    await act(async () => { await flush(); });

    const select = () => host.querySelector<HTMLSelectElement>("#codex-pool-strategy");
    await act(async () => {
      const el = select();
      if (!el) throw new Error("strategy select missing");
      Object.getOwnPropertyDescriptor(testWindow.HTMLSelectElement.prototype, "value")!
        .set!.call(el, "fill-first");
      el.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
      await flush();
    });

    expect(select()?.value).toBe("quota");
    expect(host.textContent).toContain("Rotation strategy could not be saved");
  });

  test("renders the card title once, without a duplicate field label", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/codex-auth/active") && (!init || init.method === undefined)) {
        return new Response(JSON.stringify({
          accountPoolStrategy: "quota",
          accountPoolStickyLimit: 1,
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    }) as typeof fetch;

    const host = testWindow.document.createElement("div");
    testWindow.document.body.appendChild(host as never);
    const { createRoot } = await import("react-dom/client");
    await act(async () => {
      mountedRoot = createRoot(host);
      mountedRoot.render(
        <LanguageProvider>
          <CodexPoolStrategySetting apiBase="http://proxy" />
        </LanguageProvider>,
      );
    });
    await act(async () => { await flush(); });

    // The card title is the only VISIBLE occurrence; the select's label is sr-only.
    const visible = [...host.querySelectorAll("*")]
      .filter((el) => !el.classList.contains("sr-only"))
      .filter((el) => el.children.length === 0)
      .map((el) => el.textContent?.trim() ?? "")
      .filter((text) => text === "Rotation strategy");
    expect(visible).toHaveLength(1);
    expect(host.querySelector(".field-label")).toBeNull();

    // Accessibility is preserved: the select still has an accessible name.
    const select = host.querySelector<HTMLSelectElement>("#codex-pool-strategy");
    expect(select?.getAttribute("aria-label")).toBe("Rotation strategy");
  });
});
