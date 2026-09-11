import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import UsageLedgerRetentionControl from "../src/components/usage/UsageLedgerRetentionControl";
import { LanguageProvider } from "../src/i18n";
import { useI18n } from "../src/i18n/shared";

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
type GlobalName = (typeof globals)[number];

let previous: Record<GlobalName, PropertyDescriptor | undefined>;
let testWindow: Window;
let root: Root | null = null;
let host: HTMLElement;

function restoreProperty(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

beforeEach(() => {
  previous = Object.fromEntries(
    globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as typeof previous;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  host = testWindow.document.createElement("div") as never as HTMLElement;
  testWindow.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  for (const key of globals) restoreProperty(globalThis, key, previous[key]);
  await testWindow.happyDOM?.close?.();
});

async function settleTimers(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

async function mount(apiBase: string): Promise<void> {
  await act(async () => {
    root = createRoot(host);
    root.render(createElement(
      LanguageProvider,
      null,
      createElement(UsageLedgerRetentionControl, { apiBase }),
    ));
  });
  await settleTimers();
}

function LocaleHarness({ apiBase }: { apiBase: string }) {
  const { setLocale } = useI18n();
  return createElement(
    "div",
    null,
    createElement("button", { type: "button", id: "locale-switch", onClick: () => setLocale("de") }, "locale"),
    createElement(UsageLedgerRetentionControl, { apiBase }),
  );
}

test("retention control stays on Usage and out of Storage", async () => {
  const page = await Bun.file(new URL("../src/pages/Usage.tsx", import.meta.url)).text();
  const storageWorkspace = await Bun.file(new URL("../src/components/storage-workspace/StorageWorkspace.tsx", import.meta.url)).text();

  expect(page).toContain("UsageLedgerRetentionControl");
  expect(storageWorkspace).not.toContain("UsageLedgerRetentionPanel");
});

test("renders one switch and toggles without rewriting the saved byte ceiling", async () => {
  const apiBase = "http://usage-retention-test";
  const maxBytes = 512 * 1024 * 1024 + 17;
  const writes: Array<{ enabled: boolean; maxBytes: number }> = [];
  let enabled = false;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url !== `${apiBase}/api/storage/usage-ledger-retention`) throw new Error(`unexpected fetch: ${url}`);
    if ((init?.method ?? "GET") === "PUT") {
      const body = JSON.parse(String(init?.body)) as { enabled: boolean; maxBytes: number };
      writes.push(body);
      enabled = body.enabled;
      return Response.json({ enabled, maxBytes, currentBytes: 1234 });
    }
    return Response.json({ enabled, maxBytes, currentBytes: 1234 });
  }) as typeof fetch;

  await mount(apiBase);

  const switches = host.querySelectorAll<HTMLButtonElement>("button.switch");
  expect(switches.length).toBe(1);
  expect(host.querySelector('[aria-haspopup="listbox"]')).toBeNull();
  expect(switches[0].disabled).toBe(false);
  expect(switches[0].getAttribute("aria-pressed")).toBe("false");
  expect(host.querySelector(".usage-retention-state")?.textContent).toBe("Unlimited");
  expect(host.querySelector(".usage-retention-limit")?.classList.contains("is-disabled")).toBe(true);

  await act(async () => {
    switches[0].click();
    await Promise.resolve();
  });
  expect(writes[0]).toEqual({ enabled: true, maxBytes });
  expect(switches[0].getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelector(".usage-retention-state")).toBeNull();
  expect(host.querySelector(".usage-retention-limit")?.classList.contains("is-disabled")).toBe(false);

  await act(async () => {
    switches[0].click();
    await Promise.resolve();
  });
  expect(writes[1]).toEqual({ enabled: false, maxBytes });
  expect(switches[0].getAttribute("aria-pressed")).toBe("false");
  expect(host.querySelector(".usage-retention-state")?.textContent).toBe("Unlimited");
  expect(host.querySelector(".usage-retention-limit")?.classList.contains("is-disabled")).toBe(true);
});

test("a stale GET cannot repaint policy after a successful toggle", async () => {
  const apiBase = "http://usage-retention-stale";
  const maxBytes = 1024 * 1024 * 1024;
  let getCount = 0;
  let resolveStaleGet: ((response: Response) => void) | undefined;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url !== `${apiBase}/api/storage/usage-ledger-retention`) throw new Error(`unexpected fetch: ${url}`);
    if ((init?.method ?? "GET") === "PUT") {
      return Promise.resolve(Response.json({ enabled: true, maxBytes, currentBytes: 1234 }));
    }
    getCount += 1;
    if (getCount === 1) return Promise.resolve(Response.json({ enabled: false, maxBytes, currentBytes: 1234 }));
    return new Promise<Response>(resolve => { resolveStaleGet = resolve; });
  }) as typeof fetch;

  await act(async () => {
    root = createRoot(host);
    root.render(createElement(LanguageProvider, null, createElement(LocaleHarness, { apiBase })));
  });
  await settleTimers();

  const localeSwitch = host.querySelector<HTMLButtonElement>("#locale-switch");
  if (!localeSwitch) throw new Error("locale switch missing");
  await act(async () => { localeSwitch.click(); });
  await settleTimers();
  expect(getCount).toBe(2);

  const toggle = host.querySelector<HTMLButtonElement>("button.switch");
  if (!toggle) throw new Error("retention switch missing");
  await act(async () => {
    toggle.click();
    await Promise.resolve();
  });
  expect(toggle.getAttribute("aria-pressed")).toBe("true");

  if (!resolveStaleGet) throw new Error("stale GET was not started");
  await act(async () => {
    resolveStaleGet(Response.json({ enabled: false, maxBytes, currentBytes: 1234 }));
    await Promise.resolve();
  });
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
});

