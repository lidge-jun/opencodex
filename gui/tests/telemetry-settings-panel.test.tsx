import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import TelemetrySettingsPanel from "../src/components/TelemetrySettingsPanel";
import { TelemetryConsentCard } from "../src/components/telemetry-consent-card";
import { LanguageProvider } from "../src/i18n/provider";
import AdvancedHub from "../src/pages/AdvancedHub";
import { PROXY_SECTION_IDS } from "../src/pages/dashboard-section-ids";
import {
  TELEMETRY_STATUS_CHANGED_EVENT,
  type TelemetryStatusSnapshot,
} from "../src/telemetry-api";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;
let statusResponse: TelemetryStatusSnapshot;
let calls: Array<{ method: string; path: string; body?: unknown }>;
let failMethods: Set<string>;
/** When set, PUT /api/telemetry answers with this instead of saving. */
let putReply: (() => Response) | null;
let statusEvents: TelemetryStatusSnapshot[];

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
  failMethods = new Set();
  statusEvents = [];
  putReply = null;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = new URL(String(input), "http://127.0.0.1").pathname;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push(body !== undefined ? { method, path, body } : { method, path });
      if (failMethods.has(`${method} ${path}`)) {
        return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
      }
      if (path === "/api/telemetry" && method === "PUT") {
        if (putReply) return putReply();
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

test("a Remote Link child shows only the Home hint and fetches nothing", async () => {
  await mountPanel(true);
  // /api/telemetry is not a link-readable path, so a fetch would only produce a permanent error.
  expect(calls).toEqual([]);
  expect(toggleSwitch()).toBeNull();
  expect(host.querySelector(".telemetry-preview-trigger")).toBeNull();
  expect(host.querySelector(".notice-err")).toBeNull();
  expect(host.querySelector(".telemetry-settings-row")?.textContent).toContain("Managed on the Home proxy for this Remote Link.");
});

test("Preview the JSON button opens the preview dialog with autoFocus on Close and restores focus after unmount", async () => {
  await mountPanel();
  expect(host.querySelector("dialog.telemetry-preview-overlay")).toBeNull();

  const trigger = host.querySelector<HTMLButtonElement>(".telemetry-preview-trigger")!;
  expect(trigger).toBeTruthy();
  expect(trigger.textContent).toBe("Preview the JSON");
  await act(async () => {
    click(trigger);
  });

  const dialog = host.querySelector<HTMLDialogElement>("dialog.telemetry-preview-overlay");
  expect(dialog).toBeTruthy();
  const descId = dialog?.getAttribute("aria-describedby");
  expect(descId).toBeTruthy();
  expect(dialog?.querySelector(`#${descId}`)?.classList.contains("modal-desc")).toBe(true);
  const pre = dialog?.querySelector("pre.telemetry-preview-json");
  expect(pre?.textContent).toBe(JSON.stringify(statusResponse.preview, null, 2));
  expect(dialog?.querySelector(".telemetry-preview-ineligible")).toBeNull();

  const closeBtn = dialog?.querySelector<HTMLButtonElement>(".modal-actions .btn-primary")!;
  expect(win.document.activeElement).toBe(closeBtn as unknown as Element);

  let dialogPresentDuringFocusRestore = true;
  const origFocus = trigger.focus.bind(trigger);
  trigger.focus = () => {
    dialogPresentDuringFocusRestore = host.querySelector("dialog.telemetry-preview-overlay") !== null;
    origFocus();
  };
  await act(async () => {
    click(closeBtn);
  });
  expect(host.querySelector("dialog.telemetry-preview-overlay")).toBeNull();
  expect(dialogPresentDuringFocusRestore).toBe(false);
  expect(win.document.activeElement).toBe(trigger as unknown as Element);
});

test("preview dialog shows 'This day would not be sent' when previewEligible is false", async () => {
  statusResponse = makeStatus({ previewEligible: false });
  await mountPanel();

  const trigger = host.querySelector<HTMLButtonElement>(".telemetry-preview-trigger")!;
  await act(async () => {
    click(trigger);
  });

  const dialog = host.querySelector<HTMLDialogElement>("dialog.telemetry-preview-overlay");
  expect(dialog).toBeTruthy();
  expect(dialog?.querySelector(".telemetry-preview-ineligible")?.textContent).toBe(
    "This day would not be sent",
  );
});

test("never stacks preview dialog over an open TelemetryConsentCard and opens once the consent dialog closes", async () => {
  statusResponse = makeStatus({
    effective: false,
    reason: "awaiting-notice",
    decision: null,
    decidedAt: null,
    noticeShownAt: null,
  });
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <TelemetryConsentCard apiBase="" enabled />
        <TelemetrySettingsPanel apiBase="" />
      </LanguageProvider>,
    );
  });
  await act(async () => {
    await new Promise(r => setTimeout(r, 30));
  });

  expect(host.querySelector("dialog.telemetry-consent-overlay")).toBeTruthy();
  expect(host.querySelector("dialog.telemetry-preview-overlay")).toBeNull();

  const trigger = host.querySelector<HTMLButtonElement>(".telemetry-preview-trigger")!;
  await act(async () => {
    click(trigger);
  });
  // Preview dialog must defer while the consent modal is open.
  expect(host.querySelectorAll("dialog")).toHaveLength(1);
  expect(host.querySelector("dialog.telemetry-preview-overlay")).toBeNull();

  // Dismissing the consent dialog allows the deferred preview dialog to open alone.
  const backdrop = host.querySelector<HTMLButtonElement>("dialog.telemetry-consent-overlay .modal-backdrop-dismiss")!;
  await act(async () => {
    click(backdrop);
    await new Promise(r => setTimeout(r, 20));
  });
  expect(host.querySelector("dialog.telemetry-consent-overlay")).toBeNull();
  expect(host.querySelector("dialog.telemetry-preview-overlay")).toBeTruthy();
  expect(host.querySelectorAll("dialog")).toHaveLength(1);
});

