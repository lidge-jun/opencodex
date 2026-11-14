import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { GatewayClientStatus } from "../src/pages/integrations/gateway-clients-api";

/**
 * The Antigravity tab drives the gateway-client routes. These tests run the real component
 * against a fetch mock and assert what the user sees: the status the server reports, the
 * override warning, and the message an action answers with, success or refusal.
 */

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;

let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let requests: { method: string; url: string; body: string | null }[] = [];
let mountCount = 0;
let apiBase = "";
let clients: GatewayClientStatus[];
let actionResponse: () => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function client(overrides: Partial<GatewayClientStatus> & Pick<GatewayClientStatus, "id" | "label">): GatewayClientStatus {
  return { state: "disconnected", files: [], overrides: [], notes: [], ...overrides };
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#integrations/antigravity" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  requests = [];
  mountCount += 1;
  apiBase = `http://ocx-gateway-clients-${mountCount}.invalid`;
  clients = [
    client({
      id: "antigravity",
      label: "Antigravity",
      files: [{ path: "/home/u/.antigravity/settings.json", role: "gateway settings", exists: true }],
      overrides: [{ source: "admin_settings", detail: "/etc/antigravity/admin_settings.json" }],
    }),
    client({
      id: "agy",
      label: "agy CLI",
      state: "connected",
      files: [{ path: "/home/u/.gemini/agy.json", role: "CLI config", exists: false }],
      notes: ["Restart agy to pick up the change."],
    }),
  ];
  actionResponse = () => json({ ok: true, id: "antigravity", action: "connect", changed: true, changedFiles: [], message: "Antigravity now uses OpenCodex.", notes: [], status: clients[0] });
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    requests.push({ method, url, body: typeof init?.body === "string" ? init.body : null });
    return method === "POST" ? actionResponse() : json({ clients });
  }) as typeof fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: mockFetch });
  Object.defineProperty(testWindow, "fetch", { configurable: true, value: mockFetch });

  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  testWindow.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
});

async function settle(): Promise<void> {
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 30)); });
}

async function mount(): Promise<void> {
  const [{ createRoot }, { LanguageProvider }, { default: GatewayClientsPage }] = await Promise.all([
    import("react-dom/client"),
    import("../src/i18n/provider"),
    import("../src/pages/integrations/GatewayClientsPage"),
  ]);
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <GatewayClientsPage apiBase={apiBase} active />
      </LanguageProvider>,
    );
  });
  await settle();
}

function card(id: string): HTMLElement {
  const found = container.querySelector(`[data-gateway-client='${id}']`) as HTMLElement | null;
  if (!found) throw new Error(`no card for ${id}`);
  return found;
}

function button(scope: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll("button")).find(candidate => (candidate.textContent ?? "").trim() === label);
  if (!found) throw new Error(`no ${label} button`);
  return found as HTMLButtonElement;
}

test("lists both clients with state, files, notes and the admin_settings warning", async () => {
  await mount();
  const antigravity = card("antigravity");
  expect(antigravity.querySelector("[data-integration-state='absent']")).not.toBeNull();
  expect(antigravity.textContent).toContain("/home/u/.antigravity/settings.json");
  expect(antigravity.querySelector(".notice-warn")?.textContent).toContain("admin_settings.json sets a gateway");
  expect(antigravity.querySelector("input")).not.toBeNull();

  const agy = card("agy");
  expect(agy.querySelector("[data-integration-state='current']")).not.toBeNull();
  expect(agy.textContent).toContain("not created yet");
  expect(agy.textContent).toContain("Restart agy to pick up the change.");
  expect(agy.querySelector("input")).toBeNull();
  expect(button(antigravity, "Disconnect").disabled).toBe(true);
});

test("connect sends the typed model, shows the server message and rereads status", async () => {
  await mount();
  const antigravity = card("antigravity");
  const input = antigravity.querySelector("input") as HTMLInputElement;
  const setValue = Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, " gemini-3.8-flash ");
    input.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as unknown as Event);
  });
  const readsBefore = requests.filter(request => request.method === "GET").length;
  await act(async () => { button(antigravity, "Connect").click(); });
  await settle();

  const post = requests.find(request => request.method === "POST");
  expect(post?.url).toBe(`${apiBase}/api/gateway-clients/antigravity/connect`);
  expect(JSON.parse(post?.body ?? "{}")).toEqual({ model: "gemini-3.8-flash" });
  expect(card("antigravity").querySelector(".notice-ok")?.textContent).toContain("Antigravity now uses OpenCodex.");
  expect(requests.filter(request => request.method === "GET").length).toBeGreaterThan(readsBefore);
});

test("a refusal shows the server's own message", async () => {
  actionResponse = () => json({ ok: false, code: "unsupported-file", message: "settings.json is not a JSON object; left untouched." }, 409);
  await mount();
  await act(async () => { button(card("agy"), "Disconnect").click(); });
  await settle();
  expect(requests.find(request => request.method === "POST")?.url).toBe(`${apiBase}/api/gateway-clients/agy/disconnect`);
  expect(card("agy").querySelector(".notice-err")?.textContent).toContain("settings.json is not a JSON object; left untouched.");
});
