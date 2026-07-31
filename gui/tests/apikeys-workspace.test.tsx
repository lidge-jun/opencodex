import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ApiKeysWorkspace, {
  type ApiKeysWorkspaceProps,
} from "../src/components/apikeys-workspace/ApiKeysWorkspace";
import type { ApiKeyEntry } from "../src/pages/api-keys-utils";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

const sampleKeys: ApiKeyEntry[] = [
  { id: "k1", name: "alpha", prefix: "ocx_aaa", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "k2", name: "beta", prefix: "ocx_bbb", createdAt: "2026-01-02T00:00:00.000Z" },
];

const endpoints = {
  baseUrl: "http://127.0.0.1:10100/v1",
  responses: "http://127.0.0.1:10100/v1/responses",
  chatCompletions: "http://127.0.0.1:10100/v1/chat/completions",
  messages: "http://127.0.0.1:10100/v1/messages",
  models: "http://127.0.0.1:10100/v1/models",
};

const FULL_SECRET = "ocx_FULL_SECRET_ONLY_ONCE";

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mountWorkspace(
  props: Partial<ApiKeysWorkspaceProps> = {},
): Promise<{ root: Root; container: HTMLElement; rerender: (next: Partial<ApiKeysWorkspaceProps>) => Promise<void> }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  let latest: ApiKeysWorkspaceProps = {
    keys: sampleKeys,
    keysLoading: false,
    keysLoadFailed: false,
    endpoints,
    claudeCodeEnabled: true,
    newName: "",
    creating: false,
    newKey: null,
    copied: false,
    filteredModels: [],
    modelsLoading: false,
    modelsLoadFailed: false,
    modelQuery: "",
    copiedModelId: null,
    modelTests: {},
    onNewNameChange: () => {},
    onCreate: () => {},
    onDismissNewKey: () => {},
    onCopyKey: () => {},
    onDelete: () => {},
    onModelQueryChange: () => {},
    onCopyModelId: () => {},
    onTestModel: () => {},
    sourceLabel: () => "proxy",
    protocolLabel: (p) => p,
    ...props,
  };

  function Harness({ value }: { value: ApiKeysWorkspaceProps }) {
    return (
      <LanguageProvider>
        <ApiKeysWorkspace {...value} />
      </LanguageProvider>
    );
  }

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Harness value={latest} />);
  });

  return {
    root,
    container,
    async rerender(next) {
      latest = { ...latest, ...next };
      await act(async () => {
        root.render(<Harness value={latest} />);
      });
    },
  };
}

function overviewButton(container: HTMLElement): HTMLButtonElement {
  return [...container.querySelectorAll<HTMLButtonElement>(".apikeys-workspace-rail-row")]
    .find(el => el.textContent?.includes("Overview"))!;
}

function keyButton(container: HTMLElement, name: string): HTMLButtonElement {
  return [...container.querySelectorAll<HTMLButtonElement>(".apikeys-workspace-rail-row")]
    .find(el => el.querySelector(".apikeys-workspace-rail-name")?.textContent === name)!;
}

test("workspace overview navigation preserves pending secret and resets delete confirm", async () => {
  const { root, container } = await mountWorkspace({
    newKey: FULL_SECRET,
  });

  expect(container.textContent).toContain("Generate key");
  expect(container.textContent).toContain(FULL_SECRET);
  expect(container.querySelector("main")).toBeNull();
  expect(container.querySelector("section.apikeys-workspace-main")?.getAttribute("aria-label")).toBe("API key details");
  expect(container.querySelector(".tbl")).toBeNull();

  await act(async () => { keyButton(container, "alpha").click(); });
  expect(container.textContent).toContain("Key details");
  expect(container.textContent).toContain("ocx_aaa");
  expect(container.textContent).not.toContain(FULL_SECRET);

  await act(async () => {
    [...container.querySelectorAll("button")].find(b => b.textContent?.includes("Delete key"))!.click();
  });
  expect(container.textContent).toContain("Are you sure you want to delete this key?");

  await act(async () => { overviewButton(container).click(); });
  expect(container.textContent).toContain("Generate key");
  expect(container.textContent).toContain(FULL_SECRET);
  expect(container.textContent).not.toContain("Are you sure you want to delete this key?");

  await act(async () => { root.unmount(); });
});

test("workspace delete confirm calls onDelete and returns to overview", async () => {
  const deleted: string[] = [];
  const { root, container } = await mountWorkspace({
    onDelete: (id) => { deleted.push(id); },
  });

  await act(async () => { keyButton(container, "beta").click(); });
  await act(async () => {
    [...container.querySelectorAll("button")].find(b => b.textContent?.includes("Delete key"))!.click();
  });
  // Confirm stays disabled briefly so a double-click cannot skip the confirm step.
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 350));
  });
  await act(async () => {
    [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Confirm")!.click();
  });

  expect(deleted).toEqual(["k2"]);
  expect(container.textContent).toContain("Generate key");
  expect(container.textContent).not.toContain("Key details");

  await act(async () => { root.unmount(); });
});

test("stale selected key falls back to overview when list refreshes without it", async () => {
  const { root, container, rerender } = await mountWorkspace();

  await act(async () => { keyButton(container, "alpha").click(); });
  expect(container.textContent).toContain("Key details");

  await rerender({ keys: [sampleKeys[1]!] });
  expect(container.textContent).toContain("Generate key");
  expect(container.textContent).not.toContain("Key details");

  await act(async () => { root.unmount(); });
});
