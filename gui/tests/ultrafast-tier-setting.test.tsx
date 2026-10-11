import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import UltraFastTierSetting from "../src/components/UltraFastTierSetting";
import ModelCatalogSettingsPanels from "../src/components/ModelCatalogSettingsPanels";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let dom: Window;
let root: Root | undefined;
let host: HTMLElement;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await new Promise<void>(resolve => dom.setTimeout(resolve, 0));
}

async function render(child: ReactNode): Promise<void> {
  if (!root) {
    const { createRoot } = await import("react-dom/client");
    root = createRoot(host);
  }
  await act(async () => { root!.render(<LanguageProvider>{child}</LanguageProvider>); });
  await act(flush);
}

function toggle(): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>(".codex-ultrafast-controls .toggle")!;
}

async function clickToggle(): Promise<void> {
  await act(async () => { toggle().click(); await flush(); });
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  dom = new Window({ url: "http://localhost/" });
  Object.defineProperty(dom.navigator, "language", { configurable: true, value: "en-US" });
  for (const [key, value] of Object.entries({
    document: dom.document, window: dom, navigator: dom.navigator, IS_REACT_ACT_ENVIRONMENT: true,
  })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  for (const key of globals) Object.defineProperty(globalThis, key, {
    configurable: true, writable: true, value: previous[key],
  });
  await dom.happyDOM.close();
});

describe("Ultra Fast settings", () => {
  test("is reachable beside Fast rows without selecting custom picker order", async () => {
    globalThis.fetch = (async () => response({ fastRows: true, ultraFastTier: false })) as typeof fetch;
    await render(<ModelCatalogSettingsPanels showOrderEditor={false} apiBase="http://proxy"
      active identities={[]} onAccepted={() => {}} onBusyChange={() => {}} onSaved={() => {}} />);
    expect(host.querySelector(".fast-rows-card")).not.toBeNull();
    expect(toggle().disabled).toBe(false);
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(host.textContent).toContain("It does not add Ultra Fast to the model picker");
  });

  test.each([{}, null, { ultraFastTier: "true" }, { ultraFastTier: null }])(
    "does not treat an unknown settings payload as Off: %j", async body => {
      globalThis.fetch = (async () => response(body)) as typeof fetch;
      await render(<UltraFastTierSetting apiBase="http://proxy" />);
      expect(toggle().disabled).toBe(true);
      expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not read");
      expect(host.textContent).toContain("Retry");
    },
  );

  test.each([false, true])("confirms a %s to opposite toggle by same-target GET", async initial => {
    const readback = deferred<Response>();
    const calls: { url: string; method: string; body?: BodyInit | null }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body });
      if (init?.method === "PUT") return response({ ok: true });
      return calls.length === 1 ? response({ ultraFastTier: initial }) : readback.promise;
    }) as typeof fetch;
    await render(<UltraFastTierSetting apiBase="http://selected-target" />);
    await act(async () => { toggle().click(); toggle().click(); await flush(); });
    expect(calls.map(call => call.method)).toEqual(["GET", "PUT", "GET"]);
    expect(calls.every(call => call.url === "http://selected-target/api/settings")).toBe(true);
    expect(JSON.parse(String(calls[1].body))).toEqual({ ultraFastTier: !initial });
    expect(toggle().disabled).toBe(true);
    expect(host.querySelector('[role="status"]')).toBeNull();
    await act(async () => { readback.resolve(response({ ultraFastTier: !initial })); await flush(); });
    expect(toggle().disabled).toBe(false);
    expect(toggle().getAttribute("aria-pressed")).toBe(String(!initial));
    expect(host.querySelector('[role="status"]')?.textContent).toContain(initial ? "disabled" : "enabled");
  });

  test("shows the observed state and an error when the write did not stick", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      response(init?.method === "PUT" ? { ok: true, ultraFastTier: true } : { ultraFastTier: false })
    ) as typeof fetch;
    await render(<UltraFastTierSetting apiBase="http://proxy" />);
    await clickToggle();
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not change");
  });

  test("reconciles a lost write response without inventing success", async () => {
    let stored = false;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") { stored = true; throw new TypeError("response lost"); }
      return response({ ultraFastTier: stored });
    }) as typeof fetch;
    await render(<UltraFastTierSetting apiBase="http://proxy" />);
    await clickToggle();
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
  });

  test.each(["http", "shape"])("requires retry after an unreadable save observation: %s", async failure => {
    let reads = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return response({ ok: true });
      reads++;
      if (reads === 2) return failure === "http" ? response({}, 503) : response({});
      return response({ ultraFastTier: reads > 2 });
    }) as typeof fetch;
    await render(<UltraFastTierSetting apiBase="http://proxy" />);
    await clickToggle();
    expect(toggle().disabled).toBe(true);
    expect(host.querySelector('[role="status"]')).toBeNull();
    await act(async () => {
      Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Retry")!.click();
      await flush();
    });
    expect(toggle().disabled).toBe(false);
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
  });

  test("a poll begun before the save cannot roll back the confirmed toggle", async () => {
    const oldPoll = deferred<Response>();
    let reads = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return response({ ok: true });
      reads++;
      return reads === 2 ? oldPoll.promise : response({ ultraFastTier: reads > 2 });
    }) as typeof fetch;
    await render(<UltraFastTierSetting apiBase="http://proxy" />);
    await act(async () => {
      for (const visible of [false, true]) dom.dispatchEvent(
        new dom.CustomEvent("opencodex:host-visibility", { detail: visible }),
      );
      await flush();
    });
    expect(reads).toBe(2);
    await clickToggle();
    await act(async () => { oldPoll.resolve(response({ ultraFastTier: false })); await flush(); });
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
  });

  test.each(["load", "save"])("switching targets isolates an old pending %s", async phase => {
    const old = deferred<Response>();
    const current = deferred<Response>();
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      if (String(input).startsWith("http://new")) return current.promise;
      if (phase === "load" || init?.method === "PUT") return old.promise;
      return response({ ultraFastTier: false });
    }) as typeof fetch;
    await render(<UltraFastTierSetting apiBase="http://old" />);
    if (phase === "save") await clickToggle();
    await render(<UltraFastTierSetting apiBase="http://new" />);
    expect(toggle().disabled).toBe(true);
    await act(async () => {
      old.resolve(response({ ok: true, ultraFastTier: true }));
      await flush();
    });
    expect(toggle().disabled).toBe(true);
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(calls.filter(url => url.startsWith("http://old"))).toHaveLength(phase === "load" ? 1 : 2);
    await act(async () => { current.resolve(response({ ultraFastTier: false })); await flush(); });
    expect(toggle().disabled).toBe(false);
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
  });
});
