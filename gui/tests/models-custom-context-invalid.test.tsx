import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import Models from "../src/pages/Models";

const globals = [
  "document", "window", "navigator", "localStorage", "sessionStorage",
  "IS_REACT_ACT_ENVIRONMENT", "setInterval", "clearInterval", "fetch",
] as const;
let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;

const baseRow = { provider: "anthropic", id: "claude-sonnet-5", namespaced: "anthropic/claude-sonnet-5", disabled: false };
// The edit cases operate on an existing custom model carrying a 350k override, as the server
// would return it from /api/models.
const customRow = {
  ...baseRow,
  id: "qwen4-max-preview",
  namespaced: "anthropic/qwen4-max-preview",
  custom: true,
  customId: "custom-1",
  displayName: "Qwen 4 Max Preview",
  contextWindow: 350_000,
};

interface MountOptions {
  modelRows?: Array<Record<string, unknown>>;
  puts?: Array<Record<string, unknown>>;
}

beforeEach(() => {
  clearClientResourceStoresForTests();
  previousGlobals = Object.fromEntries(
    globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as typeof previousGlobals;
  root = null;
  testWindow = new Window({ url: "http://localhost/" });
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
  testWindow.localStorage.setItem("ocx-models-collapsed:v2", JSON.stringify([]));
  container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  clearClientResourceStoresForTests();
  try {
    if (root) {
      const current = root;
      await act(async () => { current.unmount(); });
    }
  } finally {
    root = null;
    testWindow.close();
    for (const key of globals) {
      const descriptor = previousGlobals[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

const flush = () => act(async () => {
  await new Promise(resolve => testWindow.setTimeout(resolve, 0));
  await Promise.resolve();
});

// A harness shared by the cases below: the mock records POST/PUT /api/custom-models bodies so
// each case can assert both that an invalid draft wrote nothing and that the dialog told the
// user why.
async function mount(posts: Array<Record<string, unknown>>, options: MountOptions = {}) {
  const modelRows = options.modelRows ?? [baseRow];
  const puts = options.puts ?? [];
  testWindow.sessionStorage.setItem("ocx.models.catalog.v1:http://localhost", JSON.stringify({
    models: modelRows,
    providers: [{ name: "anthropic", liveModels: true, models: modelRows.map(row => row.id) }],
    selectedModels: {},
    disabled: [],
    contextCaps: {},
    contextCapValue: 350_000,
  }));
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/custom-models") && init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ id: "custom-1", ...JSON.parse(String(init.body)) }, { status: 201 });
    }
    if (url.includes("/api/custom-models/") && init?.method === "PUT") {
      puts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ id: "custom-1", ...JSON.parse(String(init.body)) });
    }
    if (url.endsWith("/api/models")) return Response.json(modelRows);
    if (url.endsWith("/api/providers")) {
      return Response.json([{ name: "anthropic", liveModels: true, models: modelRows.map(row => row.id) }]);
    }
    if (url.endsWith("/api/selected-models")) return Response.json({ selected: {} });
    if (url.endsWith("/api/provider-context-caps")) return Response.json({ caps: {} });
    if (url.endsWith("/api/combos")) return Response.json({ combos: [] });
    if (url.endsWith("/api/shadow-call-settings")) return Response.json({ enabled: false, model: "" });
    if (url.endsWith("/api/v2")) return Response.json({ enabled: false, agentsMaxThreadsConflict: false, multiAgentMode: "default" });
    if (url.endsWith("/api/subagent-models")) {
      return Response.json({
        pickerAvailable: modelRows.map(row => `anthropic/${String(row.id)}`),
        pickerOrder: [],
        pickerOrderMode: null,
      });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <Models apiBase="http://localhost" />
      </LanguageProvider>,
    );
  });
  await flush();
}

async function openAddDialog(): Promise<HTMLElement> {
  const addButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent?.includes("Add custom model"))!;
  expect(addButton).toBeTruthy();
  await act(async () => { addButton.click(); });
  const dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label^="Add custom model"]')!;
  expect(dialog).toBeTruthy();
  return dialog;
}

// The Edit action only renders inside the row hover/focus tooltip. Focus (unlike mouseenter)
// reveals it with no timer to advance.
async function openEditDialog(): Promise<HTMLElement> {
  const rowWrap = container.querySelector<HTMLElement>(".model-row-wrap")!;
  expect(rowWrap).toBeTruthy();
  await act(async () => {
    rowWrap.dispatchEvent(new testWindow.FocusEvent("focusin", { bubbles: true }));
  });
  const editButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent === "Edit")!;
  expect(editButton).toBeTruthy();
  await act(async () => { editButton.click(); });
  const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Edit custom model");
  return dialog;
}

