import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ProviderDetails from "../src/components/provider-workspace/ProviderDetails";
import type { OAuthAccountRow } from "../src/components/provider-workspace/types";
import { LanguageProvider } from "../src/i18n/provider";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";

/**
 * #8286: the Overview of a Claude pool named no account at all, while its Accounts rows show
 * the alias. The Overview now names the active account with the row label (alias, then the
 * server-masked identity, then the ordinal) and still never renders the login email.
 */

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
const WINDOW_EVENT_STUB: { event: undefined } = { event: undefined };
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;

const POOL_A = { name: "anthropic", adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" } as unknown as WorkspaceItem;
const POOL_B = { ...POOL_A, name: "anthropic2", anthropicOAuthInstance: "anthropic2" } as unknown as WorkspaceItem;
const OTHER = { name: "xai", adapter: "openai-chat", baseUrl: "https://xai.invalid/v1", authMode: "oauth", hasApiKey: false } as unknown as WorkspaceItem;

function rows(pool: string, active: Partial<OAuthAccountRow>): OAuthAccountRow[] {
  return [
    { id: "first", email: "first@" + pool + ".test", active: false, paused: false, alias: "Spare" },
    { id: "second", email: "second@" + pool + ".test", active: true, paused: false, ...active },
  ] as OAuthAccountRow[];
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previous;
  originalFetch = globalThis.fetch;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperty(win, "event", { configurable: true, writable: true, value: undefined });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => ({ ok: true, json: async () => ({}) }) as unknown as Response,
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
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise<void>((r) => setTimeout(r, 0));
      await Promise.resolve();
    }
  });
  for (const key of globals) {
    let value = previous[key];
    if (key === "window") {
      if (value == null || typeof value !== "object") {
        value = WINDOW_EVENT_STUB;
      } else if (!Object.prototype.hasOwnProperty.call(value, "event")) {
        try {
          Object.defineProperty(value, "event", { configurable: true, writable: true, value: undefined });
        } catch {
          value = WINDOW_EVENT_STUB;
        }
      }
    }
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
});

async function overviewText(item: WorkspaceItem, accounts: OAuthAccountRow[], oauthEmail?: string): Promise<string> {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <ProviderDetails
          key={item.name}
          item={item}
          availableModels={[]}
          hasLiveModels={false}
          selectedModels={[]}
          modelRows={[]}
          modelRevision="overview-account-label-1"
          modelRowsReady={true}
          onOpenModels={() => {}}
          onDeselect={() => {}}
          apiBase=""
          accounts={accounts}
          accountLoadState="ready"
          oauth={{ loggedIn: true }}
          oauthEmail={oauthEmail}
        />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.id).toBe("pws-tab-overview");
  return host.textContent ?? "";
}

for (const item of [POOL_A, POOL_B]) {
  const email = "second@" + item.name + ".test";

  test(`${item.name} Overview names the active account by its alias`, async () => {
    const text = await overviewText(item, rows(item.name, { alias: "Work", maskedLabel: "s***d@example.test" }), email);
    expect(text).toContain("OAuth · Work");
    expect(text).toContain("Logged in as Work");
    expect(text).not.toContain("Spare");
    expect(text).not.toContain(email);
  });

  test(`${item.name} Overview falls back to the masked label, then the ordinal, never the email`, async () => {
    const masked = await overviewText(item, rows(item.name, { maskedLabel: "s***d@example.test" }), email);
    expect(masked).toContain("Logged in as s***d@example.test");
    expect(masked).not.toContain(email);
    await act(async () => { root!.unmount(); });
    root = null;

    const ordinal = await overviewText(item, rows(item.name, {}), email);
    expect(ordinal).toContain("Logged in as Account 2");
    expect(ordinal).not.toContain(email);
  });

  test(`${item.name} Overview without an active account keeps the generic status`, async () => {
    const text = await overviewText(item, rows(item.name, { active: false }), email);
    expect(text).toContain("Logged in");
    expect(text).not.toContain("Logged in as");
    expect(text).not.toContain(email);
  });
}

test("other OAuth providers keep the login identity in the Overview", async () => {
  const text = await overviewText(OTHER, rows("xai", { alias: "Work" }), "s***d@xai.test");
  expect(text).toContain("Logged in as s***d@xai.test");
});

