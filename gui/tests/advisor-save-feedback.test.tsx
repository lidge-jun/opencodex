import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { AdvisorEditor, type AdvisorSettings } from "../src/pages/Advisor";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { advisorModelValues } from "../src/advisor-models";
import { AdvisorActivityTable } from "../src/pages/advisor/AdvisorActivity";
import { renderToStaticMarkup } from "react-dom/server";

const globals = [
  "document",
  "window",
  "navigator",
  "localStorage",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

const initialSettings: AdvisorSettings = {
  enabled: true,
  model: "expert/gpt-6-astra",
  effort: "medium",
  policy: "manual",
  timeoutMs: 5000,
  contextSharingConsent: "v1",
};

beforeEach(() => {
  clearClientResourceStoresForTests();
  previousGlobals = Object.fromEntries(
    globals.map(key => [key, Reflect.get(globalThis, key)]),
  ) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#advisor" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  clearClientResourceStoresForTests();
  globalThis.fetch = originalFetch;
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

const catalogValues = ["expert/gpt-first", "expert/gpt-second", "expert/model-1", "expert/model-2", "expert/gpt-unmount",
  "gpt-6-astra", "devin/swe-2", "personal/gpt-6-astra", "combo/review", "custom/vendor-model"];

async function mountEditor(initial = initialSettings, loadCatalog: () => Response | Promise<Response> = () =>
  Response.json(catalogValues.map(namespaced => ({ namespaced }))),
): Promise<{ root: Root; container: HTMLElement }> {
  const saveFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    String(input).endsWith("/api/models") ? Promise.resolve(loadCatalog()) : saveFetch(input, init)) as typeof fetch;
  const container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.append(container as never);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <AdvisorEditor apiBase="http://localhost:3000" initial={initial} />
      </LanguageProvider>,
    );
  });
  return { root, container };
}

async function setModel(container: HTMLElement, value: string): Promise<void> {
  const trigger = container.querySelector<HTMLButtonElement>("#advisor-model")!;
  expect(trigger).toBeTruthy();
  await act(async () => { trigger.click(); });
  const option = [...testWindow.document.querySelectorAll<HTMLButtonElement>("[role=option]")]
    .find(item => value === "" ? item.textContent === "Clear model" : item.textContent === value);
  expect(option).toBeTruthy();
  await act(async () => {
    option!.click();
  });
}

async function clickSave(container: HTMLElement): Promise<void> {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button.btn")]
    .find(item => item.textContent === "Save advisor settings")!;
  expect(button).toBeTruthy();
  await act(async () => {
    button.click();
    // Allow the microtask queue to run for async save
    await new Promise(r => setTimeout(r, 0));
  });
}

test("adaptive policy exposes and saves the server-enforced task allowance", async () => {
  let submitted: unknown;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    submitted = JSON.parse(String(init?.body));
    return Response.json({ settings: submitted, runnable: true });
  }) as typeof fetch;
  const { root, container } = await mountEditor({ ...initialSettings, policy: "adaptive", maxConsultationsPerTask: 3 });
  const label = [...container.querySelectorAll("label")]
    .find(item => item.textContent === "Consultations per task");
  const limit = label?.control as HTMLSelectElement;
  expect(limit).toBeTruthy();
  expect(limit.tagName).toBe("SELECT");
  await act(async () => { limit.value = "2"; limit.dispatchEvent(new testWindow.Event("change", { bubbles: true })); });
  await clickSave(container);
  expect(submitted).toMatchObject({ policy: "adaptive", maxConsultationsPerTask: 2, contextSharingConsent: "v1" });
  await act(async () => root.unmount());
});

test("activity distinguishes requested, mapped, and unreported reasoning and usage", () => {
  const html = renderToStaticMarkup(<LanguageProvider><AdvisorActivityTable entries={[
    { id: "known", startedAt: 1000, trigger: "repair_failure", workerModel: "worker", advisorModel: "expert", requestedEffort: "max", effectiveEffort: "high", status: "ok", durationMs: 45, usage: { inputTokens: 10, outputTokens: 3 } },
    { id: "unknown", startedAt: 1001, trigger: "manual", workerModel: "worker", advisorModel: "expert", requestedEffort: "max", effectiveEffort: null, status: "failed", durationMs: 20 },
    { id: "capped", startedAt: 1002, trigger: "manual", workerModel: "worker", advisorModel: "expert", requestedEffort: "max", effectiveEffort: null, status: "blocked", durationMs: 0 },
  ]} /></LanguageProvider>);
  expect(html).toContain("Repair failed again");
  expect(html).toContain("max → high");
  expect(html).toContain("max → unreported");
  expect(html).toContain("Advice returned");
  expect(html).toContain("Failed");
  expect(html).toContain("Blocked");
  expect(html).not.toContain("Budget blocked");
});

