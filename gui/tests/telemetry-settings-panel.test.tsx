import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import TelemetrySettingsPanel from "../src/components/TelemetrySettingsPanel";
import { LanguageProvider } from "../src/i18n/provider";
import AdvancedHub from "../src/pages/AdvancedHub";
import { PROXY_SECTION_IDS } from "../src/pages/dashboard-section-ids";
import type { TelemetryStatusSnapshot } from "../src/telemetry-api";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;
let statusResponse: TelemetryStatusSnapshot;
let calls: Array<{ method: string; path: string; body?: unknown }>;

function makeStatus(overrides: Partial<TelemetryStatusSnapshot> = {}): TelemetryStatusSnapshot {
  return {
    effective: true,
    reason: "accepted",
    decision: "accepted",
    decidedAt: "2026-11-07T00:00:00.000Z",
    noticeShownAt: "2026-11-07T00:00:00.000Z",
    envOverride: null,
    installChannel: "npm-global",
    lastSentDay: "2026-11-06",
    lastSentAt: "2026-11-07T01:00:00.000Z",
    preview: {
      schemaVersion: 1,
      batchId: "00000000-0000-4000-8000-000000000002",
      day: "2026-11-06",
      installDayHash: "a".repeat(64),
      newInstall: false,
      env: {
        version: "2.40.1",
        releaseChannel: "latest",
        os: "darwin",
        arch: "arm64",
        installChannel: "npm-global",
      },
      activeMinutes: 312,
      requests: { completed: 840, failed: 12, incomplete: 3, aborted: 5 },
      models: [],
      errors: { "rate-limit": 7 },
    },
    ...overrides,
  };
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previous;
  originalFetch = globalThis.fetch;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  win = new Window({ url: "http://127.0.0.1:10100/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
  statusResponse = makeStatus();
  calls = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = new URL(String(input), "http://127.0.0.1").pathname;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push(body !== undefined ? { method, path, body } : { method, path });
      if (path === "/api/telemetry" && method === "PUT") {
        const decision = (body as { decision: "accepted" | "declined" }).decision;
        statusResponse = {
          ...statusResponse,
          effective: decision === "accepted",
          reason: decision,
          decision,
        };
        return Response.json({ ok: true, ...statusResponse });
      }
      return Response.json(statusResponse);
    },
  });
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => {
      current.unmount();
    });
    root = null;
  }
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  }
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  await win.happyDOM?.close?.();
});

async function mountPanel(readOnly = false) {
  const { createRoot } = await import("react-dom/client");
  if (root) {
    const current = root;
    await act(async () => {
      current.unmount();
    });
    root = null;
  }
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <TelemetrySettingsPanel apiBase="" readOnly={readOnly} />
      </LanguageProvider>,
    );
  });
  await act(async () => {
    await new Promise(r => setTimeout(r, 30));
  });
}

function click(target: Element) {
  target.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
}

function toggleSwitch(): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>('button[role="switch"]')!;
}

test("switch mirrors effective state and toggles off and back on via PUT /api/telemetry", async () => {
  await mountPanel();
  expect(toggleSwitch().getAttribute("aria-checked")).toBe("true");
  expect(toggleSwitch().disabled).toBe(false);

  await act(async () => {
    click(toggleSwitch());
    await new Promise(r => setTimeout(r, 20));
  });
  expect(calls).toContainEqual({
    method: "PUT",
    path: "/api/telemetry",
    body: { decision: "declined" },
  });
  expect(toggleSwitch().getAttribute("aria-checked")).toBe("false");

  await act(async () => {
    click(toggleSwitch());
    await new Promise(r => setTimeout(r, 20));
  });
  expect(calls).toContainEqual({
    method: "PUT",
    path: "/api/telemetry",
    body: { decision: "accepted" },
  });
  expect(toggleSwitch().getAttribute("aria-checked")).toBe("true");
});

test("disables switch and renders a warning notice naming the variable when OCX_TELEMETRY=0 or DO_NOT_TRACK=1 is set", async () => {
  statusResponse = makeStatus({
    effective: false,
    reason: "env-ocx-telemetry",
    envOverride: "OCX_TELEMETRY",
  });
  await mountPanel();
  expect(toggleSwitch().getAttribute("aria-checked")).toBe("false");
  expect(toggleSwitch().disabled).toBe(true);
  const warn = host.querySelector(".notice-warn");
  expect(warn?.textContent).toContain("OCX_TELEMETRY=0");

  if (root) {
    const current = root;
    await act(async () => {
      current.unmount();
    });
    root = null;
  }
  statusResponse = makeStatus({
    effective: false,
    reason: "env-do-not-track",
    envOverride: "DO_NOT_TRACK",
  });
  await mountPanel();
  expect(toggleSwitch().disabled).toBe(true);
  expect(host.querySelector(".notice-warn")?.textContent).toContain("DO_NOT_TRACK=1");
});

test("disables switch in readOnly mode for Remote Link children", async () => {
  await mountPanel(true);
  expect(toggleSwitch().getAttribute("aria-checked")).toBe("true");
  expect(toggleSwitch().disabled).toBe(true);
  await act(async () => {
    click(toggleSwitch());
    await new Promise(r => setTimeout(r, 20));
  });
  expect(calls).toEqual([{ method: "GET", path: "/api/telemetry" }]);
});

test("What is sent button opens the preview dialog with the exact JSON payload and closes cleanly", async () => {
  await mountPanel();
  expect(host.querySelector("dialog.telemetry-preview-overlay")).toBeNull();

  const trigger = host.querySelector<HTMLButtonElement>(".telemetry-preview-trigger")!;
  expect(trigger).toBeTruthy();
  await act(async () => {
    click(trigger);
  });

  const dialog = host.querySelector("dialog.telemetry-preview-overlay");
  expect(dialog).toBeTruthy();
  const pre = dialog?.querySelector("pre.telemetry-preview-json");
  expect(pre?.textContent).toBe(JSON.stringify(statusResponse.preview, null, 2));

  const closeBtn = dialog?.querySelector<HTMLButtonElement>(".modal-actions .btn-primary")!;
  await act(async () => {
    click(closeBtn);
  });
  expect(host.querySelector("dialog.telemetry-preview-overlay")).toBeNull();
});

test("PROXY_SECTION_IDS registers proxy-telemetry and AdvancedHub matches telemetry and privacy search queries", async () => {
  expect(PROXY_SECTION_IDS).toContainEqual(["proxy-telemetry", "proxyV2.secTelemetry"]);

  const { createRoot } = await import("react-dom/client");
  const navigated: string[] = [];
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <AdvancedHub navigate={page => navigated.push(page)} />
      </LanguageProvider>,
    );
  });
  const searchInput = host.querySelector<HTMLInputElement>('input[type="search"]')!;
  expect(searchInput).toBeTruthy();

  for (const query of ["telemetry", "privacy"]) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
      setter?.call(searchInput, query);
      searchInput.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
      searchInput.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event);
      await new Promise(r => setTimeout(r, 20));
    });
    expect(host.textContent).toContain("1 shown");
  }
});