test("a stale failed GET is silent after a successful toggle", async () => {
  const apiBase = "http://usage-retention-stale-failure";
  const maxBytes = 1024 * 1024 * 1024;
  let getCount = 0;
  let resolveStaleGet: ((response: Response) => void) | undefined;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url !== `${apiBase}/api/storage/usage-ledger-retention`) throw new Error(`unexpected fetch: ${url}`);
    if ((init?.method ?? "GET") === "PUT") {
      return Promise.resolve(Response.json({ enabled: true, maxBytes, currentBytes: 1234 }));
    }
    getCount += 1;
    if (getCount === 1) return Promise.resolve(Response.json({ enabled: false, maxBytes, currentBytes: 1234 }));
    return new Promise<Response>(resolve => { resolveStaleGet = resolve; });
  }) as typeof fetch;

  await act(async () => {
    root = createRoot(host);
    root.render(createElement(LanguageProvider, null, createElement(LocaleHarness, { apiBase })));
  });
  await settleTimers();

  const localeSwitch = host.querySelector<HTMLButtonElement>("#locale-switch");
  if (!localeSwitch) throw new Error("locale switch missing");
  await act(async () => { localeSwitch.click(); });
  await settleTimers();
  expect(getCount).toBe(2);

  const toggle = host.querySelector<HTMLButtonElement>("button.switch");
  if (!toggle) throw new Error("retention switch missing");
  await act(async () => {
    toggle.click();
    await Promise.resolve();
  });
  expect(toggle.getAttribute("aria-pressed")).toBe("true");

  if (!resolveStaleGet) throw new Error("stale GET was not started");
  await act(async () => {
    resolveStaleGet(new Response("", { status: 500 }));
    await Promise.resolve();
  });
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

test("shows a custom MiB editor only when enabled and saves the edited ceiling", async () => {
  const apiBase = "http://usage-retention-custom";
  const initialMaxBytes = 768 * 1024 * 1024;
  const writes: Array<{ enabled: boolean; maxBytes: number }> = [];
  let maxBytes = initialMaxBytes;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url !== `${apiBase}/api/storage/usage-ledger-retention`) throw new Error(`unexpected fetch: ${url}`);
    if ((init?.method ?? "GET") === "PUT") {
      const body = JSON.parse(String(init?.body)) as { enabled: boolean; maxBytes: number };
      writes.push(body);
      maxBytes = body.maxBytes;
      return Response.json({ enabled: body.enabled, maxBytes, currentBytes: 1234 });
    }
    return Response.json({ enabled: true, maxBytes, currentBytes: 1234 });
  }) as typeof fetch;

  await mount(apiBase);

  const input = host.querySelector<HTMLInputElement>('input[type="number"]');
  if (!input) throw new Error("custom retention input missing");
  expect(input.value).toBe("768");
  expect(input.min).toBe("1");
  expect(host.querySelector('[aria-haspopup="listbox"]')).toBeNull();

  const increment = input.parentElement?.querySelector<HTMLButtonElement>(".ocx-stepper__btn");
  if (!increment) throw new Error("retention stepper missing");
  await act(async () => { increment.click(); });
  expect(testWindow.document.activeElement).toBe(input);
  expect(input.value).toBe("769");
  expect(writes).toEqual([]);

  const outside = testWindow.document.createElement("button") as never as HTMLButtonElement;
  outside.type = "button";
  host.appendChild(outside as never);
  await act(async () => {
    outside.focus();
    await Promise.resolve();
  });
  expect(writes).toEqual([{ enabled: true, maxBytes: 769 * 1024 * 1024 }]);

  const toggle = host.querySelector<HTMLButtonElement>("button.switch");
  if (!toggle) throw new Error("retention switch missing");
  await act(async () => {
    toggle.click();
    await Promise.resolve();
  });
  expect(host.querySelector('input[type="number"]')).toBeNull();
});

test("failed toggle keeps the last server state and surfaces an error", async () => {
  const apiBase = "http://usage-retention-failure";
  const maxBytes = 256 * 1024 * 1024;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url !== `${apiBase}/api/storage/usage-ledger-retention`) throw new Error(`unexpected fetch: ${url}`);
    if ((init?.method ?? "GET") === "PUT") return new Response("", { status: 500 });
    return Response.json({ enabled: false, maxBytes, currentBytes: 0 });
  }) as typeof fetch;

  await mount(apiBase);
  const toggle = host.querySelector<HTMLButtonElement>("button.switch");
  if (!toggle) throw new Error("retention switch missing");

  await act(async () => {
    toggle.click();
    await Promise.resolve();
  });

  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  expect(host.querySelector('[role="alert"]')?.textContent?.length).toBeGreaterThan(0);
});
