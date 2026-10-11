import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import Combos from "../src/pages/Combos";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests, invalidateClientResource } from "../src/client-resource";
import { readSessionListCacheEntry, writeSessionListCacheEntry } from "../src/session-list-cache";
import { parseComboList } from "../src/combo-workspace-data";

const API_BASE = "http://localhost";
const CACHE_KEY = `ocx.combos.workspace.v1:${API_BASE}`;
const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let root: Root | undefined;
let container: HTMLElement;
const originalFetch = globalThis.fetch;

type CatalogRow = {
  provider: string;
  id: string;
  disabled?: boolean;
  inputModalities?: string[];
  reasoningEfforts?: string[];
};
type Target = { provider: string; model: string };
const hiddenImage: CatalogRow = {
  provider: "vision", id: "hidden", disabled: true,
  inputModalities: ["text", "image"], reasoningEfforts: ["low", "high"],
};
const textModel: CatalogRow = {
  provider: "text", id: "plain", inputModalities: ["text"], reasoningEfforts: ["high", "xhigh"],
};
const target = (row: CatalogRow): Target => ({ provider: row.provider, model: row.id });
const combo = (targets: Target[], extra: Record<string, unknown> = {}) => ({
  id: "hidden-test", model: "combo/hidden-test", strategy: "failover", stickyLimit: 1,
  imageInput: "auto", targets, ...extra,
});

beforeEach(() => {
  clearClientResourceStoresForTests();
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: `${API_BASE}/#models/combos` });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow.window },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true },
  });
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  container.remove();
  globalThis.fetch = originalFetch;
  clearClientResourceStoresForTests();
  testWindow.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
});

function mockCatalog(rows: CatalogRow[], targets: Target[], extra: Record<string, unknown> = {}, defaults: Record<string, string> = {}) {
  const providers = Object.fromEntries([...new Set([...rows.map(row => row.provider), ...targets.map(row => row.provider), ...Object.keys(defaults)])]
    .map(name => [name, { adapter: "openai-chat", baseUrl: "https://provider.example/v1", defaultModel: defaults[name] }]));
  let modelRequests = 0;
  let gate: Promise<void> | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/models") {
      modelRequests += 1;
      await gate;
      return Response.json([...rows, { provider: "combo", id: "hidden-test" }]);
    }
    if (path === "/api/combos") return Response.json({ combos: [combo(targets, extra)] });
    if (path === "/api/config") return Response.json({ providers });
    if (path === "/api/provider-quotas") return Response.json({ reports: [] });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return {
    requests: () => modelRequests,
    defer: () => {
      let release!: () => void;
      gate = new Promise<void>(resolve => { release = resolve; });
      return release;
    },
  };
}

async function mount(active = true) {
  const { createRoot } = await import("react-dom/client");
  root = createRoot(container);
  await act(async () => { root!.render(<LanguageProvider><Combos apiBase={API_BASE} active={active} /></LanguageProvider>); });
}

async function openDetail() {
  const rail = container.querySelector<HTMLButtonElement>(".combos-workspace-rail-row");
  expect(rail).not.toBeNull();
  await act(async () => { rail!.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0)); });
}

function imageSwitch(scope: ParentNode = container) {
  const control = scope.querySelector<HTMLButtonElement>('button[aria-label="Image / multimodal"]');
  expect(control).not.toBeNull();
  return control!;
}
function expectImages(supported: boolean, scope: ParentNode = container) {
  expect(imageSwitch(scope).disabled).toBe(!supported);
  expect(imageSwitch(scope).getAttribute("aria-pressed")).toBe(String(supported));
}
function effortValues(selector = "#cwi-effort") {
  const control = container.querySelector<HTMLSelectElement>(selector);
  expect(control).not.toBeNull();
  return [...control!.options].map(option => option.value);
}
async function chooseProvider(provider: string, scope: ParentNode = container) {
  const control = scope.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')!;
  await act(async () => {
    control.value = provider;
    control.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
  });
}

test("a disabled image-capable target enables the Image switch and stays visible in its selected row", async () => {
  mockCatalog([hiddenImage], [target(hiddenImage)]);
  await mount();
  await openDetail();
  expectImages(true);
  expect(container.querySelector<HTMLSelectElement>('select[aria-label="Model"]')!.value).toBe("hidden");
  expect(effortValues()).toEqual(["", "low", "high"]);
});

for (const [name, targets] of [
  ["text-only", [target(textModel)]],
  ["unknown", [{ provider: "vision", model: "missing" }]],
  ["mixed image/text", [target(hiddenImage), target(textModel)]],
] as const) {
  test(`${name} targets keep the Image switch off`, async () => {
    mockCatalog([hiddenImage, textModel], [...targets]);
    await mount();
    await openDetail();
    expectImages(false);
  });
}

for (const provider of ["vision", "text"]) {
  test(`same id under two providers uses ${provider}'s capabilities`, async () => {
    mockCatalog([
      { ...textModel, id: "shared" },
      { ...hiddenImage, id: "shared" },
    ], [{ provider, model: "shared" }]);
    await mount();
    await openDetail();
    expectImages(provider === "vision");
    expect(effortValues()).toEqual(provider === "vision" ? ["", "low", "high"] : ["", "high", "xhigh"]);
  });
}

test("disabled targets contribute their differing reasoning ladders to the intersection", async () => {
  mockCatalog([hiddenImage, { ...textModel, disabled: true }], [target(hiddenImage), target(textModel)]);
  await mount();
  await openDetail();
  expect(effortValues()).toEqual(["", "high"]);
});

