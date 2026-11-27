import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import AddProviderModal from "../src/components/AddProviderModal";
import type { AccountLoginStatus } from "../src/components/provider-catalog/ProviderCatalog";

/**
 * Kimi (Responses) signs in through the Kimi login (#8087). With Kimi already signed in the
 * picker adds the row without a second login; otherwise it logs in through Kimi and asks the
 * server to publish only the Kimi (Responses) row, never the user's Kimi Chat row.
 */

const KIMI_BASE = "https://api.kimi.com/coding/v1";
const PRESETS = [
  { id: "kimi", label: "Kimi", adapter: "openai-chat", baseUrl: KIMI_BASE, auth: "oauth", oauthProvider: "kimi", defaultModel: "kimi-for-coding" },
  { id: "kimi-responses", label: "Kimi (Responses)", adapter: "openai-responses", baseUrl: KIMI_BASE, auth: "oauth", oauthProvider: "kimi", defaultModel: "kimi-for-coding" },
];

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;
let posts: Array<{ path: string; body: Record<string, unknown> }> = [];

beforeEach(() => {
  previous = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previous;
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
  posts = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if ((init?.method ?? "GET") === "POST") {
        posts.push({ path: url.pathname, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
        if (url.pathname === "/api/oauth/login") return Response.json({ url: "https://auth.kimi.test/device", deviceCode: "ABCD-EFGH" });
        return Response.json({ success: true });
      }
      if (url.pathname === "/api/oauth/providers") return Response.json({ providers: ["kimi"] });
      if (url.pathname === "/api/provider-presets") return Response.json({ providers: PRESETS });
      if (url.pathname === "/api/oauth/status") return Response.json({ loggedIn: false });
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
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  await win.happyDOM?.close?.();
});

async function settle() {
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

async function mountModal(accountStatus: Record<string, AccountLoginStatus>, onAdded: (name: string) => void) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <AddProviderModal apiBase="" existingNames={["kimi"]} initialTier="paid" accountStatus={accountStatus}
          onClose={() => {}} onAdded={onAdded} />
      </LanguageProvider>,
    );
  });
  await settle();
}

function click(fragment: string) {
  const el = Array.from(host.querySelectorAll("button, [role='button']")).find((node) =>
    (node.textContent ?? "").includes(fragment));
  expect(el).toBeTruthy();
  (el as HTMLElement).dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
}

test("with Kimi signed in, the sibling row is added without another login", async () => {
  const added: string[] = [];
  await mountModal({ kimi: { loggedIn: true } }, (name) => added.push(name));
  click("Kimi (Responses)");
  await settle();
  expect(host.textContent).toContain("Kimi (Responses) signs in with your Kimi (Moonshot) login.");
  click("Add Kimi (Responses) with your Kimi (Moonshot) login");
  await settle();
  expect(posts.map((post) => post.path)).toEqual(["/api/providers"]);
  expect(posts[0]!.body).toMatchObject({
    name: "kimi-responses",
    provider: { adapter: "openai-responses", baseUrl: KIMI_BASE, authMode: "oauth" },
  });
  expect(added).toEqual(["kimi-responses"]);
});

test("without a Kimi login, the sibling logs in through Kimi and publishes only its own row", async () => {
  await mountModal({ kimi: { loggedIn: false } }, () => {});
  click("Kimi (Responses)");
  await settle();
  click("Log in with Kimi (Moonshot)");
  await settle();
  const login = posts.find((post) => post.path === "/api/oauth/login");
  expect(login?.body).toMatchObject({ provider: "kimi", row: "kimi-responses" });
  expect(posts.some((post) => post.path === "/api/providers")).toBe(false);
});

