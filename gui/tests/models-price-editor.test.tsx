import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import Models from "../src/pages/Models";
import type { ModelRow } from "../src/pages/models-shared";

type Rates = { input: number; output: number; cacheRead: number; cacheWrite: number };
type PricingPolicy = { mode: "automatic" } | { mode: "flat" }
  | { mode: "custom"; thresholdTokens: number; comparison: "gt" | "gte"; rates: Rates };
type Cost = Rates & { promptLengthPricing?: PricingPolicy };
type Mutation = { modelId: string; cost: Cost | null };
const FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const SAVED = { input: 1.25, output: 9.5, cacheRead: 0.125, cacheWrite: 2.75 };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("Models manual price editor", () => {
  const globals = [
    "document", "window", "navigator", "localStorage", "sessionStorage",
    "IS_REACT_ACT_ENVIRONMENT", "fetch", "setInterval", "clearInterval",
  ] as const;
  let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
  let testWindow: Window;
  let container: HTMLElement;
  let root: Root | null;
  let rows: ModelRow[];
  let modelCosts: Record<string, Cost>;
  let mutations: Mutation[];
  let reads: Array<{ url: string; init?: RequestInit }>;
  let catalogReads: number;
  let getFailure: boolean;
  let catalogFailure: boolean;
  let getGate: ReturnType<typeof deferred> | null;
  let putGate: ReturnType<typeof deferred> | null;
  let catalogGate: ReturnType<typeof deferred> | null;
  let getResponse: (() => Response) | null;
  let putResponse: ((body: Mutation) => Response) | null;

  beforeEach(() => {
    clearClientResourceStoresForTests();
    previousGlobals = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previousGlobals;
    testWindow = new Window({ url: "http://localhost/#models" });
    Object.defineProperties(globalThis, {
      document: { configurable: true, value: testWindow.document },
      window: { configurable: true, value: testWindow },
      navigator: { configurable: true, value: testWindow.navigator },
      localStorage: { configurable: true, value: testWindow.localStorage },
      sessionStorage: { configurable: true, value: testWindow.sessionStorage },
      IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
      setInterval: { configurable: true, value: () => 1 },
      clearInterval: { configurable: true, value: () => {} },
    });
    rows = [
      { provider: "xai-demo", id: "grok-4.6", namespaced: "xai-demo/grok-4.6", disabled: false, manualPricing: true },
      { provider: "xai-demo", id: "vendor/custom", namespaced: "xai-demo/vendor/custom", disabled: false, custom: true, customId: "custom-1" },
      { provider: "openai", id: "gpt-5.5", namespaced: "openai/gpt-5.5", disabled: false, native: true, manualPricing: true },
      { provider: "combo", id: "balanced", namespaced: "combo/balanced", disabled: false, manualPricing: true },
    ];
    const providers = [
      { name: "xai-demo", liveModels: false, models: ["grok-4.6", "vendor/custom"] },
      { name: "openai", liveModels: false, models: ["gpt-5.5"] },
    ];
    modelCosts = { "grok-4.6": { ...SAVED }, sibling: { ...FREE } };
    mutations = [];
    reads = [];
    catalogReads = 0;
    getFailure = false;
    catalogFailure = false;
    getGate = null;
    putGate = null;
    catalogGate = null;
    getResponse = null;
    putResponse = null;
    testWindow.localStorage.setItem("ocx-lang", "en");
    testWindow.localStorage.setItem("ocx-models-collapsed:v2", JSON.stringify([]));
    testWindow.sessionStorage.setItem("ocx.models.catalog.v1:http://localhost", JSON.stringify({
      models: rows, providers, selectedModels: {}, disabled: [], contextCaps: {}, contextCapValue: 350_000,
    }));
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/providers/xai-demo/model-costs")) {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as Mutation;
          mutations.push(body);
          if (putGate) await putGate.promise;
          if (body.cost === null) delete modelCosts[body.modelId];
          else modelCosts[body.modelId] = body.cost;
          rows = rows.map(row => row.provider === "xai-demo" && row.id === body.modelId
            ? { ...row, manualPricing: body.cost !== null } : row);
          return putResponse ? putResponse(body) : Response.json({ ok: true, provider: "xai-demo", ...body });
        }
        reads.push({ url, init });
        if (getGate) await getGate.promise;
        if (getFailure) return Response.json({ error: "unavailable" }, { status: 503 });
        return getResponse ? getResponse() : Response.json({ provider: "xai-demo", modelCosts });
      }
      if (url.endsWith("/api/models")) {
        catalogReads++;
        if (catalogGate) await catalogGate.promise;
        if (catalogFailure) return Response.json({ error: "unavailable" }, { status: 503 });
        return Response.json(rows);
      }
      if (url.endsWith("/api/providers")) return Response.json(providers);
      if (url.endsWith("/api/selected-models")) return Response.json({ selected: {} });
      if (url.endsWith("/api/provider-context-caps")) return Response.json({ caps: {} });
      if (url.endsWith("/api/aliases")) return Response.json({ providers: {}, models: {}, defaults: { global: false, providers: {} } });
      if (url.endsWith("/api/combos")) return Response.json({ combos: [] });
      if (url.endsWith("/api/shadow-call-settings")) return Response.json({ enabled: false, model: "" });
      if (url.endsWith("/api/v2")) return Response.json({ enabled: false, agentsMaxThreadsConflict: false, multiAgentMode: "default" });
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    container = testWindow.document.createElement("div");
    testWindow.document.body.appendChild(container as never);
    root = null;
  });

  afterEach(async () => {
    clearClientResourceStoresForTests();
    if (root) await act(async () => root!.unmount());
    getGate?.resolve();
    putGate?.resolve();
    catalogGate?.resolve();
    testWindow.close();
    for (const key of globals) {
      const descriptor = previousGlobals[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  async function flush() {
    await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 0)); });
  }

  async function mount() {
    const { createRoot } = await import("react-dom/client");
    await act(async () => {
      root = createRoot(container);
      root.render(<LanguageProvider><Models apiBase="http://localhost" /></LanguageProvider>);
    });
    await flush();
  }

  function trigger(model = "xai-demo/grok-4.6"): HTMLButtonElement {
    return container.querySelector<HTMLButtonElement>(`[aria-label="Edit price for ${model}"]`)!;
  }

  function inputs(): HTMLInputElement[] {
    return [...container.querySelectorAll<HTMLInputElement>('dialog input[type="number"]')];
  }

  function button(label: string): HTMLButtonElement {
    return [...container.querySelectorAll<HTMLButtonElement>("dialog button")].find(node => node.textContent === label)!;
  }

  async function click(label: string) {
    await act(async () => button(label).click());
    await flush();
  }

  async function open(model?: string) {
    await act(async () => trigger(model).click());
    await flush();
  }

  async function fill(values: string[], offset = 0) {
    for (const [relativeIndex, value] of values.entries()) {
      await act(async () => {
        const input = inputs()[offset + relativeIndex]!;
        Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
      });
    }
  }

  async function chooseMode(mode: "automatic" | "flat" | "custom") {
    await act(async () => {
      container.querySelector<HTMLInputElement>(`dialog input[type="radio"][value="${mode}"]`)!.click();
    });
    await flush();
  }

  async function chooseComparison(value: "gt" | "gte") {
    await act(async () => container.querySelector<HTMLButtonElement>('dialog [role="combobox"]')!.click());
    await flush();
    const label = value === "gt" ? "Greater than (>)" : "Greater than or equal to";
    await act(async () => [...testWindow.document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find(option => option.textContent?.includes(label))!.click());
    await flush();
  }

  test("real routed and custom rows expose Price; badges use manualPricing and exclude native/combo aliases", async () => {
    await mount();
    expect(container.querySelectorAll('[aria-label^="Edit price for "]')).toHaveLength(2);
    expect(trigger("openai/gpt-5.5")).toBeNull();
    expect(trigger("combo/balanced")).toBeNull();
    expect(trigger().closest(".models-model-row")!.textContent).toContain("Manual price");
    expect(trigger("xai-demo/vendor/custom").closest(".models-model-row")!.textContent).not.toContain("Manual price");
    expect(reads).toHaveLength(0);
  });

  test("opening loads exact fresh rates, focuses input, and closing aborts a pending read", async () => {
    await mount();
    await open();
    expect(inputs().map(input => input.value)).toEqual(["1.25", "9.5", "0.125", "2.75"]);
    expect(testWindow.document.activeElement).toBe(inputs()[0]);
    expect(reads[0]!.init?.cache).toBe("no-store");
    await click("Cancel");
    expect(testWindow.document.activeElement).toBe(trigger());

    modelCosts["grok-4.6"] = { input: 3, output: 7, cacheRead: 2, cacheWrite: 4 };
    await open();
    expect(inputs().map(input => input.value)).toEqual(["3", "7", "2", "4"]);
    await click("Cancel");
    getGate = deferred();
    await open();
    expect(inputs().every(input => input.disabled)).toBe(true);
    expect(button("Save").disabled).toBe(true);
    const signal = reads.at(-1)!.init!.signal!;
    await act(async () => container.querySelector("dialog")!.dispatchEvent(new testWindow.Event("cancel", { cancelable: true })));
    expect(signal.aborted).toBe(true);
    expect(container.querySelector("dialog")).toBeNull();
    await act(async () => getGate!.resolve());
    expect(container.querySelector("dialog")).toBeNull();
  });

  test("missing override starts empty; explicit free saves exact slash-containing ID, refreshes, then closes", async () => {
    await mount();
    await open("xai-demo/vendor/custom");
    expect(inputs().map(input => input.value)).toEqual(["", "", "", ""]);
    expect(button("Reset to automatic").disabled).toBe(true);
    await click("Save");
    expect(mutations).toHaveLength(0);
    expect(container.querySelector('dialog [role="alert"]')!.textContent).toContain("Enter input and output rates");
    await fill(["0", "0"]);
    expect(inputs().map(input => input.value)).toEqual(["0", "0", "0", "0"]);
    const before = catalogReads;
    catalogGate = deferred();
    await click("Save");
    expect(mutations).toEqual([{ modelId: "vendor/custom", cost: FREE }]);
    expect(catalogReads).toBeGreaterThan(before);
    expect(container.querySelector("dialog")).not.toBeNull();
    expect(button("Cancel").disabled).toBe(true);
    await act(async () => catalogGate!.resolve());
    await flush();
    expect(container.querySelector("dialog")).toBeNull();
    expect(trigger("xai-demo/vendor/custom").closest(".models-model-row")!.textContent).toContain("Manual price");
    await open("xai-demo/vendor/custom");
    expect(inputs().map(input => input.value)).toEqual(["0", "0", "0", "0"]);
    expect(button("Reset to automatic").disabled).toBe(false);
  });

  test("reset sends null and refresh removes the badge without changing sibling rates", async () => {
    await mount();
    await open();
    await click("Reset to automatic");
    expect(mutations).toEqual([{ modelId: "grok-4.6", cost: null }]);
    expect(modelCosts.sibling).toEqual(FREE);
    expect(trigger().closest(".models-model-row")!.textContent).not.toContain("Manual price");
    await open();
    expect(inputs().map(input => input.value)).toEqual(["", "", "", ""]);
  });

  test("finite bounds are enforced and the maximum with fractional cache rates is accepted", async () => {
    await mount();
    await open();
    for (const invalid of ["-1", "1000001", ""]) {
      await fill([invalid]);
      await click("Save");
      expect(mutations).toHaveLength(0);
      expect(container.querySelector('dialog [role="alert"]')!.textContent).toContain("finite number");
    }
    await fill(["1000000", "0", "0.000001", "0.5"]);
    await click("Save");
    expect(mutations).toEqual([{ modelId: "grok-4.6", cost: {
      input: 1000000, output: 0, cacheRead: 0.000001, cacheWrite: 0.5,
    } }]);
  });

  test("unparseable cache text is rejected instead of saving as a blank zero rate", async () => {
    await mount();
    await open();
    await fill(["2", "3", "", "0"]);
    const cacheRead = inputs()[2]!;
    // Browsers report value "" plus validity.badInput for text like "1e" in a number input.
    Object.defineProperty(cacheRead, "validity", { configurable: true, value: { badInput: true } });
    await click("Save");
    expect(mutations).toHaveLength(0);
    expect(cacheRead.getAttribute("aria-invalid")).toBe("true");
    expect(container.querySelector('dialog [role="alert"]')).not.toBeNull();
  });

  test("flat mode persists and reopens; automatic mode keeps the manually entered base rates", async () => {
    await mount();
    await open();
    await fill(["2", "3", "0", "0"]);
    await chooseMode("flat");
    await click("Save");
    expect(mutations[0]).toEqual({ modelId: "grok-4.6", cost: {
      input: 2, output: 3, cacheRead: 0, cacheWrite: 0, promptLengthPricing: { mode: "flat" },
    } });

    await open();
    expect(container.querySelector<HTMLInputElement>('dialog input[type="radio"][value="flat"]')!.checked).toBe(true);
    expect(inputs().slice(0, 4).map(input => input.value)).toEqual(["2", "3", "0", "0"]);
    await chooseMode("automatic");
    await click("Save");
    expect(mutations[1]!.cost).toEqual({
      input: 2, output: 3, cacheRead: 0, cacheWrite: 0,
    });
    await open();
    expect(container.querySelector<HTMLInputElement>('dialog input[type="radio"][value="automatic"]')!.checked).toBe(true);
  });

  test("custom threshold pricing preserves draft across unsaved mode toggles and reopens exact saved policy", async () => {
    await mount();
    await open();
    await fill(["1", "2", "3", "4"]);
    await chooseMode("custom");
    expect(container.textContent).toContain("Uses the catalog prompt-length rules with the base rates above.");
    expect(container.textContent).toContain("Prompt length includes cached input and excludes output.");
    await fill(["1000", "0", "5", "0", "7"], 4);
    await chooseComparison("gte");
    await chooseMode("flat");
    await chooseMode("custom");
    expect(inputs().slice(4).map(input => input.value)).toEqual(["1000", "0", "5", "0", "7"]);
    await click("Save");
    expect(mutations[0]!.cost).toEqual({
      input: 1, output: 2, cacheRead: 3, cacheWrite: 4,
      promptLengthPricing: {
        mode: "custom", thresholdTokens: 1000, comparison: "gte",
        rates: { input: 0, output: 5, cacheRead: 0, cacheWrite: 7 },
      },
    });
    await open();
    expect(container.querySelector<HTMLInputElement>('dialog input[type="radio"][value="custom"]')!.checked).toBe(true);
    expect(container.textContent).toContain("Uses the catalog prompt-length rules with the base rates above.");
    expect(inputs().slice(4).map(input => input.value)).toEqual(["1000", "0", "5", "0", "7"]);
    expect(container.querySelector<HTMLButtonElement>('dialog [role="combobox"]')!.textContent).toContain("Greater than or equal to");
    await click("Reset to automatic");
    expect(mutations[1]).toEqual({ modelId: "grok-4.6", cost: null });
    await open();
    expect(container.querySelector<HTMLInputElement>('dialog input[type="radio"][value="automatic"]')!.checked).toBe(true);
    expect(inputs().map(input => input.value)).toEqual(["", "", "", ""]);
  });

  test("custom mode rejects nonpositive, unsafe, fractional thresholds and incomplete or out-of-range rates", async () => {
    await mount();
    await open();
    await chooseMode("custom");
    await fill(["1", "2", "3", "4", "0", "1", "2", "3", "4"]);
    await click("Save");
    expect(mutations).toHaveLength(0);
    expect(container.querySelector('dialog [role="alert"]')!.textContent).toContain("positive safe-integer");
    expect(inputs()[4]!.getAttribute("aria-invalid")).toBe("true");

    for (const threshold of ["1.5", "9007199254740992"]) {
      await fill(["1", "2", "3", "4", threshold, "1", "2", "3", "4"]);
      await click("Save");
      expect(mutations).toHaveLength(0);
    }
    await fill(["1", "2", "3", "4", "10", "1", "1000001", "3", "4"]);
    await click("Save");
    expect(mutations).toHaveLength(0);
    await fill(["1", "2", "3", "4", "10", "0", "0", "0", "0"]);
    await click("Save");
    expect(mutations[0]!.cost).toMatchObject({ promptLengthPricing: {
      mode: "custom", thresholdTokens: 10, rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } });
  });

  test("a receipt with matching base rates but a different prompt-length policy requires recovery", async () => {
    await mount();
    await open();
    await fill(["1", "2", "3", "4"]);
    await chooseMode("custom");
    await fill(["100", "5", "6", "7", "8"], 4);
    putResponse = body => Response.json({ ok: true, provider: "xai-demo", modelId: body.modelId,
      cost: { ...body.cost, promptLengthPricing: { mode: "flat" } },
    });
    await click("Save");
    expect(inputs().every(input => input.disabled)).toBe(true);
    expect(container.querySelector('dialog [role="alert"]')!.textContent).toContain("may have changed");
    putResponse = null;
    await click("Reload price");
    expect(container.querySelector<HTMLInputElement>('dialog input[type="radio"][value="custom"]')!.checked).toBe(true);
    expect(inputs().slice(4).map(input => input.value)).toEqual(["100", "5", "6", "7", "8"]);
    expect(mutations).toHaveLength(1);
  });

  test("GET and PUT receipts reject extra keys in cost and every prompt-length pricing shape", async () => {
    await mount();
    const malformedPolicies = [
      { mode: "flat", thresholdTokens: 100, rates: SAVED },
      { mode: "automatic", extra: true },
      { mode: "custom", thresholdTokens: 100, comparison: "gt", rates: SAVED, extra: true },
      { mode: "custom", thresholdTokens: 100, comparison: "gt", rates: { ...SAVED, extra: 1 } },
    ];
    for (const policy of malformedPolicies) {
      getResponse = () => Response.json({ provider: "xai-demo", modelCosts: {
        "grok-4.6": { ...SAVED, promptLengthPricing: policy },
      } });
      await open();
      expect(inputs().every(input => input.disabled)).toBe(true);
      await click("Cancel");
    }
    getResponse = () => Response.json({ provider: "xai-demo", modelCosts: {
      "grok-4.6": { ...SAVED, unexpected: true },
    } });
    await open();
    expect(inputs().every(input => input.disabled)).toBe(true);
    await click("Cancel");
    getResponse = null;

    const malformedReceipts: Array<{ mode: "flat" | "custom"; receipt: (cost: Cost) => unknown }> = [
      { mode: "flat", receipt: cost => ({ ...cost, promptLengthPricing: { mode: "flat", thresholdTokens: 100, rates: SAVED } }) },
      { mode: "flat", receipt: cost => ({ ...cost, promptLengthPricing: { mode: "flat", extra: true } }) },
      { mode: "custom", receipt: cost => ({ ...cost, promptLengthPricing: { ...cost.promptLengthPricing, extra: true } }) },
      { mode: "custom", receipt: cost => ({ ...cost, promptLengthPricing: {
        ...cost.promptLengthPricing,
        rates: { ...(cost.promptLengthPricing?.mode === "custom" ? cost.promptLengthPricing.rates : SAVED), extra: 1 },
      } }) },
      { mode: "flat", receipt: cost => ({ ...cost, unexpected: true }) },
    ];
    for (const malformed of malformedReceipts) {
      await open();
      await fill(["2", "3", "0", "0"]);
      await chooseMode(malformed.mode);
      if (malformed.mode === "custom") await fill(["100", "5", "6", "7", "8"], 4);
      putResponse = body => Response.json({ ok: true, provider: "xai-demo", modelId: body.modelId,
        cost: body.cost && malformed.receipt(body.cost),
      });
      await click("Save");
      expect(inputs().every(input => input.disabled)).toBe(true);
      await click("Reload price");
      expect(container.querySelector<HTMLInputElement>(`dialog input[type="radio"][value="${malformed.mode}"]`)!.checked).toBe(true);
      await click("Cancel");
    }
  });

  test("failed initial reads keep editing locked until a successful reload", async () => {
    getFailure = true;
    await mount();
    await open();
    expect(inputs().every(input => input.disabled)).toBe(true);
    expect(container.querySelector('dialog [role="alert"]')!.textContent).toContain("Could not load");
    expect(testWindow.document.activeElement).toBe(button("Reload price"));
    await click("Reload price");
    expect(mutations).toHaveLength(0);
    expect(inputs()[0]!.disabled).toBe(true);
    getFailure = false;
    await click("Reload price");
    expect(inputs()[0]!.value).toBe("1.25");
    expect(inputs()[0]!.disabled).toBe(false);
  });

  for (const failure of ["transport", "malformed", "wrong identity", "wrong cost", "http"] as const) {
    test(`${failure} mutation outcome requires read recovery before new edits`, async () => {
      await mount();
      await open();
      putResponse = body => {
        if (failure === "transport") throw new TypeError("connection dropped");
        if (failure === "malformed") return new Response("{", { status: 200 });
        if (failure === "http") return Response.json({ error: "failed" }, { status: 503 });
        return Response.json({ ok: true, provider: "xai-demo", ...body,
          ...(failure === "wrong identity" ? { modelId: "other" } : { cost: SAVED }),
        });
      };
      await fill(["0", "0", "0", "0"]);
      await click("Save");
      expect(mutations).toHaveLength(1);
      expect(inputs().every(input => input.disabled)).toBe(true);
      expect(button("Reset to automatic").disabled).toBe(true);
      expect(container.querySelector('dialog [role="alert"]')!.textContent).toContain("may have changed");
      await act(async () => button("Reset to automatic").dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true })));
      expect(mutations).toHaveLength(1);
      getFailure = true;
      await click("Reload price");
      expect(mutations).toHaveLength(1);
      expect(inputs()[0]!.disabled).toBe(true);
      expect(container.querySelector('dialog [role="alert"]')!.textContent).toContain("Editing stays locked");
      getFailure = false;
      await click("Reload price");
      expect(inputs().map(input => input.value)).toEqual(["0", "0", "0", "0"]);
      expect(inputs()[0]!.disabled).toBe(false);
      expect(container.textContent).toContain("may still change it");
      expect(mutations).toHaveLength(1);
      putResponse = null;
      await fill(["2", "3"]);
      await click("Save");
      expect(mutations[1]).toEqual({ modelId: "grok-4.6", cost: {
        input: 2, output: 3, cacheRead: 0, cacheWrite: 0,
      } });
      expect(container.querySelector("dialog")).toBeNull();
    });
  }

  test("malformed GET cost or provider is never treated as an empty override", async () => {
    await mount();
    for (const payload of [
      { provider: "other", modelCosts },
      { provider: "xai-demo", modelCosts: { "grok-4.6": { ...SAVED, input: -1 } } },
      { provider: "xai-demo", modelCosts: { "grok-4.6": { input: 1, output: 2 } } },
      { provider: "xai-demo", modelCosts: { "grok-4.6": { ...SAVED, promptLengthPricing: { mode: "custom", thresholdTokens: 0, comparison: "gt", rates: SAVED } } } },
      { provider: "xai-demo", modelCosts: [] },
    ]) {
      getResponse = () => Response.json(payload);
      await open();
      expect(inputs().every(input => input.disabled)).toBe(true);
      expect(button("Reset to automatic").disabled).toBe(true);
      await click("Cancel");
    }
    expect(mutations).toHaveLength(0);
  });

  test("a reset with a lost receipt recovers empty rates without replaying the reset", async () => {
    await mount();
    await open();
    putResponse = () => { throw new TypeError("receipt lost"); };
    await click("Reset to automatic");
    expect(inputs()[0]!.disabled).toBe(true);
    await click("Reload price");
    expect(inputs().map(input => input.value)).toEqual(["", "", "", ""]);
    expect(inputs()[0]!.disabled).toBe(false);
    expect(button("Reset to automatic").disabled).toBe(true);
    expect(mutations).toEqual([{ modelId: "grok-4.6", cost: null }]);
  });

  test("the mutation deadline unlocks cancellation but requires a fresh read before editing", async () => {
    await mount();
    await open();
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
    const deadline = new AbortController();
    const timeoutBudgets: number[] = [];
    const transport = globalThis.fetch;
    let pendingSignal: AbortSignal | null | undefined;
    try {
      Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: (ms: number) => {
        timeoutBudgets.push(ms);
        return deadline.signal;
      } });
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PUT" && String(input).endsWith("/model-costs")) {
          pendingSignal = init.signal;
          return new Promise<Response>((_resolve, reject) => {
            init.signal!.addEventListener("abort", () => reject(new Error("request deadline")), { once: true });
          });
        }
        return transport(input, init);
      }) as typeof fetch;
      await click("Save");
      expect(button("Cancel").disabled).toBe(true);
      expect(timeoutBudgets).toEqual([60_000]);
      await act(async () => deadline.abort());
      await flush();
      expect(pendingSignal?.aborted).toBe(true);
      expect(button("Cancel").disabled).toBe(false);
      expect(inputs().every(input => input.disabled)).toBe(true);
      expect(button("Reload price").disabled).toBe(false);
    } finally {
      globalThis.fetch = transport;
      if (descriptor) Object.defineProperty(AbortSignal, "timeout", descriptor);
      else Reflect.deleteProperty(AbortSignal, "timeout");
    }
    await click("Reload price");
    expect(inputs()[0]!.disabled).toBe(false);
    expect(reads).toHaveLength(2);
  });

  test("confirmed receipt survives repeated failed catalog refreshes and retries never PUT again", async () => {
    await mount();
    await open();
    catalogFailure = true;
    await click("Reset to automatic");
    expect(mutations).toHaveLength(1);
    expect(inputs().every(input => input.disabled)).toBe(true);
    expect(container.querySelector('dialog [role="alert"]')!.textContent).toContain("price was saved");
    await click("Refresh list");
    expect(mutations).toHaveLength(1);
    expect(container.querySelector('dialog [role="alert"]')!.textContent).toContain("price was saved");
    expect(reads).toHaveLength(1);
    catalogFailure = false;
    await click("Refresh list");
    expect(mutations).toEqual([{ modelId: "grok-4.6", cost: null }]);
    expect(container.querySelector("dialog")).toBeNull();
  });

  test("pending mutations reject duplicate submit and dismissal", async () => {
    await mount();
    await open();
    putGate = deferred();
    await click("Save");
    await act(async () => {
      container.querySelector("dialog form")!.dispatchEvent(new testWindow.Event("submit", { bubbles: true, cancelable: true }));
      container.querySelector("dialog")!.dispatchEvent(new testWindow.Event("cancel", { cancelable: true }));
      button("Cancel").dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }));
    });
    expect(mutations).toHaveLength(1);
    expect(container.querySelector("dialog")).not.toBeNull();
    expect(inputs().every(input => input.disabled)).toBe(true);
    await act(async () => putGate!.resolve());
    await flush();
    expect(container.querySelector("dialog")).toBeNull();
  });
});