test("Case 1: a new save clears previous success feedback and fails with only error notice visible", async () => {
  let saveCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/advisor/settings") && init?.method === "PUT") {
      saveCount += 1;
      if (saveCount === 1) {
        return new Response(
          JSON.stringify({
            settings: { ...initialSettings, model: "expert/gpt-first" },
            runnable: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ error: { message: "Simulated save failure" } }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const { root, container } = await mountEditor();

  // Save 1: succeeds
  await setModel(container, "expert/gpt-first");
  await clickSave(container);

  expect(container.querySelector(".notice-ok")?.textContent).toContain("Advisor settings saved.");
  expect(container.querySelector(".notice-err")).toBeNull();

  // Save 2: started before 2500ms and fails
  await setModel(container, "expert/gpt-second");
  await clickSave(container);

  // Success notice must be cleared immediately when save 2 starts; only error notice visible
  expect(container.querySelector(".notice-ok")).toBeNull();
  expect(container.querySelector(".notice-err")?.textContent).toContain("Simulated save failure");

  await act(async () => {
    root.unmount();
  });
});

test("Case 2: a second save before timer 1 expires cancels timer 1 and keeps its own feedback active", async () => {
  let currentModel = initialSettings.model;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/advisor/settings") && init?.method === "PUT") {
      const parsed = JSON.parse(init.body as string);
      currentModel = parsed.model;
      return new Response(
        JSON.stringify({
          settings: { ...initialSettings, model: currentModel },
          runnable: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const { root, container } = await mountEditor();

  // Save 1 at t=0
  await setModel(container, "expert/model-1");
  await clickSave(container);
  expect(container.querySelector(".notice-ok")?.textContent).toContain("Advisor settings saved.");

  // Advance 1000ms
  await act(async () => {
    await new Promise(r => setTimeout(r, 1000));
  });
  expect(container.querySelector(".notice-ok")).not.toBeNull();

  // Save 2 at t=1000ms
  await setModel(container, "expert/model-2");
  await clickSave(container);
  expect(container.querySelector(".notice-ok")?.textContent).toContain("Advisor settings saved.");

  // Advance 1600ms (total elapsed 2600ms; timer 1 would have expired at 2500ms)
  await act(async () => {
    await new Promise(r => setTimeout(r, 1600));
  });
  // Timer 1 must NOT have cleared save 2's feedback!
  expect(container.querySelector(".notice-ok")?.textContent).toContain("Advisor settings saved.");

  // Advance another 1000ms (total elapsed from save 2 is 2600ms > 2500ms)
  await act(async () => {
    await new Promise(r => setTimeout(r, 1000));
  });
  // Now timer 2 has expired and notice is cleared
  expect(container.querySelector(".notice-ok")).toBeNull();

  await act(async () => {
    root.unmount();
  });
});

test("Case 3: component unmount with a pending timer cleans up without post-unmount effects", async () => {
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        settings: { ...initialSettings, model: "expert/gpt-unmount" },
        runnable: true,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  const { root, container } = await mountEditor();

  await setModel(container, "expert/gpt-unmount");
  await clickSave(container);
  expect(container.querySelector(".notice-ok")).not.toBeNull();

  // Unmount while 2500ms timer is pending
  await act(async () => {
    root.unmount();
  });

  // Advance time past the 2500ms timeout
  await act(async () => {
    await new Promise(r => setTimeout(r, 2600));
  });

  // No error thrown and unmount cleanup succeeded
});

test("catalog selection saves exact native, provider, account, combo and custom identifiers and can clear", async () => {
  const submitted: AdvisorSettings[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const settings = JSON.parse(init!.body as string) as AdvisorSettings;
    submitted.push(settings);
    return Response.json({ settings, runnable: !!settings.model });
  }) as typeof fetch;
  const { root, container } = await mountEditor();
  expect(container.querySelector('input[type="text"]')).toBeNull();
  for (const value of ["gpt-6-astra", "devin/swe-2", "personal/gpt-6-astra", "combo/review", "custom/vendor-model", ""]) {
    await setModel(container, value);
    await clickSave(container);
    expect(submitted.at(-1)).toEqual({ ...initialSettings, model: value });
  }
  await act(async () => root.unmount());
});

test("unlisted saved identifier survives catalog load and unrelated setting save", async () => {
  let submitted: AdvisorSettings | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    submitted = JSON.parse(init!.body as string);
    return Response.json({ settings: submitted, runnable: true });
  }) as typeof fetch;
  const initial = { ...initialSettings, model: "Gpt-6-Astra" };
  const { root, container } = await mountEditor(initial);
  expect(container.querySelector("#advisor-model")?.textContent).toContain(initial.model);
  expect(container.textContent).toContain("saved identifier is preserved");
  expect(submitted).toBeUndefined();
  await act(async () => {
    const policy = container.querySelector<HTMLSelectElement>("#advisor-policy")!;
    policy.value = "preflight";
    policy.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
  });
  await clickSave(container);
  expect(submitted).toEqual({ ...initial, policy: "preflight" });
  await act(async () => root.unmount());
});

test("catalog failure preserves current selection and retry loads canonical choices", async () => {
  let attempts = 0;
  const { root, container } = await mountEditor(initialSettings, () => {
    attempts++;
    return attempts === 1 ? new Response(null, { status: 503 }) : Response.json([{ namespaced: "gpt-6-astra" }]);
  });
  expect(container.textContent).toContain("Could not load models");
  expect(container.textContent).not.toContain("saved identifier is preserved");
  expect(container.querySelector("#advisor-model")?.textContent).toContain(initialSettings.model);
  await act(async () => {
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Retry")!.click();
  });
  expect(attempts).toBe(2);
  expect(container.textContent).not.toContain("Could not load models");
  await setModel(container, "gpt-6-astra");
  expect(container.querySelector("#advisor-model")?.textContent).toBe("gpt-6-astra");
  await act(async () => root.unmount());
});

test("disabled and pending rows are excluded without guessing eligibility from model names", () => {
  expect(advisorModelValues([
    { namespaced: "gpt-6-astra" }, { namespaced: "gpt-6-astra" },
    { namespaced: "disabled/model", disabled: true },
    { namespaced: "pending/model", initialSelectionPending: true },
    { namespaced: "provider/image-named-text-model" },
  ])).toEqual(["gpt-6-astra", "provider/image-named-text-model"]);
});

test("empty catalog keeps the saved value and exposes retry and clear", async () => {
  const { root, container } = await mountEditor(initialSettings, () => Response.json([]));
  expect(container.textContent).toContain("No selectable models");
  expect(container.querySelector("#advisor-model")?.textContent).toContain(initialSettings.model);
  await setModel(container, "");
  expect(container.querySelector("#advisor-model")?.textContent).toBe("Clear model");
  await act(async () => root.unmount());
});

test("cold catalog loading disables selection without replacing the saved identifier", async () => {
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>(done => { resolve = done; });
  const { root, container } = await mountEditor(initialSettings, () => pending);
  expect(container.querySelector<HTMLButtonElement>("#advisor-model")?.disabled).toBe(true);
  expect(container.querySelector("#advisor-model")?.textContent).toContain(initialSettings.model);
  await act(async () => {
    const policy = container.querySelector<HTMLSelectElement>("#advisor-policy")!;
    policy.value = "preflight";
    policy.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
  });
  await act(async () => { resolve(Response.json([{ namespaced: "gpt-6-astra" }])); });
  expect(container.querySelector<HTMLButtonElement>("#advisor-model")?.disabled).toBe(false);
  expect(container.querySelector("#advisor-model")?.textContent).toContain(initialSettings.model);
  expect(container.querySelector<HTMLSelectElement>("#advisor-policy")?.value).toBe("preflight");
  await act(async () => root.unmount());
});

test("malformed catalog is a load error and preserves the current identifier", async () => {
  const { root, container } = await mountEditor(initialSettings, () => Response.json({ models: [] }));
  expect(container.textContent).toContain("Could not load models");
  expect(container.querySelector("#advisor-model")?.textContent).toContain(initialSettings.model);
  await act(async () => root.unmount());
});