for (const mode of ["strict", "adaptive"] as const) {
  test(`${mode} mode respects a disabled target's empty reasoning ladder`, async () => {
    mockCatalog([hiddenImage, { ...textModel, disabled: true, reasoningEfforts: [] }],
      [target(hiddenImage), target(textModel)], { reasoningEffortMode: mode });
    await mount();
    await openDetail();
    expect(effortValues()).toEqual(mode === "strict" ? [""] : ["", "low", "high"]);
    const adaptive = container.querySelector<HTMLButtonElement>('button[aria-label="Adaptive reasoning ladder"]')!;
    await act(async () => { adaptive.click(); });
    expect(effortValues()).toEqual(mode === "strict" ? ["", "low", "high"] : [""]);
  });
}

test("JEV selected-target effort controls use the disabled row's advertised ladder", async () => {
  mockCatalog([hiddenImage], [target(hiddenImage)], { strategy: "jev" });
  await mount();
  await openDetail();
  expect([...container.querySelectorAll<HTMLInputElement>("[data-jev-effort]")].map(input => input.value)).toEqual(["low", "high"]);
  expect(container.textContent).not.toContain("Reasoning efforts unknown");
});

test("a disabled provider default never returns in the new-member picker", async () => {
  mockCatalog([hiddenImage, { ...hiddenImage, id: "visible", disabled: false }], [target(hiddenImage)], {}, { vision: "hidden" });
  await mount();
  await openDetail();
  expect(container.querySelector<HTMLSelectElement>('select[aria-label="Model"]')!.value).toBe("hidden");
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Add combo"]')!.click(); });
  const dialog = container.querySelector("dialog")!;
  await chooseProvider("vision", dialog);
  const options = [...dialog.querySelector<HTMLSelectElement>('select[aria-label="Model"]')!.options].map(option => option.value);
  expect(options).toEqual(["", "visible"]);
  expect(options).not.toContain("hidden");
});

test("a default missing from the catalog still gets a picker placeholder", async () => {
  mockCatalog([hiddenImage], [target(hiddenImage)], {}, { lagged: "missing-default" });
  await mount();
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Add combo"]')!.click(); });
  const dialog = container.querySelector("dialog")!;
  await chooseProvider("lagged", dialog);
  expect([...dialog.querySelector<HTMLSelectElement>('select[aria-label="Model"]')!.options].map(option => option.value)).toEqual(["", "missing-default"]);
  expectImages(false, dialog);
});

test("cache remount and live revalidation preserve hidden-target capabilities", async () => {
  const api = mockCatalog([hiddenImage], [target(hiddenImage)]);
  await mount();
  await openDetail();
  expectImages(true);
  const cached = readSessionListCacheEntry<{ capabilityModels: CatalogRow[]; models: CatalogRow[] }>(CACHE_KEY)!;
  expect(cached.data.capabilityModels).toEqual([{
    provider: "vision", id: "hidden", inputModalities: ["text", "image"], reasoningEfforts: ["low", "high"],
  }]);
  expect(cached.data.models).toEqual([]);
  await act(async () => { root!.unmount(); });
  root = undefined;
  clearClientResourceStoresForTests();
  const release = api.defer();
  await mount();
  await openDetail();
  expectImages(true);
  expect(api.requests()).toBe(1); // Fresh cache renders without fetching again.
  await act(async () => { invalidateClientResource(CACHE_KEY); });
  expect(api.requests()).toBe(2);
  expect(container.querySelector(".combos-workspace-shell-body")!.getAttribute("aria-busy")).toBe("true");
  expectImages(true);
  await act(async () => { release(); });
  expect(container.querySelector(".combos-workspace-shell-body")!.getAttribute("aria-busy")).toBe("false");
  expectImages(true);
  expect(effortValues()).toEqual(["", "low", "high"]);
});

test("an older cache entry without capabilityModels uses its models metadata", async () => {
  writeSessionListCacheEntry(CACHE_KEY, {
    combos: parseComboList({ combos: [combo([target(hiddenImage)])] }),
    providers: [{ name: "vision" }], models: [hiddenImage], cataloguedComboIds: ["hidden-test"],
  });
  globalThis.fetch = (async () => { throw new Error("inactive cached page must not fetch"); }) as typeof fetch;
  await mount(false);
  await openDetail();
  expectImages(true);
  expect(effortValues()).toEqual(["", "low", "high"]);
});

test("the add panel retains image and effort metadata after a selected model becomes disabled", async () => {
  const row = { ...hiddenImage, disabled: false };
  mockCatalog([row], [target(hiddenImage)]);
  await mount();
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Add combo"]')!.click(); });
  const dialog = container.querySelector("dialog")!;
  await chooseProvider("vision", dialog);
  expectImages(true, dialog);
  expect(effortValues("#cwi-new-effort")).toEqual(["", "low", "high"]);
  row.disabled = true;
  row.reasoningEfforts = [];
  await act(async () => { invalidateClientResource(CACHE_KEY); });
  expectImages(true, dialog);
  expect(effortValues("#cwi-new-effort")).toEqual([""]);
  expect(dialog.querySelector<HTMLSelectElement>('select[aria-label="Model"]')!.value).toBe("hidden");
  await act(async () => { dialog.querySelector<HTMLButtonElement>('button[aria-label="Adaptive reasoning ladder"]')!.click(); });
  expect(effortValues("#cwi-new-effort")).toEqual(["", "low", "medium", "high", "xhigh", "max", "ultra"]);
});
