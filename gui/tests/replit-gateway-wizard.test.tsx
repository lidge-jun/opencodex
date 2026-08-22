import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ReplitGatewayWizard from "../src/components/replit-gateway/ReplitGatewayWizard";
import { MAX_REPLIT_GATEWAY_KEY_LENGTH } from "../src/components/replit-gateway/replit-gateway-validation";

const ORIGIN = "https://my-app.replit.app";
const GATEWAY_KEY = "gateway-key-01234567890123456789012";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;
let requests: Array<{ method: string; path: string; body?: unknown; signal?: AbortSignal }>;
let simulateCollision = false;
let fetchMode: "ok" | "network" | "malformed" | "malformed-success" | "hang" = "ok";
let closeCalls = 0;
let addedProvider: string | null = null;

beforeEach(() => {
  previous = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previous;
  originalFetch = globalThis.fetch;
  requests = [];
  simulateCollision = false;
  fetchMode = "ok";
  closeCalls = 0;
  addedProvider = null;
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
      const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
      requests.push({ method: init?.method ?? "GET", path: url.pathname, body, signal: init?.signal ?? undefined });
      if (fetchMode === "network") throw new TypeError("network down");
      if (fetchMode === "hang") return await new Promise(() => {});
      if (url.pathname === "/api/providers/replit-pair" && init?.method === "POST") {
        if (fetchMode === "malformed") return new Response("not-json", { status: 500 });
        if (fetchMode === "malformed-success") {
          return Response.json({ success: true }, { status: 200 });
        }
        if (!body || typeof body !== "object") return Response.json({ error: "bad body" }, { status: 400 });
        const record = body as Record<string, unknown>;
        if (simulateCollision && record.replace !== true) {
          return Response.json({
            error: "replit provider pair already exists",
            code: "provider_collision",
            collisions: ["replit", "replit-anthropic"],
          }, { status: 409 });
        }
        return Response.json({
          success: true,
          providers: ["replit", "replit-anthropic"],
          probe: {
            ok: true,
            healthz: { status: 200, latencyMs: 10 },
            models: { status: 200, modelCount: 2, latencyMs: 20 },
          },
        });
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

async function mountWizard() {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <ReplitGatewayWizard
          apiBase=""
          onClose={() => { closeCalls += 1; }}
          onInstalled={(name) => { addedProvider = name; }}
        />
      </LanguageProvider>,
    );
  });
  return host.querySelector("dialog.replit-gateway-wizard")!;
}

function field(id: string) {
  return host.querySelector<HTMLInputElement>(`#${id}`);
}

function setFieldValue(element: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value");
  descriptor?.set?.call(element, value);
  element.dispatchEvent(new win.Event("input", { bubbles: true }));
  element.dispatchEvent(new win.Event("change", { bubbles: true }));
}

test("focuses the origin field on open", async () => {
  await mountWizard();
  expect(document.activeElement).toBe(field("replit-gateway-origin"));
  expect(document.activeElement?.classList.contains("modal-backdrop-dismiss")).toBe(false);
});

test("labels origin and gateway key fields for accessibility", async () => {
  await mountWizard();
  expect(host.querySelector("label[for='replit-gateway-origin']")?.textContent).toContain("Deployment origin");
  expect(host.querySelector("label[for='replit-gateway-key']")?.textContent).toContain("Gateway key");
  expect(field("replit-gateway-key")?.maxLength).toBe(MAX_REPLIT_GATEWAY_KEY_LENGTH);
  expect(field("replit-gateway-key")?.getAttribute("aria-describedby")).toBeTruthy();
});

