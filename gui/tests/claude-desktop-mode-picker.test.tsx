import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ClaudeDesktop from "../src/pages/ClaudeDesktop";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";

/**
 * The connection-mode picker decides which of two mutually exclusive Desktop
 * configurations the apply request asks for. Mounted tests because the
 * failures that matter are wiring: the radio must follow /status, a changed
 * selection must reach the POST body, and the gateway-only "not active
 * profile" check must not leak into first-party status.
 */

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let requests: { url: string; init?: RequestInit }[] = [];

const MODEL = {
  route: "prov/opus-0",
  label: "Opus Model",
  available: true,
  contextWindow: 200_000,
  effortSupported: true,
  assignment: { family: "opus", alias: "alias-opus" },
};

function profilePayload() {
  return {
    profile: {
      version: 1,
      assignments: { [MODEL.route]: MODEL.assignment },
      defaults: { opus: MODEL.route, fable: null, sonnet: null, haiku: null },
    },
    models: [MODEL],
    rendered: [],
    port: 10100,
  };
}

function statusPayload(overrides: Record<string, unknown> = {}) {
  return {
    desiredEnabled: true,
    applied: true,
    appliedAt: null,
    stale: false,
    health: { lastRequestAt: null, requestCount: 0, errorCount: 0 },
    mode: "first-party",
    firstParty: {
      applied: true,
      stale: false,
      interceptEnabled: true,
      interceptRunning: true,
      proxyPort: 10200,
      caCertPath: "/tmp/ocx/claude-intercept/ca.pem",
    },
    ...overrides,
  };
}

function installFetch(status: Record<string, unknown>) {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      const path = String(url);
      const body = path.includes("/status")
        ? status
        : path.endsWith("/apply")
          ? { ok: true, mode: JSON.parse(String(init?.body ?? "{}")).mode }
          : init?.method === "PUT"
            ? { ok: true }
            : profilePayload();
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
    },
  });
}

beforeEach(() => {
  clearClientResourceStoresForTests();
  requests = [];
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  installFetch(statusPayload());
  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  clearClientResourceStoresForTests();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mount() {
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><ClaudeDesktop apiBase="" /></LanguageProvider>);
  });
  await act(async () => { await new Promise(r => setTimeout(r, 50)); });
}

function radio(mode: "first-party" | "gateway"): HTMLInputElement {
  const found = container.querySelector(`input[name="claude-desktop-mode"][value="${mode}"]`);
  if (!found) throw new Error(`mode radio not found: ${mode}`);
  return found as unknown as HTMLInputElement;
}

function applyButton(): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button.btn-primary"))
    .find(button => /apply/i.test(button.textContent ?? ""));
  if (!found) throw new Error("apply button not found");
  return found as unknown as HTMLButtonElement;
}

async function click(element: HTMLElement) {
  await act(async () => { element.click(); });
}

test("a failed /status unlocks the picker on the default without claiming a current mode", async () => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string) => {
      const path = String(url);
      if (path.includes("/status")) {
        return { ok: false, status: 503, json: async () => ({ error: "down" }), text: async () => "down" } as unknown as Response;
      }
      const body = profilePayload();
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
    },
  });

  await mount();
  await act(async () => { await new Promise(r => setTimeout(r, 200)); });

  expect((container.querySelector(".claude-mode-picker") as HTMLFieldSetElement).disabled).toBe(false);
  expect(radio("first-party").checked).toBe(true);
  expect(radio("gateway").checked).toBe(false);
  expect(container.querySelector(".claude-mode-current")).toBeNull();
  expect(container.querySelector(".claude-status-bar")?.textContent ?? "").toContain("Failed to load");
});

test("the picker follows the effective mode reported by /status and shows the proxy port", async () => {
  await mount();
  expect(radio("first-party").checked).toBe(true);
  expect(radio("gateway").checked).toBe(false);
  const firstPartyOption = radio("first-party").closest("label")!;
  expect(firstPartyOption.querySelector(".claude-mode-default")).not.toBeNull();
  expect(firstPartyOption.querySelector(".claude-mode-current")).not.toBeNull();
  expect(container.querySelector(".claude-mode-switch-note")).toBeNull();

  const bar = container.querySelector(".claude-status-bar")!;
  expect(bar.className).toContain("applied");
  expect(bar.textContent ?? "").toContain("First-party: Code tab routed through the local proxy");
  expect(bar.textContent ?? "").toContain("127.0.0.1:10200");
  expect(applyButton().textContent).toBe("Save & apply");
});

