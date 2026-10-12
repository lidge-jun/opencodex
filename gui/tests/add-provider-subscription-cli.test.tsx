import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import AddProviderModal from "../src/components/AddProviderModal";

/**
 * `claude-cli` drives the signed-in Claude Code CLI and bills that subscription; it is not an
 * API-key path even though its row is keyless. Picking it from the add-provider catalog has to
 * show that warning before the Add button can be pressed, list it under Paid rather than Free,
 * keep its own adapter in the form, and still save.
 */

const PRESETS = [
  { id: "claude-cli", label: "Claude Code CLI (subscription)", adapter: "claude-cli", baseUrl: "https://api.anthropic.com", auth: "key", keyOptional: true, defaultModel: "claude-sonnet-5", note: "Runs Claude subscription traffic through the official CLI." },
  { id: "keyless", label: "Keyless Free", adapter: "openai-chat", baseUrl: "https://api.example.com/v1", auth: "key", keyOptional: true },
];

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;
let posted: Array<Record<string, unknown>>;
let added: string[];

beforeEach(() => {
  previous = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previous;
  originalFetch = globalThis.fetch;
  posted = [];
  added = [];
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/provider-presets") return Response.json({ providers: PRESETS });
      if (url.pathname === "/api/oauth/providers") return Response.json({ providers: [] });
      if (url.pathname === "/api/usage") return Response.json({ providers: [] });
      if (url.pathname === "/api/providers" && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Response.json({ ok: true });
      }
      return Response.json({});
    },
  });
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  }
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  await win.happyDOM?.close?.();
});

async function mount(initialTier: "free" | "paid") {
  const { createRoot } = await import("react-dom/client");
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <AddProviderModal apiBase="" existingNames={[]} initialTier={initialTier} onClose={() => {}} onAdded={name => { added.push(name); }} />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise(r => setTimeout(r, 60)); });
}

function rowsText(): string {
  return win.document.querySelector(".provider-catalog-rows")?.textContent ?? "";
}

function warning() {
  return win.document.querySelector("[data-subscription-cli-warning]");
}

test("claude-cli is listed under Paid, not Free", async () => {
  await mount("free");
  expect(rowsText()).toContain("Keyless Free");
  expect(rowsText()).not.toContain("Claude Code CLI");

  await mount("paid");
  expect(rowsText()).toContain("Claude Code CLI (subscription)");
  expect(rowsText()).toContain("Subscription CLI");
  expect(rowsText()).not.toContain("Keyless Free");
});

test("selecting claude-cli shows the subscription warning above Add, and Add still saves", async () => {
  await mount("paid");
  expect(warning()).toBeNull();
  const row = [...win.document.querySelectorAll(".provider-catalog-row-wrap > button")]
    .find(el => (el.textContent ?? "").includes("Claude Code CLI")) as unknown as HTMLButtonElement;
  await act(async () => { row.click(); });

  const note = warning();
  expect(note).not.toBeNull();
  expect(note?.getAttribute("role")).toBe("note");
  expect(note?.textContent).toContain("Subscription CLI, not an API key");
  expect(note?.textContent).toContain("claude -p");
  expect(note?.textContent).toContain("anthropic-apikey");
  // The green free-tier box and the key field are replaced, not shown beside the warning.
  expect(win.document.body.textContent).not.toContain("Free tier");
  expect(win.document.querySelector('input[type="password"]')).toBeNull();

  // The form keeps the preset's own adapter rather than falling back to the first option.
  const adapter = win.document.querySelector("select.input") as unknown as HTMLSelectElement;
  expect(adapter.value).toBe("claude-cli");

  const addButton = [...win.document.querySelectorAll("button.btn-primary")]
    .find(el => el.textContent === "Add provider") as unknown as HTMLButtonElement;
  expect(addButton).toBeDefined();
  // Document order: the warning renders before the save control.
  expect(Boolean(note!.compareDocumentPosition(addButton as never) & 4)).toBe(true);
  await act(async () => { addButton.click(); });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
  expect(posted).toHaveLength(1);
  expect((posted[0]?.provider as { adapter?: string } | undefined)?.adapter).toBe("claude-cli");
  expect(posted[0]?.name).toBe("claude-cli");
  expect(added).toEqual(["claude-cli"]);
});

test("a keyless free row keeps the free-tier box and no subscription warning", async () => {
  await mount("free");
  const row = [...win.document.querySelectorAll(".provider-catalog-row-wrap > button")]
    .find(el => (el.textContent ?? "").includes("Keyless Free")) as unknown as HTMLButtonElement;
  await act(async () => { row.click(); });
  expect(warning()).toBeNull();
  expect(win.document.body.textContent).toContain("Free tier");
});
