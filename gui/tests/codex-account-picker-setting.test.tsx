import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import CodexAccountPickerSetting from "../src/components/CodexAccountPickerSetting";
import { LanguageProvider } from "../src/i18n/provider";

const domGlobals = ["document", "window", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousDomGlobals: Record<(typeof domGlobals)[number], unknown>;
let testWindow: Window;
let mountedRoot: Root | null;

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
  await Promise.resolve();
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("CodexAccountPickerSetting", () => {
  beforeEach(() => {
    previousDomGlobals = Object.fromEntries(
      domGlobals.map(key => [key, Reflect.get(globalThis, key)]),
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
  });

  afterEach(async () => {
    if (mountedRoot) {
      await act(async () => { mountedRoot?.unmount(); });
      mountedRoot = null;
    }
    for (const key of domGlobals) {
      Object.defineProperty(globalThis, key, { configurable: true, value: previousDomGlobals[key] });
    }
    await testWindow.happyDOM?.close?.();
  });

  async function mount(fetchMock: typeof fetch): Promise<HTMLElement> {
    globalThis.fetch = fetchMock;
    const host = testWindow.document.createElement("div");
    testWindow.document.body.appendChild(host as never);
    const { createRoot } = await import("react-dom/client");
    await act(async () => {
      mountedRoot = createRoot(host);
      mountedRoot.render(
        <LanguageProvider>
          <CodexAccountPickerSetting apiBase="http://proxy" />
        </LanguageProvider>,
      );
    });
    await act(async () => { await flush(); });
    return host;
  }

  function toggle(host: ParentNode): HTMLButtonElement {
    const button = host.querySelector<HTMLButtonElement>("button.toggle");
    if (!button) throw new Error("toggle missing");
    return button;
  }

  test("explains exact account targeting generically and waits for effective state", async () => {
    const settings = deferred<Response>();
    const host = await mount((async () => settings.promise) as typeof fetch);

    expect(host.textContent).toContain("Target a specific Codex account from the model picker");
    expect(host.querySelector("button.toggle")).toBeNull();
    expect(host.textContent).not.toMatch(/Personal|Work/);

    await act(async () => {
      settings.resolve(response({ codexAccountPickerEnabled: true }));
      await flush();
    });
    expect(toggle(host).getAttribute("aria-pressed")).toBe("true");
    expect(host.textContent).toContain("never rotates or falls back");
    expect(host.textContent).toContain("stable privacy-safe labels");
    expect(host.textContent).toContain("Existing conversations and saved model selections continue routing");
    expect(host.textContent).toContain("Plain GPT model IDs keep their Pool or Direct behavior");
  });

  test("serializes rapid clicks and trusts the confirmed response state", async () => {
    const pendingPut = deferred<Response>();
    let puts = 0;
    const host = await mount((async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        puts += 1;
        return pendingPut.promise;
      }
      return response({ codexAccountPickerEnabled: false });
    }) as typeof fetch);

    act(() => {
      toggle(host).click();
      toggle(host).click();
    });
    expect(puts).toBe(1);
    expect(toggle(host).disabled).toBe(true);
    expect(toggle(host).getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      pendingPut.resolve(response({
        ok: true,
        codexAccountPickerEnabled: false,
        catalogRefreshPending: false,
      }));
      await flush();
    });
    expect(toggle(host).disabled).toBe(false);
    expect(toggle(host).getAttribute("aria-pressed")).toBe("false");
  });

  test("renders a saved pending refresh as an amber warning", async () => {
    const host = await mount((async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return response({
          ok: true,
          codexAccountPickerEnabled: true,
          catalogRefreshPending: true,
          privateDetail: "private-account-detail",
        });
      }
      return response({ codexAccountPickerEnabled: false });
    }) as typeof fetch);

    await act(async () => {
      toggle(host).click();
      await flush();
    });
    const warning = host.querySelector<HTMLElement>(".codex-account-picker-feedback.is-warn");
    expect(warning?.textContent).toContain("ocx sync");
    expect(warning?.getAttribute("role")).toBe("status");
    expect(host.textContent).not.toContain("private-account-detail");
  });

  test("failed saves revert the optimistic toggle and show only generic feedback", async () => {
    const host = await mount((async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return response({ error: "private server path" }, 500);
      return response({ codexAccountPickerEnabled: false });
    }) as typeof fetch);

    await act(async () => {
      toggle(host).click();
      await flush();
    });
    expect(toggle(host).getAttribute("aria-pressed")).toBe("false");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("last confirmed setting");
    expect(host.textContent).not.toContain("private server path");
  });

  test("contains an initial load failure without exposing an actionable false state", async () => {
    let shouldFail = true;
    const host = await mount((async () => {
      if (shouldFail) return response({ error: "private server path" }, 500);
      return response({ codexAccountPickerEnabled: true });
    }) as typeof fetch);

    expect(host.querySelector("button.toggle")).toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Could not load");
    expect(host.textContent).not.toContain("private server path");

    shouldFail = false;
    const retry = Array.from(host.querySelectorAll("button")).find(button =>
      button.textContent === "Retry"
    );
    expect(retry).toBeTruthy();
    await act(async () => {
      retry?.click();
      await flush();
    });
    expect(toggle(host).getAttribute("aria-pressed")).toBe("true");
  });

  test("keeps the last confirmed toggle actionable after a background refresh failure", async () => {
    let getCount = 0;
    let putCount = 0;
    let pollCallback: (() => void) | null = null;
    const originalSetInterval = testWindow.setInterval.bind(testWindow);
    testWindow.setInterval = ((callback: TimerHandler, ms?: number, ...args: unknown[]) => {
      if (typeof callback === "function") pollCallback = callback as () => void;
      return originalSetInterval(callback, ms, ...args) as number;
    }) as typeof testWindow.setInterval;
    const host = await mount((async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putCount += 1;
        return response({
          ok: true,
          codexAccountPickerEnabled: false,
          catalogRefreshPending: false,
        });
      }
      getCount += 1;
      return getCount === 1
        ? response({ codexAccountPickerEnabled: true })
        : response({ error: "temporary" }, 503);
    }) as typeof fetch);

    await act(async () => {
      pollCallback?.();
      await flush();
    });

    expect(toggle(host).getAttribute("aria-pressed")).toBe("true");
    expect(toggle(host).disabled).toBe(false);
    expect(host.textContent).toContain("Could not refresh this setting");
    expect(Array.from(host.querySelectorAll("button")).some(button => button.textContent === "Retry")).toBe(true);

    await act(async () => {
      toggle(host).click();
      await flush();
    });

    expect(putCount).toBe(1);
    expect(toggle(host).getAttribute("aria-pressed")).toBe("false");
    expect(host.textContent).not.toContain("Could not refresh this setting");
  });

  test("an older poll cannot overwrite an optimistic or confirmed mutation", async () => {
    const stalePoll = deferred<Response>();
    const pendingPut = deferred<Response>();
    let getCount = 0;
    let pollCallback: (() => void) | null = null;
    const originalSetInterval = testWindow.setInterval.bind(testWindow);
    testWindow.setInterval = ((callback: TimerHandler, ms?: number, ...args: unknown[]) => {
      if (typeof callback === "function") pollCallback = callback as () => void;
      return originalSetInterval(callback, ms, ...args) as number;
    }) as typeof testWindow.setInterval;
    const host = await mount((async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return pendingPut.promise;
      getCount += 1;
      return getCount === 1
        ? response({ codexAccountPickerEnabled: false })
        : stalePoll.promise;
    }) as typeof fetch);

    await act(async () => {
      pollCallback?.();
      await flush();
      toggle(host).click();
      await flush();
    });
    expect(toggle(host).getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      stalePoll.resolve(response({ codexAccountPickerEnabled: false }));
      await flush();
    });
    expect(toggle(host).getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      pendingPut.resolve(response({
        ok: true,
        codexAccountPickerEnabled: true,
        catalogRefreshPending: false,
      }));
      await flush();
    });
    expect(toggle(host).getAttribute("aria-pressed")).toBe("true");
  });

  function toggles(host: ParentNode): HTMLButtonElement[] {
    return Array.from(host.querySelectorAll<HTMLButtonElement>("button.toggle"));
  }

  test("hides the customize section entirely when the backend omits account options", async () => {
    const host = await mount((async () => response({ codexAccountPickerEnabled: true })) as typeof fetch);
    expect(toggles(host)).toHaveLength(1);
    expect(host.querySelector(".codex-account-picker-customize-card")).toBeNull();
    expect(host.querySelector(".codex-account-picker-models")).toBeNull();
  });

  test("reveals per-account model checkboxes only after the customize toggle is turned on", async () => {
    const options = [{ selector: "main", models: ["gpt-5.1", "gpt-5.1-codex"] }];
    const host = await mount((async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return response({
          ok: true,
          codexAccountPickerModels: {},
          codexAccountPickerOptions: options,
        });
      }
      return response({
        codexAccountPickerEnabled: true,
        codexAccountPickerModels: null,
        codexAccountPickerOptions: options,
      });
    }) as typeof fetch);

    expect(toggles(host)).toHaveLength(2);
    const [mainToggle, customizeToggle] = toggles(host);
    expect(mainToggle.getAttribute("aria-pressed")).toBe("true");
    expect(customizeToggle.getAttribute("aria-pressed")).toBe("false");
    expect(host.querySelector(".codex-account-picker-models")).toBeNull();

    await act(async () => {
      customizeToggle.click();
      await flush();
    });

    expect(toggles(host)[1]?.getAttribute("aria-pressed")).toBe("true");
    const list = host.querySelector(".codex-account-picker-models");
    expect(list).not.toBeNull();
    expect(list?.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    expect(list?.textContent).toContain("gpt-5.1");
    expect(list?.textContent).toContain("gpt-5.1-codex");
  });

  test("checking boxes never fetches; an explicit Save sends one batched PUT", async () => {
    const options = [{ selector: "main", models: ["gpt-5.1", "gpt-5.1-codex"] }];
    let putCount = 0;
    let lastPutBody: unknown = null;
    const host = await mount((async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putCount += 1;
        lastPutBody = init.body ? JSON.parse(String(init.body)) : null;
        const body = lastPutBody as { codexAccountPickerModels?: Record<string, string[]> | null };
        return response({
          ok: true,
          codexAccountPickerModels: body.codexAccountPickerModels ?? {},
          codexAccountPickerOptions: options,
        });
      }
      return response({
        codexAccountPickerEnabled: true,
        codexAccountPickerModels: {},
        codexAccountPickerOptions: options,
      });
    }) as typeof fetch);

    expect(toggles(host)[1]?.getAttribute("aria-pressed")).toBe("true");
    const checkboxes = Array.from(host.querySelectorAll<HTMLInputElement>('.codex-account-picker-models input[type="checkbox"]'));
    expect(checkboxes).toHaveLength(2);
    const saveButton = Array.from(host.querySelectorAll("button")).find(b => b.textContent === "Save");
    expect(saveButton?.disabled).toBe(true);

    act(() => { checkboxes[0]?.click(); });
    act(() => { checkboxes[1]?.click(); });
    expect(putCount).toBe(0);
    expect(saveButton?.disabled).toBe(false);

    await act(async () => {
      saveButton?.click();
      await flush();
    });

    expect(putCount).toBe(1);
    expect(lastPutBody).toEqual({ codexAccountPickerModels: { main: ["gpt-5.1", "gpt-5.1-codex"] } });
    expect(saveButton?.disabled).toBe(true);
  });

  test("turning customize off sends null and restores the prior draft if turned back on without reload", async () => {
    const options = [{ selector: "main", models: ["gpt-5.1", "gpt-5.1-codex"] }];
    const puts: unknown[] = [];
    const host = await mount((async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { codexAccountPickerModels?: Record<string, string[]> | null };
        puts.push(body.codexAccountPickerModels);
        return response({
          ok: true,
          codexAccountPickerModels: body.codexAccountPickerModels ?? null,
          codexAccountPickerOptions: options,
        });
      }
      return response({
        codexAccountPickerEnabled: true,
        codexAccountPickerModels: { main: ["gpt-5.1"] },
        codexAccountPickerOptions: options,
      });
    }) as typeof fetch);

    const customizeToggle = () => toggles(host)[1]!;
    expect(customizeToggle().getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      customizeToggle().click();
      await flush();
    });
    expect(customizeToggle().getAttribute("aria-pressed")).toBe("false");
    expect(puts.at(-1)).toBeNull();
    expect(host.querySelector(".codex-account-picker-models")).toBeNull();

    await act(async () => {
      customizeToggle().click();
      await flush();
    });
    expect(customizeToggle().getAttribute("aria-pressed")).toBe("true");
    expect(puts.at(-1)).toEqual({ main: ["gpt-5.1"] });
    const list = host.querySelector(".codex-account-picker-models");
    const checked = Array.from(list?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? []).filter(i => i.checked);
    expect(checked).toHaveLength(1);
  });

  test("a shared busy flag disables every mutating control while any save is in flight", async () => {
    const options = [{ selector: "main", models: ["gpt-5.1"] }];
    const pendingPut = deferred<Response>();
    const host = await mount((async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return pendingPut.promise;
      return response({
        codexAccountPickerEnabled: true,
        codexAccountPickerModels: {},
        codexAccountPickerOptions: options,
      });
    }) as typeof fetch);

    const [mainToggle, customizeToggle] = toggles(host);
    const checkbox = host.querySelector<HTMLInputElement>('.codex-account-picker-models input[type="checkbox"]');
    act(() => { checkbox?.click(); });
    const saveButton = Array.from(host.querySelectorAll("button")).find(b => b.textContent === "Save" || b.textContent === "Saving…");

    act(() => { saveButton?.click(); });

    expect(mainToggle?.disabled).toBe(true);
    expect(customizeToggle?.disabled).toBe(true);
    expect(host.querySelector<HTMLInputElement>('.codex-account-picker-models input[type="checkbox"]')?.disabled).toBe(true);

    await act(async () => {
      pendingPut.resolve(response({
        ok: true,
        codexAccountPickerModels: { main: ["gpt-5.1"] },
        codexAccountPickerOptions: options,
      }));
      await flush();
    });
    expect(mainToggle?.disabled).toBe(false);
  });

  test("an amber pending-refresh notice also surfaces for a customize-toggle save", async () => {
    const options = [{ selector: "main", models: ["gpt-5.1"] }];
    const host = await mount((async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return response({
          ok: true,
          codexAccountPickerModels: {},
          codexAccountPickerOptions: options,
          catalogRefreshPending: true,
        });
      }
      return response({
        codexAccountPickerEnabled: true,
        codexAccountPickerModels: null,
        codexAccountPickerOptions: options,
      });
    }) as typeof fetch);

    await act(async () => {
      toggles(host)[1]?.click();
      await flush();
    });
    const warning = host.querySelector<HTMLElement>(".codex-account-picker-feedback.is-warn");
    expect(warning).not.toBeNull();
  });

  test("a pre-save poll cannot replace the confirmed model selection", async () => {
    const stalePoll = deferred<Response>();
    let getCount = 0;
    let pollCallback: (() => void) | null = null;
    const originalSetInterval = testWindow.setInterval.bind(testWindow);
    testWindow.setInterval = ((callback: TimerHandler, ms?: number, ...args: unknown[]) => {
      if (typeof callback === "function") pollCallback = callback as () => void;
      return originalSetInterval(callback, ms, ...args) as number;
    }) as typeof testWindow.setInterval;
    const options = [{ selector: "main", models: ["gpt-5.5"] }];
    const initial = { codexAccountPickerEnabled: true, codexAccountPickerModels: {}, codexAccountPickerOptions: options };
    const host = await mount((async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return response({ ...initial, ok: true, codexAccountPickerModels: { main: ["gpt-5.5"] } });
      return ++getCount === 1 ? response(initial) : stalePoll.promise;
    }) as typeof fetch);
    await act(async () => { pollCallback?.(); await flush(); });
    const checkbox = () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => { checkbox().click(); await flush(); });
    await act(async () => {
      Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Save")!.click();
      await flush();
    });
    expect(checkbox().checked).toBe(true);
    await act(async () => { stalePoll.resolve(response(initial)); await flush(); });
    expect(checkbox().checked).toBe(true);
  });

  test("Save sends the full multi-account map, preserving selections for accounts left untouched", async () => {
    const options = [
      { selector: "main", models: ["gpt-5.1", "gpt-5.1-codex"] },
      { selector: "work", models: ["gpt-5.2", "gpt-5.2-fast"] },
    ];
    const initialModels = { main: ["gpt-5.1"], work: ["gpt-5.2"] };
    let lastPutBody: { codexAccountPickerModels?: Record<string, string[]> } | null = null;
    const host = await mount((async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        lastPutBody = JSON.parse(String(init.body)) as { codexAccountPickerModels?: Record<string, string[]> };
        return response({ ok: true, codexAccountPickerModels: lastPutBody.codexAccountPickerModels, codexAccountPickerOptions: options });
      }
      return response({ codexAccountPickerEnabled: true, codexAccountPickerModels: initialModels, codexAccountPickerOptions: options });
    }) as typeof fetch);

    const rows = Array.from(host.querySelectorAll(".codex-account-picker-account-row"));
    expect(rows).toHaveLength(2);
    const workRow = rows.find(row => row.textContent?.includes("work"))!;
    const workExtraCheckbox = Array.from(workRow.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
      .find(box => !box.checked)!;
    expect(workExtraCheckbox).toBeTruthy();

    act(() => { workExtraCheckbox.click(); });
    await act(async () => {
      Array.from(host.querySelectorAll("button")).find(b => b.textContent === "Save")!.click();
      await flush();
    });

    expect(lastPutBody).not.toBeNull();
    expect(lastPutBody?.codexAccountPickerModels).toEqual({
      main: ["gpt-5.1"],
      work: ["gpt-5.2", "gpt-5.2-fast"],
    });

    const mainRow = rows.find(row => row.textContent?.includes("main"))!;
    const mainChecked = Array.from(mainRow.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).filter(b => b.checked);
    expect(mainChecked).toHaveLength(1);
    expect(mainChecked[0]?.parentElement?.textContent).toContain("gpt-5.1");
    const workChecked = Array.from(workRow.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).filter(b => b.checked);
    expect(workChecked).toHaveLength(2);
  });

  test("a failed PUT while turning customize off restores the toggle and keeps the prior draft intact", async () => {
    const options = [{ selector: "main", models: ["gpt-5.1", "gpt-5.1-codex"] }];
    const host = await mount((async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return response({ error: "private server path" }, 500);
      return response({
        codexAccountPickerEnabled: true,
        codexAccountPickerModels: { main: ["gpt-5.1"] },
        codexAccountPickerOptions: options,
      });
    }) as typeof fetch);

    const customizeToggle = () => Array.from(host.querySelectorAll<HTMLButtonElement>("button.toggle"))[1]!;
    expect(customizeToggle().getAttribute("aria-pressed")).toBe("true");
    const checkboxBefore = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkboxBefore?.checked).toBe(true);
    act(() => { host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!.click(); });

    await act(async () => {
      customizeToggle().click();
      await flush();
    });

    expect(customizeToggle().getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector(".codex-account-picker-models")).not.toBeNull();
    const checkboxAfter = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkboxAfter?.checked).toBe(true);
    expect(host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!.checked).toBe(true);
    const errorNotice = host.querySelector<HTMLElement>(".codex-account-picker-feedback.is-err");
    expect(errorNotice).not.toBeNull();
    expect(errorNotice?.textContent).toContain("Could not update per-account model customization");
    expect(errorNotice?.textContent).not.toContain("private server path");
  });

});
