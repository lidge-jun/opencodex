import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import ProviderSettings from "../src/components/provider-workspace/ProviderSettings";
import { LanguageProvider } from "../src/i18n/provider";
import type { ProviderUpdatePatch } from "../src/components/provider-workspace/types";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";

let previousLanguageDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  previousLanguageDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "language");
  Object.defineProperty(globalThis.navigator, "language", {
    configurable: true,
    value: "en-US",
  });
});

afterEach(() => {
  if (previousLanguageDescriptor) {
    Object.defineProperty(globalThis.navigator, "language", previousLanguageDescriptor);
  } else {
    Reflect.deleteProperty(globalThis.navigator, "language");
  }
});

const peers = [
  { name: "google-antigravity", models: ["gemini-3.6-flash"] },
  { name: "deepseek", models: ["deepseek-v4-flash", "deepseek-v4-reasoner"], defaultModel: "deepseek-v4-flash" },
  { name: "cursor", models: [] },
];

const item: WorkspaceItem = {
  name: "antigravity-primary",
  adapter: "google",
  baseUrl: "https://example.test",
  authMode: "oauth",
  defaultModel: "gemini-3.6-flash",
  fallback: [{ provider: "deepseek", model: "deepseek-v4-flash" }],
};

test("ProviderSettings renders configured fallback targets", () => {
  const html = renderToStaticMarkup(
    <LanguageProvider>
      <ProviderSettings item={item} peerProviders={peers} />
    </LanguageProvider>,
  );

  expect(html).toContain("Fallback providers");
  expect(html).toContain("deepseek");
  expect(html).toContain("deepseek-v4-flash");
  expect(html).toContain("Add fallback");
});

/**
 * The static render above only proves the chain is displayed. These cases drive the form the
 * way a user does, because the patch shape (ordered targets, trimmed rows, refusal to save a
 * half-filled row) is the part the management API contract depends on.
 */
const domGlobals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;

async function mountSettings(onUpdateProvider: (name: string, patch: ProviderUpdatePatch) => Promise<{ ok: boolean; error?: string }>) {
  const previous = Object.fromEntries(domGlobals.map(key => [key, Reflect.get(globalThis, key)]));
  const testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.append(container as never);

  // Lazy import: a static react-dom/client import binds to whichever document existed when the
  // module graph loaded and corrupts sibling suites in the same process.
  const [{ act }, { createRoot }] = await Promise.all([import("react"), import("react-dom/client")]);
  let root!: import("react-dom/client").Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <ProviderSettings item={item} peerProviders={peers} onUpdateProvider={onUpdateProvider} />
      </LanguageProvider>,
    );
  });

  const setSelectValue = (select: HTMLSelectElement, value: string) => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLSelectElement.prototype, "value")!
      .set!.call(select, value);
    select.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
  };
  const buttonByText = (text: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.includes(text));
  // The save button only exists while the sticky bar is showing unsaved changes.
  const saveButton = () => container.querySelector<HTMLButtonElement>(".pwi-settings-sticky-bar .btn-primary");

  const cleanup = async () => {
    await act(async () => { root.unmount(); });
    testWindow.close();
    for (const key of domGlobals) {
      Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
    }
  };

  return { act, container, setSelectValue, buttonByText, saveButton, cleanup };
}

test("saving emits the edited fallback chain in order", async () => {
  const patches: ProviderUpdatePatch[] = [];
  const { act, container, setSelectValue, buttonByText, saveButton, cleanup } = await mountSettings(async (_name, patch) => {
    patches.push(patch);
    return { ok: true };
  });

  try {
    const modelSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Fallback model"]')!;
    await act(async () => { setSelectValue(modelSelect, "deepseek-v4-reasoner"); });

    await act(async () => { buttonByText("Add fallback")!.click(); });
    const providerSelects = container.querySelectorAll<HTMLSelectElement>('select[aria-label="Fallback provider"]');
    expect(providerSelects).toHaveLength(2);
    // Picking a peer that advertises models auto-selects its first one, so the row is complete.
    await act(async () => { setSelectValue(providerSelects[1]!, "google-antigravity"); });

    await act(async () => { saveButton()!.click(); });

    expect(patches).toHaveLength(1);
    expect(patches[0]!.fallback).toEqual([
      { provider: "deepseek", model: "deepseek-v4-reasoner" },
      { provider: "google-antigravity", model: "gemini-3.6-flash" },
    ]);
  } finally {
    await cleanup();
  }
});

test("a half-filled fallback row blocks the save instead of dropping the row", async () => {
  const patches: ProviderUpdatePatch[] = [];
  const { act, container, setSelectValue, buttonByText, saveButton, cleanup } = await mountSettings(async (_name, patch) => {
    patches.push(patch);
    return { ok: true };
  });

  try {
    // An incomplete row alone never makes the form dirty, so edit a saved row first to get
    // the save control on screen; the incomplete row must then block that save.
    const modelSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Fallback model"]')!;
    await act(async () => { setSelectValue(modelSelect, "deepseek-v4-reasoner"); });

    await act(async () => { buttonByText("Add fallback")!.click(); });
    const providerSelects = container.querySelectorAll<HTMLSelectElement>('select[aria-label="Fallback provider"]');
    // `cursor` advertises no models, so the row stays without one.
    await act(async () => { setSelectValue(providerSelects[1]!, "cursor"); });

    await act(async () => { saveButton()!.click(); });

    expect(patches).toHaveLength(0);
    expect(container.querySelector(".pwi-settings-msg--err")?.textContent)
      .toContain("provider and a model");
  } finally {
    await cleanup();
  }
});

test("removing a row keeps the surviving rows' own values", async () => {
  const patches: ProviderUpdatePatch[] = [];
  const { act, container, setSelectValue, buttonByText, saveButton, cleanup } = await mountSettings(async (_name, patch) => {
    patches.push(patch);
    return { ok: true };
  });

  try {
    await act(async () => { buttonByText("Add fallback")!.click(); });
    const providerSelects = container.querySelectorAll<HTMLSelectElement>('select[aria-label="Fallback provider"]');
    await act(async () => { setSelectValue(providerSelects[1]!, "google-antigravity"); });

    // Rows carry a stable id, so dropping the first one must leave the second row's own
    // provider/model in place rather than shifting values up a slot.
    const removeButtons = container.querySelectorAll<HTMLButtonElement>('.pwi-fallback-row button[aria-label]');
    await act(async () => { removeButtons[0]!.click(); });

    const rows = container.querySelectorAll(".pwi-fallback-row");
    expect(rows).toHaveLength(1);
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Fallback provider"]')!.value)
      .toBe("google-antigravity");
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Fallback model"]')!.value)
      .toBe("gemini-3.6-flash");

    await act(async () => { saveButton()!.click(); });
    expect(patches).toHaveLength(1);
    expect(patches[0]!.fallback).toEqual([{ provider: "google-antigravity", model: "gemini-3.6-flash" }]);
  } finally {
    await cleanup();
  }
});