test("a stopped intercept proxy is surfaced in first-party mode", async () => {
  installFetch(statusPayload({
    firstParty: { applied: true, stale: false, interceptEnabled: true, interceptRunning: false, proxyPort: 10200, caCertPath: "/tmp/ca.pem" },
  }));
  await mount();
  expect(container.querySelector(".claude-status-bar")?.textContent ?? "").toContain("is not running");
});

test("selecting the other mode flips the apply label and sends that mode in the POST body", async () => {
  await mount();
  await act(async () => {
    radio("gateway").click();
  });
  expect(radio("gateway").checked).toBe(true);
  expect(container.querySelector(".claude-mode-switch-note")).not.toBeNull();
  expect(applyButton().textContent).toBe("Switch mode & apply");

  await click(applyButton());
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });

  const apply = requests.find(r => r.url.endsWith("/api/claude-desktop/apply"));
  expect(apply).toBeDefined();
  expect(apply!.init?.method).toBe("POST");
  expect(JSON.parse(String(apply!.init?.body))).toEqual({ mode: "gateway" });
});

test("the default apply keeps the effective mode when nothing was chosen", async () => {
  installFetch(statusPayload({ mode: "gateway", activeProfile: true, firstParty: undefined }));
  await mount();
  expect(radio("gateway").checked).toBe(true);
  await click(applyButton());
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
  const apply = requests.find(r => r.url.endsWith("/api/claude-desktop/apply"));
  expect(JSON.parse(String(apply!.init?.body))).toEqual({ mode: "gateway" });
});

test("activeProfile=false only demotes the status bar in gateway mode", async () => {
  // First-party never writes a Desktop profile, so Desktop serving some other
  // profile is irrelevant and must not paint the bar as not-applied.
  installFetch(statusPayload({ activeProfile: false }));
  await mount();
  expect(container.querySelector(".claude-status-bar")!.className).toContain("applied");
  expect(container.querySelector(".claude-status-bar")!.className).not.toContain("not-applied");

  await act(async () => { root!.unmount(); root = null; });
  clearClientResourceStoresForTests();
  installFetch(statusPayload({ mode: "gateway", activeProfile: false, firstParty: undefined }));
  await mount();
  expect(container.querySelector(".claude-status-bar")!.className).toContain("not-applied");
});

test("no radio is checked and the picker is disabled until /status answers", async () => {
  // A gateway install must never see the first-party default flash while /status is in flight.
  let releaseStatus: () => void = () => {};
  const gate = new Promise<void>(resolve => { releaseStatus = resolve; });
  const gatewayStatus = statusPayload({ mode: "gateway", activeProfile: true, firstParty: undefined });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string) => {
      const path = String(url);
      if (path.includes("/status")) await gate;
      const body = path.includes("/status") ? gatewayStatus : profilePayload();
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
    },
  });
  await mount();
  expect(radio("first-party").checked).toBe(false);
  expect(radio("gateway").checked).toBe(false);
  expect((container.querySelector(".claude-mode-picker") as HTMLFieldSetElement).disabled).toBe(true);
  expect(container.querySelector(".claude-mode-current")).toBeNull();
  expect(container.querySelector(".claude-mode-switch-note")).toBeNull();

  releaseStatus();
  await act(async () => { await new Promise(r => setTimeout(r, 50)); });
  expect(radio("gateway").checked).toBe(true);
  expect(radio("first-party").checked).toBe(false);
  expect((container.querySelector(".claude-mode-picker") as HTMLFieldSetElement).disabled).toBe(false);
});

test("an unknown mode in /status is rejected as malformed", async () => {
  installFetch(statusPayload({ mode: "proxy" }));
  await mount();
  expect(container.textContent ?? "").toContain("Failed to load Claude Desktop profile.");
});