async function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
}

async function chooseCustomContext(dialog: HTMLElement): Promise<HTMLInputElement> {
  await act(async () => {
    dialog.querySelector<HTMLButtonElement>('button.select-trigger[aria-label="Context window"]')!.click();
  });
  const option = [...testWindow.document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find(candidate => candidate.textContent === "Custom…")!;
  expect(option).toBeTruthy();
  await act(async () => { option.click(); });
  const customInput = dialog.querySelector<HTMLInputElement>('input[aria-label="Context window"]')!;
  expect(customInput).toBeTruthy();
  return customInput;
}

const clickButton = (dialog: HTMLElement, label: string) => act(async () => {
  [...dialog.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent === label)!
    .click();
  await new Promise(resolve => testWindow.setTimeout(resolve, 0));
  await Promise.resolve();
});

const expectInvalidBlocked = (dialog: HTMLElement, writes: Array<Record<string, unknown>>) => {
  // The dialog must stay open and explain the rejection; the silent-drop behaviour sent the
  // write with contextWindow omitted/nulled and showed success.
  expect(writes).toHaveLength(0);
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(dialog.textContent).toContain("Context windows must be positive whole numbers");
};

for (const invalid of ["350k", "0", "-5"]) {
  test(`custom model add rejects an invalid context window draft (${invalid}) and never POSTs`, async () => {
    const posts: Array<Record<string, unknown>> = [];
    await mount(posts);
    const dialog = await openAddDialog();

    await typeInto(
      dialog.querySelector<HTMLInputElement>('input[placeholder^="e.g. qwen"]')!,
      "qwen4-max-preview",
    );
    const contextInput = await chooseCustomContext(dialog);
    await typeInto(contextInput, invalid);
    await clickButton(dialog, "Add");

    expectInvalidBlocked(dialog, posts);
  });
}

test("custom model add accepts a comma-grouped context window after correcting an invalid draft", async () => {
  const posts: Array<Record<string, unknown>> = [];
  await mount(posts);
  const dialog = await openAddDialog();

  await typeInto(
    dialog.querySelector<HTMLInputElement>('input[placeholder^="e.g. qwen"]')!,
    "qwen4-max-preview",
  );
  const contextInput = await chooseCustomContext(dialog);

  await typeInto(contextInput, "350k");
  await clickButton(dialog, "Add");
  expect(posts).toHaveLength(0);
  expect(dialog.textContent).toContain("Context windows must be positive whole numbers");

  // Correcting the value and saving again must clear the inline error and go through.
  await typeInto(contextInput, "350,000");
  await clickButton(dialog, "Add");

  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({
    provider: "anthropic",
    modelId: "qwen4-max-preview",
    contextWindow: 350_000,
  });
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

test("custom model add without a context window omits the field (unset means inherit)", async () => {
  const posts: Array<Record<string, unknown>> = [];
  await mount(posts);
  const dialog = await openAddDialog();

  await typeInto(
    dialog.querySelector<HTMLInputElement>('input[placeholder^="e.g. qwen"]')!,
    "qwen4-max-preview",
  );
  // Leave the context Select on its default "—": the create must carry no contextWindow key.
  await clickButton(dialog, "Add");

  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ provider: "anthropic", modelId: "qwen4-max-preview" });
  expect(posts[0]).not.toHaveProperty("contextWindow");
});

test("custom model edit rejects an invalid context window draft and never PUTs", async () => {
  const posts: Array<Record<string, unknown>> = [];
  const puts: Array<Record<string, unknown>> = [];
  await mount(posts, { modelRows: [customRow], puts });
  const dialog = await openEditDialog();

  const contextInput = await chooseCustomContext(dialog);
  // Custom… reveals the free-text input without resetting the stored value the edit opened with.
  expect(contextInput.value).toBe("350000");
  await typeInto(contextInput, "350k");
  await clickButton(dialog, "Update");

  expectInvalidBlocked(dialog, puts);
  expect(posts).toHaveLength(0);
});

test("custom model edit clearing the context window PUTs null (reset to inherit)", async () => {
  const posts: Array<Record<string, unknown>> = [];
  const puts: Array<Record<string, unknown>> = [];
  await mount(posts, { modelRows: [customRow], puts });
  const dialog = await openEditDialog();

  const contextInput = await chooseCustomContext(dialog);
  expect(contextInput.value).toBe("350000");
  await typeInto(contextInput, "");
  await clickButton(dialog, "Update");

  expect(puts).toHaveLength(1);
  expect(puts[0]).toMatchObject({ modelId: "qwen4-max-preview", contextWindow: null });
  expect(posts).toHaveLength(0);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});