test("posts atomic install request shape without claiming a canonical preset", async () => {
  await mountWizard();
  await act(async () => {
    setFieldValue(field("replit-gateway-origin")!, ORIGIN);
    setFieldValue(field("replit-gateway-key")!, GATEWAY_KEY);
    host.querySelector<HTMLButtonElement>(".replit-gateway-install")!.click();
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const install = requests.find(r => r.path === "/api/providers/replit-pair");
  expect(install?.method).toBe("POST");
  expect(install?.body).toEqual({
    origin: ORIGIN,
    gatewayKey: GATEWAY_KEY,
    allowCustomDomain: false,
    replace: false,
    setDefault: false,
  });
  expect(host.textContent).toContain("custom companion workflow");
  expect(host.textContent).not.toMatch(/official Replit provider/i);
});

test("requires explicit replace confirmation on collision", async () => {
  simulateCollision = true;
  await mountWizard();
  const installButton = host.querySelector<HTMLButtonElement>(".replit-gateway-install")!;
  await act(async () => {
    setFieldValue(field("replit-gateway-origin")!, ORIGIN);
    setFieldValue(field("replit-gateway-key")!, GATEWAY_KEY);
    installButton.click();
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const replaceDialog = host.querySelector("dialog.replit-gateway-replace-dialog")!;
  expect(replaceDialog).toBeTruthy();
  expect(document.activeElement?.classList.contains("replit-gateway-replace-confirm")).toBe(true);
  await act(async () => {
    host.querySelector<HTMLButtonElement>(".replit-gateway-replace-confirm")!.click();
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const bodies = requests
    .filter(r => r.path === "/api/providers/replit-pair")
    .map(r => r.body as Record<string, unknown>);
  expect(bodies[0]?.replace).toBe(false);
  expect(bodies[1]?.replace).toBe(true);
  expect(addedProvider).toBe("replit");
  expect(host.textContent).toContain("healthz");
  expect(host.textContent).toContain("2");
});

test("replace cancel restores focus to the install control", async () => {
  simulateCollision = true;
  await mountWizard();
  const installButton = host.querySelector<HTMLButtonElement>(".replit-gateway-install")!;
  await act(async () => {
    setFieldValue(field("replit-gateway-origin")!, ORIGIN);
    setFieldValue(field("replit-gateway-key")!, GATEWAY_KEY);
    installButton.click();
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  await act(async () => {
    host.querySelector<HTMLButtonElement>(".replit-gateway-replace-cancel")!.click();
  });
  expect(host.querySelector("dialog.replit-gateway-replace-dialog")).toBeNull();
  expect(document.activeElement).toBe(installButton);
});

test("custom-domain opt-in is explicit in the request body", async () => {
  await mountWizard();
  await act(async () => {
    setFieldValue(field("replit-gateway-origin")!, "https://gateway.example.com");
    setFieldValue(field("replit-gateway-key")!, GATEWAY_KEY);
    host.querySelector<HTMLInputElement>("#replit-gateway-custom-domain")!.click();
    host.querySelector<HTMLButtonElement>(".replit-gateway-install")!.click();
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const install = requests.find(r => r.path === "/api/providers/replit-pair");
  expect((install?.body as Record<string, unknown>)?.allowCustomDomain).toBe(true);
});

test("does not expose a billable live probe action", async () => {
  await mountWizard();
  expect(host.querySelector(".replit-gateway-live-probe")).toBeNull();
  expect(host.textContent).not.toMatch(/chat completion|billable live probe/i);
});

test("network failure leaves the form recoverable", async () => {
  fetchMode = "network";
  await mountWizard();
  await act(async () => {
    setFieldValue(field("replit-gateway-origin")!, ORIGIN);
    setFieldValue(field("replit-gateway-key")!, GATEWAY_KEY);
    host.querySelector<HTMLButtonElement>(".replit-gateway-install")!.click();
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(host.textContent).toContain("Could not reach the proxy");
  expect(host.querySelector(".replit-gateway-install")).not.toBeNull();
  expect(host.querySelector(".replit-gateway-install")?.hasAttribute("disabled")).toBe(false);
});

test("malformed response leaves the form recoverable", async () => {
  fetchMode = "malformed";
  await mountWizard();
  await act(async () => {
    setFieldValue(field("replit-gateway-origin")!, ORIGIN);
    setFieldValue(field("replit-gateway-key")!, GATEWAY_KEY);
    host.querySelector<HTMLButtonElement>(".replit-gateway-install")!.click();
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(host.textContent).toContain("invalid response");
  expect(host.querySelector(".replit-gateway-install")?.hasAttribute("disabled")).toBe(false);
});

test("rejects invalid gateway key characters before POST", async () => {
  await mountWizard();
  await act(async () => {
    setFieldValue(field("replit-gateway-origin")!, ORIGIN);
    setFieldValue(field("replit-gateway-key")!, `gateway key-${"0".repeat(24)}`);
    host.querySelector<HTMLButtonElement>(".replit-gateway-install")!.click();
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(requests.some(r => r.path === "/api/providers/replit-pair")).toBe(false);
  expect(field("replit-gateway-key")?.getAttribute("aria-invalid")).toBe("true");
  expect(host.textContent).toContain("printable ASCII");
});

test("aborts in-flight install on unmount", async () => {
  fetchMode = "hang";
  await mountWizard();
  await act(async () => {
    setFieldValue(field("replit-gateway-origin")!, ORIGIN);
    setFieldValue(field("replit-gateway-key")!, GATEWAY_KEY);
    host.querySelector<HTMLButtonElement>(".replit-gateway-install")!.click();
  });
  const signal = requests[0]?.signal;
  expect(signal).toBeDefined();
  await act(async () => { root?.unmount(); root = null; });
  expect(signal?.aborted).toBe(true);
});

test("malformed success payload leaves the form recoverable", async () => {
  fetchMode = "malformed-success";
  await mountWizard();
  await act(async () => {
    setFieldValue(field("replit-gateway-origin")!, ORIGIN);
    setFieldValue(field("replit-gateway-key")!, GATEWAY_KEY);
    host.querySelector<HTMLButtonElement>(".replit-gateway-install")!.click();
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(host.textContent).toContain("invalid response");
  expect(addedProvider).toBeNull();
  expect(host.querySelector(".replit-gateway-install")?.hasAttribute("disabled")).toBe(false);
});

test("Escape closes the wizard when idle", async () => {
  const dialog = await mountWizard();
  const WindowEvent = (win as unknown as { Event: typeof Event }).Event;
  await act(async () => {
    dialog.dispatchEvent(new WindowEvent("cancel", { bubbles: false, cancelable: true }));
  });
  expect(closeCalls).toBe(1);
});
