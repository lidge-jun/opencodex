import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ProviderAuthPanel from "../src/components/provider-workspace/ProviderAuthPanel";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";
import type { ProviderAuthHandlers } from "../src/components/provider-workspace/types";

const CANARY = "canary-cockpit-refresh-token-do-not-render";
const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "fetch"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let fetchMock: ReturnType<typeof mock>;
let retryAccounts: ReturnType<typeof mock>;

const ITEM: WorkspaceItem = {
  name: "google-antigravity",
  adapter: "google",
  baseUrl: "https://daily-cloudcode-pa.googleapis.com",
  authMode: "oauth",
};

function handlers(): ProviderAuthHandlers {
  return {
    onLogin: () => {}, onLogout: () => {}, onReauth: () => {}, onSwitchAccount: () => {}, onRemoveAccount: () => {},
    onAddApiKey: async () => true, onSwitchApiKey: () => {}, onRemoveApiKey: () => {}, onEditAlias: () => {},
    onRetryAccounts: retryAccounts,
  };
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  fetchMock = mock(async () => new Response(JSON.stringify({
    totalCount: 1, importedCount: 1, updatedCount: 0, failedCount: 0, unsupportedCount: 0,
    results: [{ index: 0, status: "imported", code: "imported" }],
  })));
  retryAccounts = mock(async () => {});
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document }, window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator }, localStorage: { configurable: true, value: win.localStorage },
    fetch: { configurable: true, value: fetchMock },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) { const current = root; await act(async () => { current.unmount(); }); root = null; }
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  await win.happyDOM?.close?.();
});

async function mount() {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><ProviderAuthPanel item={ITEM} apiBase="/proxy" authHandlers={handlers()} /></LanguageProvider>);
  });
}

function input(): HTMLInputElement {
  const element = host.querySelector("#cockpit-import-file");
  expect(element).toBeTruthy();
  return element as HTMLInputElement;
}

async function select(content: string, name = "cockpit.json") {
  const file = new win.File([content], name, { type: "application/json" }) as unknown as File;
  await selectFile(file);
}

async function selectFile(file: File) {
  Object.defineProperty(input(), "files", { configurable: true, value: [file] });
  await act(async () => {
    input().dispatchEvent(new win.Event("change", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

test("posts only the explicit Cockpit contract, refreshes accounts, and never renders a token", async () => {
  await mount();
  await select(JSON.stringify([{ email: "person@example.test", refresh_token: CANARY }]));

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("/proxy/api/oauth/accounts/import");
  expect(JSON.parse(String(init.body))).toEqual({
    provider: "google-antigravity", format: "cockpit-tools",
    document: [{ email: "person@example.test", refresh_token: CANARY }],
  });
  expect(retryAccounts).toHaveBeenCalledWith("google-antigravity");
  expect(host.textContent).toContain("Import complete: 1 imported, 0 updated, 0 failed, 0 unsupported.");
  expect(host.textContent).not.toContain(CANARY);
  expect(input().value).toBe("");
});

test("uses fixed safe statuses for invalid JSON and backend failures", async () => {
  await mount();
  await select(`{ "refresh_token": "${CANARY}"`);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(host.textContent).toContain("not a valid JSON export or is too large");
  expect(host.textContent).not.toContain(CANARY);

  await select("[]", "not-a-json-export.txt");
  expect(fetchMock).not.toHaveBeenCalled();

  fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: CANARY }), { status: 500 }));
  await select("[]");
  expect(host.textContent).toContain("The account import could not be completed.");
  expect(host.textContent).not.toContain(CANARY);

  fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({
    totalCount: 1,
    importedCount: CANARY,
    updatedCount: 0,
    failedCount: 0,
    unsupportedCount: 0,
    results: [{ index: 0, status: "imported", code: "imported", error: CANARY }],
  })));
  await select("[]");
  expect(host.textContent).toContain("The account import could not be completed.");
  expect(host.textContent).not.toContain(CANARY);
  expect(retryAccounts).not.toHaveBeenCalled();
});

test("rejects an oversized export before reading its contents or calling the API", async () => {
  await mount();
  const file = new win.File(["x".repeat(256 * 1024 + 1)], "oversized.json", { type: "application/json" }) as unknown as File;
  const read = mock(async () => JSON.stringify([{ refresh_token: CANARY }]));
  Object.defineProperty(file, "text", { configurable: true, value: read });

  await selectFile(file);

  expect(read).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(host.textContent).toContain("not a valid JSON export or is too large");
  expect(host.textContent).not.toContain(CANARY);
  expect(input().value).toBe("");
});

test("keeps a completed import result when the subsequent account refresh rejects", async () => {
  retryAccounts.mockImplementationOnce(async () => { throw new Error(CANARY); });
  await mount();
  await select(JSON.stringify([{ email: "person@example.test", refresh_token: CANARY }]));

  expect(retryAccounts).toHaveBeenCalledWith("google-antigravity");
  expect(host.textContent).toContain("Import complete: 1 imported, 0 updated, 0 failed, 0 unsupported.");
  expect(host.textContent).not.toContain("The account import could not be completed.");
  expect(host.textContent).not.toContain(CANARY);
  expect(input().value).toBe("");
});

test("handles unsupported result codes without exposing them and resets for repeat selection", async () => {
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({
    totalCount: 1, importedCount: 0, updatedCount: 0, failedCount: 0, unsupportedCount: 1,
    results: [{ index: 0, status: "unsupported", code: "unsupported_provider" }],
  })));
  await mount();
  await select("[]");
  await select("[]");

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(retryAccounts).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("1 unsupported.");
  expect(host.textContent).not.toContain("unsupported_provider");
  expect(input().value).toBe("");
});

test("rejects contradictory status/code pairs without exposing backend codes or canaries", async () => {
  await mount();

  for (const contradictory of [
    { status: "imported", code: "persist_failed" },
    { status: "updated", code: "credential_rejected" },
    { status: "failed", code: "imported" },
    { status: "unsupported", code: "invalid_document" },
  ]) {
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({
      totalCount: 1,
      importedCount: contradictory.status === "imported" ? 1 : 0,
      updatedCount: contradictory.status === "updated" ? 1 : 0,
      failedCount: contradictory.status === "failed" ? 1 : 0,
      unsupportedCount: contradictory.status === "unsupported" ? 1 : 0,
      results: [{ index: 0, status: contradictory.status, code: contradictory.code, error: CANARY }],
    })));
    await select("[]");
    expect(host.textContent).toContain("The account import could not be completed.");
    expect(host.textContent).not.toContain(contradictory.code);
    expect(host.textContent).not.toContain(CANARY);
    expect(retryAccounts).not.toHaveBeenCalled();
  }
});