test("surfaces GET and PUT failures with error notices and preserves switch state on write failure", async () => {
  win.addEventListener(TELEMETRY_STATUS_CHANGED_EVENT, ((event: Event) => {
    const detail = (event as CustomEvent<TelemetryStatusSnapshot>).detail;
    if (detail) statusEvents.push(detail);
  }) as never);

  // 1. GET /api/telemetry failure renders error notice, disables switch, and recovers on Retry.
  failMethods.add("GET /api/telemetry");
  await mountPanel();
  expect(toggleSwitch().disabled).toBe(true);
  expect(toggleSwitch().getAttribute("aria-checked")).toBe("false");
  expect(host.querySelector(".notice-err")?.textContent).toContain("Could not load telemetry status.");

  failMethods.clear();
  const retryBtn = host.querySelector<HTMLButtonElement>(".telemetry-settings-row .btn-ghost")!;
  await act(async () => {
    click(retryBtn);
    await new Promise(r => setTimeout(r, 20));
  });
  expect(host.querySelector(".notice-err")).toBeNull();
  expect(toggleSwitch().disabled).toBe(false);
  expect(toggleSwitch().getAttribute("aria-checked")).toBe("true");

  // 2. PUT /api/telemetry failure preserves aria-checked, renders error notice, and emits no status change.
  failMethods.add("PUT /api/telemetry");
  await act(async () => {
    click(toggleSwitch());
    await new Promise(r => setTimeout(r, 20));
  });
  expect(toggleSwitch().getAttribute("aria-checked")).toBe("true");
  expect(host.querySelector(".notice-err")?.textContent).toContain("Could not save telemetry preference.");
  expect(statusEvents).toEqual([]);
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

test("a save whose reply and re-read both fail says so and holds the switch until a read succeeds", async () => {
  await mountPanel();
  expect(toggleSwitch().getAttribute("aria-checked")).toBe("true");
  putReply = () => new Response("not json", { status: 200 });
  failMethods.add("GET /api/telemetry");
  await act(async () => {
    click(toggleSwitch());
    await new Promise(r => setTimeout(r, 30));
  });
  // The decline may be saved, so the switch is not left looking like sending is on without a word.
  expect(host.querySelector(".notice-warn")?.textContent).toContain("Could not confirm the telemetry setting yet");
  expect(toggleSwitch().disabled).toBe(true);
  expect(host.querySelector(".notice-err")).toBeNull();
  // The confirming read failed too, so a manual Retry is offered.
  expect(host.querySelector(".telemetry-settings-row .btn-ghost")?.textContent).toBe("Retry");

  // The next successful read clears it.
  failMethods.clear();
  putReply = null;
  statusResponse = { ...statusResponse, effective: false, reason: "declined", decision: "declined" };
  await act(async () => {
    win.dispatchEvent(new win.CustomEvent(TELEMETRY_STATUS_CHANGED_EVENT, { detail: statusResponse }) as unknown as Event);
    await new Promise(r => setTimeout(r, 20));
  });
  expect(host.querySelector(".notice-warn")).toBeNull();
  expect(toggleSwitch().disabled).toBe(false);
  expect(toggleSwitch().getAttribute("aria-checked")).toBe("false");
});

test("a save whose request drops or times out is treated as unconfirmed, since the server may have saved it", async () => {
  await mountPanel();
  expect(toggleSwitch().getAttribute("aria-checked")).toBe("true");
  putReply = () => {
    throw new TypeError("network connection was lost");
  };
  await act(async () => {
    click(toggleSwitch());
    await new Promise(r => setTimeout(r, 30));
  });
  // No "could not save": the status is read again instead, and the switch follows the server.
  expect(host.querySelector(".notice-err")).toBeNull();
  expect(calls.filter(call => call.method === "GET").length).toBeGreaterThanOrEqual(2);
  expect(host.querySelector(".notice-warn")).toBeNull();
  expect(toggleSwitch().disabled).toBe(false);
});
