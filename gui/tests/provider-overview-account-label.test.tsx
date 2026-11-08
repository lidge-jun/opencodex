import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ProviderDetails from "../src/components/provider-workspace/ProviderDetails";
import type { AccountLoadState, OAuthAccountRow } from "../src/components/provider-workspace/types";
import { LanguageProvider } from "../src/i18n/provider";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";

/**
 * #8286: the Overview of a Claude pool named no account at all, while its Accounts rows show
 * the alias. A verified roster supplies a separate current-account field using the row label
 * (alias, then masked identity, then ordinal), without exposing the login email.
 */

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: PropertyDescriptor | undefined;
let domIsSetup = false;

const POOL_A = { name: "anthropic", adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" } as unknown as WorkspaceItem;
const POOL_B = { ...POOL_A, name: "anthropic2", anthropicOAuthInstance: "anthropic2" } as unknown as WorkspaceItem;
const OTHER = { name: "xai", adapter: "openai-chat", baseUrl: "https://xai.invalid/v1", authMode: "oauth", hasApiKey: false } as unknown as WorkspaceItem;

/** Two-account roster for `pool`: an inactive "Spare" row, then the active row with `active` applied. */
function rows(pool: string, active: Partial<OAuthAccountRow>): OAuthAccountRow[] {
  return [
    { id: "first", email: "first@" + pool + ".test", active: false, paused: false, alias: "Spare" },
    { id: "second", email: "second@" + pool + ".test", active: true, paused: false, ...active },
  ] as OAuthAccountRow[];
}

const originalDescriptors = new Map<string, PropertyDescriptor | undefined>(
  [...globals, "fetch"].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]),
);

beforeEach(setupDom);

function setupDom(): void {
  previous = Object.fromEntries(globals.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)])) as typeof previous;
  originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  // Armed before the first mutation, so a setup failure still restores what it changed.
  domIsSetup = true;
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
}

afterEach(teardownDom);

async function teardownDom(): Promise<void> {
  if (!domIsSetup) return;
  domIsSetup = false;
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
  // Restore the exact descriptors; a global that was absent is deleted, never stubbed (#8344).
  for (const key of globals) restoreOwnProperty(globalThis, key, previous[key]);
  restoreOwnProperty(globalThis, "fetch", originalFetch);
}

function restoreOwnProperty(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

/** Mounts ProviderDetails on its default Overview tab and returns the rendered text. */
async function overviewText(
  item: WorkspaceItem,
  accounts: OAuthAccountRow[],
  oauthEmail?: string,
  accountLoadState: AccountLoadState = "ready",
  loggedIn: boolean | null = true,
): Promise<string> {
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
          accountLoadState={accountLoadState}
          oauth={{ loggedIn: loggedIn ?? undefined }}
          oauthEmail={oauthEmail}
        />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.id).toBe("pws-tab-overview");
  return host.textContent ?? "";
}

function currentAccount(): string | undefined {
  const row = Array.from(host.querySelectorAll(".pws-kv-row"))
    .find((entry) => entry.querySelector("dt")?.textContent === "Current account");
  return row?.querySelector("dd")?.textContent ?? undefined;
}

for (const item of [POOL_A, POOL_B]) {
  const email = "second@" + item.name + ".test";

  test(`${item.name} Overview names the active account by its alias`, async () => {
    const text = await overviewText(item, rows(item.name, { alias: "Work", maskedLabel: "s***d@example.test" }), email);
    expect(currentAccount()).toBe("Work");
    expect(text).not.toContain("Logged in as Work");
    expect(text).not.toContain("Spare");
    expect(text).not.toContain(email);
  });

  test(`${item.name} Overview falls back to the masked label, then the ordinal, never the email`, async () => {
    const masked = await overviewText(item, rows(item.name, { maskedLabel: "s***d@example.test" }), email);
    expect(currentAccount()).toBe("s***d@example.test");
    expect(masked).not.toContain(email);
    await act(async () => { root!.unmount(); });
    root = null;

    const ordinal = await overviewText(item, rows(item.name, {}), email);
    expect(currentAccount()).toBe("Account 2");
    expect(ordinal).not.toContain(email);
  });

  test(`${item.name} Overview treats a blank alias as missing`, async () => {
    const text = await overviewText(item, rows(item.name, { alias: "   ", maskedLabel: "s***d@example.test" }), email);
    expect(currentAccount()).toBe("s***d@example.test");
    expect(text).not.toContain(email);
  });

  test(`${item.name} Overview without an active account keeps the generic status`, async () => {
    const text = await overviewText(item, rows(item.name, { active: false }), email);
    expect(currentAccount()).toBeUndefined();
    expect(text).not.toContain("Logged in as");
    expect(text).not.toContain(email);
  });

  for (const state of ["idle", "loading", "error"] as const) {
    test(`${item.name} Overview hides stale account labels while roster is ${state}`, async () => {
      const text = await overviewText(item, rows(item.name, { alias: "Stale" }), email, state);
      expect(currentAccount()).toBeUndefined();
      expect(text).not.toContain("Stale");
      expect(text).not.toContain(email);
    });
  }

  test(`${item.name} Overview reports logged-out status without naming an account`, async () => {
    const text = await overviewText(item, [], email, "ready", false);
    expect(currentAccount()).toBeUndefined();
    expect(text).toContain("Not logged in");
    expect(text).not.toContain("Logged in as");
    expect(text).not.toContain(email);
  });

  test(`${item.name} Overview reports unknown login status as unverified`, async () => {
    const text = await overviewText(item, [], email, "ready", null);
    expect(currentAccount()).toBeUndefined();
    expect(text).toContain("Not verified");
    expect(text).not.toContain("Logged in as");
    expect(text).not.toContain(email);
  });
}

test("other OAuth providers keep the login identity in the Overview", async () => {
  const text = await overviewText(OTHER, rows("xai", { alias: "Work" }), "s***d@xai.test");
  expect(text).toContain("Logged in as s***d@xai.test");
  expect(currentAccount()).toBeUndefined();
});

/** #8344: teardown must leave every global exactly as it found it, absent ones included. */
test("teardown restores the original global property descriptors exactly", async () => {
  const keys = [...globals, "fetch"] as const;
  const expected = new Map(keys.map((k) => [k, originalDescriptors.get(k)]));
  await teardownDom();
  for (const k of keys) expect(Object.getOwnPropertyDescriptor(globalThis, k)).toEqual(expected.get(k));
});

/** #8344: a window that already existed comes back as the same object, without an added `event`. */
test("teardown leaves a pre-existing window object untouched", async () => {
  await teardownDom();
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const existing = { marker: "pre-existing" };
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: existing });
  try {
    setupDom();
    await teardownDom();
    expect((globalThis as { window?: unknown }).window).toBe(existing);
    expect(Object.getOwnPropertyNames(existing)).toEqual(["marker"]);
  } finally {
    restoreOwnProperty(globalThis, "window", priorWindow);
  }
});