test("a stored Kimi credential does not finish a pending sibling login early", async () => {
  // The poll waits 2 s between reads; hold those timers and release them one at a time.
  const polls: Array<() => void> = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: () => void, ms?: number) => {
    if (ms === 2_000) { polls.push(callback); return 0; }
    return realSetTimeout(callback, ms);
  }) as unknown as typeof setTimeout;
  let flow: "pending" | "complete" = "pending";
  const fetchStub = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(input), "http://localhost").pathname === "/api/oauth/status") {
      return Response.json({ loggedIn: true, status: flow, done: flow === "complete",
        ...(flow === "pending" ? { hint: { url: "https://auth.kimi.test/device", deviceCode: "ABCD-EFGH" } } : {}) });
    }
    return fetchStub(input, init);
  } });
  try {
    const added: string[] = [];
    await mountModal({ kimi: { loggedIn: false } }, (name) => added.push(name));
    click("Kimi (Responses)");
    await settle();
    click("Log in with Kimi (Moonshot)");
    await settle();
    await act(async () => { polls.shift()!(); });
    await settle();
    expect(added).toEqual([]);
    expect(host.textContent).toContain("ABCD-EFGH");
    flow = "complete";
    await act(async () => { polls.shift()!(); });
    await settle();
    expect(added).toEqual(["kimi-responses"]);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test("the Antigravity Accounts catalog opens management without posting a provider replacement", async () => {
  const { createRoot } = await import("react-dom/client");
  const managed: string[] = [];
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider>
      <AddProviderModal apiBase="" initialTier="accounts" existingNames={["antigravity-acp"]}
        accountRows={[{ id: "antigravity-acp", label: "Antigravity ACP", kind: "agy" }]}
        onAccountManage={id => managed.push(id)} onClose={() => {}} onAdded={() => {}} />
    </LanguageProvider>);
  });
  await settle();
  const row = Array.from(host.querySelectorAll(".provider-catalog-account-row"))
    .find(node => node.textContent?.includes("Antigravity ACP"));
  expect(row).toBeDefined();
  act(() => row!.querySelector("button")!.click());
  expect(managed).toEqual(["antigravity-acp"]);
  expect(posts).toEqual([]);
});

test("the Antigravity account panel waits for completed login and explicitly switches the selected label", async () => {
  const { createRoot } = await import("react-dom/client");
  const { default: AgyAccounts } = await import("../src/components/provider-workspace/AgyAccounts");
  const names = ["default"];
  let selected = "default";
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (url: string, init?: RequestInit) => {
    expect(url).toEndWith("/api/antigravity-acp/accounts");
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posts.push({ path: url, body });
      if (body.action === "add") return Response.json({ pending: body.name }, { status: 202 });
      if (body.action === "remove") {
        names.splice(names.indexOf(body.name), 1);
        if (selected === body.name) selected = "default";
      } else selected = body.name;
    }
    return Response.json({ names, selected, canOpenTerminal: true });
  } });
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><AgyAccounts apiBase="" /></LanguageProvider>);
  });
  await settle();
  const input = host.querySelector("input")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "work");
    input.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
  });
  expect(host.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled).toBe(false);
  await act(async () => { host.querySelector("form")!.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event); });
  await settle();
  expect(posts.map(p => p.body)).toEqual([{ action: "add", name: "work" }]);
  expect(host.querySelectorAll("li")).toHaveLength(1);
  names.push("work");
  await act(async () => click("Refresh"));
  await settle();
  expect(host.querySelectorAll("li")).toHaveLength(2);
  expect(selected).toBe("default");
  await act(async () => click("Use this account"));
  await settle();
  expect(host.querySelector("li.pwi-auth-row--active")?.textContent).toContain("work");
  expect(posts.map(p => p.body)).toEqual([{ action: "add", name: "work" }, { action: "use", name: "work" }]);
  expect(host.querySelector('button[aria-label="Remove default"]')).toBeNull();
  const remove = () => host.querySelector<HTMLButtonElement>('button[aria-label="Remove work"]')!.click();
  act(remove);
  expect(posts).toHaveLength(2);
  await act(async () => click("Cancel"));
  expect(host.querySelector('[role="group"]')).toBeNull();
  act(remove);
  await act(async () => {
    const group = host.querySelector('[role="group"]')!;
    expect(group.textContent).toContain("local login and CLI data for work");
    Array.from(group.querySelectorAll("button")).find(button => button.textContent === "Delete")!.click();
  });
  await settle();
  expect(posts.at(-1)?.body).toEqual({ action: "remove", name: "work" });
  expect(host.querySelectorAll("li")).toHaveLength(1);
  expect(host.querySelector("li.pwi-auth-row--active")?.textContent).toContain("Default CLI account");

});
