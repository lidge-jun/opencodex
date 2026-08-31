import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import AddProviderModal from "../src/components/AddProviderModal";

/**
 * The Add-Provider catalog is the list a user reads to CHOOSE a provider, and it
 * was the only provider surface with no marks at all -- the rail, the details
 * panel and the dashboard rows have drawn them for a while.
 *
 * These pin the two properties that make the marks correct rather than merely
 * present: every row has one, and none of them is announced.
 */

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;

/** Two presets whose ids resolve a mark, and one that cannot. */
const PRESETS = [
  { id: "cerebras", label: "Cerebras", adapter: "openai-completions", baseUrl: "https://api.cerebras.ai/v1", auth: "key" },
  { id: "together", label: "Together", adapter: "openai-completions", baseUrl: "https://api.together.xyz/v1", auth: "key" },
  // No asset upstream: this row must still draw the fallback tile.
  { id: "chutes", label: "Chutes", adapter: "openai-completions", baseUrl: "https://llm.chutes.ai/v1", auth: "key" },
];

beforeEach(() => {
  previous = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previous;
  originalFetch = globalThis.fetch;
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
    value: async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/provider-presets") return Response.json({ providers: PRESETS });
      if (url.pathname === "/api/oauth/providers") return Response.json({ providers: [] });
      if (url.pathname === "/api/usage") return Response.json({ providers: [] });
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

async function mountCatalog() {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        {/* `paid` is where an API-key preset buckets; the default `free` tab would
            render an empty list and make these assertions vacuous. */}
        <AddProviderModal apiBase="" existingNames={[]} initialTier="paid" onClose={() => {}} onAdded={() => {}} />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise(r => setTimeout(r, 60)); });
}

function catalogRows(): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>(".provider-catalog-rows .list-row")];
}

/*
 * Every row, including the one whose vendor publishes nothing. A provider with no
 * asset must still render the fallback tile: the row that draws neither is
 * indistinguishable from a broken lookup, and misaligned against its neighbours.
 */
test("every catalog row draws a mark, including a provider with no asset", async () => {
  await mountCatalog();
  const rows = catalogRows();
  expect(rows.length).toBeGreaterThan(0);
  const bare = rows.filter(row => row.querySelector(".provider-icon") === null);
  expect(bare.map(row => row.textContent?.slice(0, 24))).toEqual([]);
});

/*
 * The mark sits beside a label that already names the provider, so it must add
 * nothing to the accessible name -- an `<img alt="Cerebras">` next to the word
 * Cerebras makes a screen reader say it twice.
 */
test("a catalog mark is decoration, not a second announcement of the name", async () => {
  await mountCatalog();
  for (const img of host.querySelectorAll(".provider-catalog-rows .provider-icon img")) {
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("aria-hidden")).toBe("true");
  }
});

/*
 * The mark comes first, before the title block. `.list-row` is space-between, so
 * a mark inserted anywhere else pushes the badge strip into the middle of the row.
 */
test("the mark leads the row so the badges stay right-aligned", async () => {
  await mountCatalog();
  for (const row of catalogRows()) {
    expect(row.firstElementChild?.classList.contains("provider-icon")).toBe(true);
  }
});
