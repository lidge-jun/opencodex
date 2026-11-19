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
      files: [{ path: "/home/u/.antigravity/settings.json", role: "user settings", exists: true }],
      overrides: [{ source: "admin_settings", code: "admin-gateway", detail: "organization admin_settings.json sets the gateway" }],
      notes: [{ code: "restart-app", text: "Restart Antigravity to apply a change." }, { code: "no-google-sign-in", text: "In gateway mode the app does not use the Google sign-in." }],
      defaultModel: "gemini-3-pro",
    }),
    client({
      id: "agy",
      label: "agy CLI",
      state: "connected",
      files: [{ path: "/home/u/.bashrc", role: "shell profile", exists: false }],
      notes: [{ code: "agy-version", text: "Gateway support needs agy 1.2.15 or newer." }],
    }),
  ];
  actionResponse = () => json({ ok: true, id: "antigravity", action: "connect", changed: true, changedFiles: [], message: "Antigravity now uses OpenCodex.", notes: [{ code: "restart-app", text: "Restart Antigravity to apply a change." }], status: clients[0] });
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

test("lists both clients with state, files, translated notes and the admin_settings warning", async () => {
  await mount();
  const antigravity = card("antigravity");
  expect(antigravity.querySelector("[data-gateway-state='disconnected']")?.textContent).toBe("Not connected");
  expect(antigravity.textContent).toContain("/home/u/.antigravity/settings.json");
  expect(antigravity.querySelector(".notice-warn")?.textContent).toBe("Your organization's admin_settings.json sets a gateway, so this connection has no effect.");
  expect(antigravity.textContent).toContain("While connected, the app does not use your Google sign-in.");
  // The server's English never reaches the page, and the restart hint waits for an action.
  expect(antigravity.textContent).not.toContain("In gateway mode");
  expect(antigravity.textContent).not.toContain("Restart Antigravity");
  expect((antigravity.querySelector("input") as HTMLInputElement).value).toBe("gemini-3-pro");

  const agy = card("agy");
  expect(agy.querySelector("[data-gateway-state='connected']")?.textContent).toBe("Connected");
  expect(agy.textContent).toContain("not created yet");
  expect(agy.textContent).toContain("Needs agy 1.2.15 or newer.");
  expect(agy.querySelector("input")).toBeNull();
  expect(button(antigravity, "Disconnect").disabled).toBe(true);
});

test("connect sends the typed model, says once to restart and rereads status", async () => {
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
  expect(card("antigravity").querySelector(".notice-ok")?.textContent).toBe("Connected. Restart Antigravity to apply it.");
  expect(requests.filter(request => request.method === "GET").length).toBeGreaterThan(readsBefore);
});

test("an untouched model field sends no model, so the current one is kept", async () => {
  await mount();
  await act(async () => { button(card("antigravity"), "Connect").click(); });
  await settle();
  expect(JSON.parse(requests.find(request => request.method === "POST")?.body ?? "null")).toEqual({});
});

test("a refusal is translated from its code, and an I/O error keeps the system text", async () => {
  actionResponse = () => json({ ok: false, code: "unsupported-file", message: "settings.json is not a JSON object; left untouched." }, 409);
  await mount();
  await act(async () => { button(card("agy"), "Disconnect").click(); });
  await settle();
  expect(requests.find(request => request.method === "POST")?.url).toBe(`${apiBase}/api/gateway-clients/agy/disconnect`);
  expect(card("agy").querySelector(".notice-err")?.textContent).toBe("settings.json could not be read as a JSON object, so OpenCodex left it untouched. Fix the file, then try again.");

  actionResponse = () => json({ ok: false, code: "io-error", message: "EACCES: permission denied" }, 409);
  await act(async () => { button(card("agy"), "Disconnect").click(); });
  await settle();
  expect(card("agy").querySelector(".notice-err code")?.textContent).toBe("EACCES: permission denied");
});
