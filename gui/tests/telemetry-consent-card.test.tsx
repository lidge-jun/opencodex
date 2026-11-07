import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { DesktopStarOnboarding } from "../src/components/desktop-star-onboarding";
import { TelemetryConsentCard } from "../src/components/telemetry-consent-card";
import { LanguageProvider } from "../src/i18n/provider";
import type { TelemetryStatusSnapshot } from "../src/telemetry-api";

const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) OpenCodexDesktop/2.64.0";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
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
    effective: false,
    reason: "awaiting-notice",
    decision: null,
    decidedAt: null,
    noticeShownAt: null,
    envOverride: null,
    installChannel: "npm-global",
    lastSentDay: null,
    lastSentAt: null,
    preview: {
      schemaVersion: 1,
      batchId: "00000000-0000-4000-8000-000000000001",
      day: "2026-11-06",
      installDayHash: "0".repeat(64),
      newInstall: true,
      env: {
        version: "2.40.1",
        releaseChannel: "latest",
        os: "darwin",
        arch: "arm64",
        installChannel: "npm-global",
      },
      activeMinutes: 42,
      requests: { completed: 10, failed: 1, incomplete: 0, aborted: 0 },
      models: [],
      errors: {},
    },
    ...overrides,
  };
}

function setup(userAgent = BROWSER_UA) {
  win = new Window({ url: "http://127.0.0.1:10100/", settings: { navigator: { userAgent } } });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previous;
  originalFetch = globalThis.fetch;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  statusResponse = makeStatus();
  calls = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = new URL(String(input), "http://127.0.0.1").pathname;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push(body !== undefined ? { method, path, body } : { method, path });
      if (path === "/api/github/star") {
        return Response.json({ state: "not-starred", url: "https://github.com/lidge-jun/opencodex" });
      }
      if (path === "/api/telemetry" && method === "PUT") {
        const decision = (body as { decision: "accepted" | "declined" }).decision;
        statusResponse = {
          ...statusResponse,
          effective: decision === "accepted",
          reason: decision,
          decision,
          decidedAt: "2026-11-07T00:00:00.000Z",
          noticeShownAt: "2026-11-07T00:00:00.000Z",
        };
        return Response.json({ ok: true, ...statusResponse });
      }
      if (path === "/api/telemetry/notice" && method === "POST") {
        statusResponse = {
          ...statusResponse,
          effective: true,
          reason: "default-on",
          noticeShownAt: "2026-11-07T00:00:00.000Z",
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

async function mountCard(enabled = true) {
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
        <TelemetryConsentCard apiBase="" enabled={enabled} />
      </LanguageProvider>,
    );
  });
  await act(async () => {
    await new Promise(r => setTimeout(r, 20));
  });
}

function click(target: Element) {
  target.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
}

test("waits for DesktopStarOnboarding to settle before opening the telemetry consent dialog", async () => {
  setup(DESKTOP_UA);
  const { createRoot } = await import("react-dom/client");
  function SequencedHost() {
    const [settled, setSettled] = useState(false);
    return (
      <LanguageProvider>
        <DesktopStarOnboarding apiBase="" enabled onSettled={() => setSettled(true)} />
        <TelemetryConsentCard apiBase="" enabled={settled} />
      </LanguageProvider>
    );
  }
  await act(async () => {
    root = createRoot(host);
    root.render(<SequencedHost />);
  });
  await act(async () => {
    await new Promise(r => setTimeout(r, 1400));
  });

  // Only the star dialog is open; telemetry has not even fetched yet.
  expect(host.querySelector(".star-onboarding")).toBeTruthy();
  expect(host.querySelector(".telemetry-consent-card")).toBeNull();
  expect(calls).toEqual([{ method: "GET", path: "/api/github/star" }]);

  // Dismissing the star dialog settles it and allows the telemetry consent card to open.
  await act(async () => {
    click(host.querySelector(".star-onboarding .btn-ghost")!);
    await new Promise(r => setTimeout(r, 20));
  });
  expect(host.querySelector(".star-onboarding")).toBeNull();
  expect(host.querySelector(".telemetry-consent-card")).toBeTruthy();
  expect(calls).toEqual([
    { method: "GET", path: "/api/github/star" },
    { method: "GET", path: "/api/telemetry" },
  ]);
});

test("opens with pre-checked checkbox, shows preview JSON, and records nothing on open alone", async () => {
  setup();
  await mountCard();
  const card = host.querySelector(".telemetry-consent-card");
  expect(card).toBeTruthy();
  const checkbox = host.querySelector<HTMLInputElement>(".telemetry-consent-checkbox")!;
  expect(checkbox).toBeTruthy();
  expect(checkbox.checked).toBe(true);
  expect(host.querySelector(".telemetry-preview-json")?.textContent).toContain(`"day": "2026-11-06"`);
  // Opening alone must not send POST /api/telemetry/notice or PUT /api/telemetry.
  expect(calls).toEqual([{ method: "GET", path: "/api/telemetry" }]);
});

test("also opens after an update when reason is default-on without a recorded decision", async () => {
  setup();
  statusResponse = makeStatus({
    effective: true,
    reason: "default-on",
    decision: null,
    noticeShownAt: "2026-11-01T00:00:00.000Z",
  });
  await mountCard();
  expect(host.querySelector(".telemetry-consent-card")).toBeTruthy();
  expect(calls).toEqual([{ method: "GET", path: "/api/telemetry" }]);
});

test("Continue with pre-checked checkbox sends PUT accepted and closes", async () => {
  setup();
  await mountCard();
  const continueBtn = host.querySelector<HTMLButtonElement>(".telemetry-consent-card .btn-primary")!;
  await act(async () => {
    click(continueBtn);
    await new Promise(r => setTimeout(r, 20));
  });
  expect(calls).toEqual([
    { method: "GET", path: "/api/telemetry" },
    { method: "PUT", path: "/api/telemetry", body: { decision: "accepted" } },
  ]);
  expect(host.querySelector(".telemetry-consent-card")).toBeNull();
});

test("unchecking the checkbox and clicking Continue sends PUT declined", async () => {
  setup();
  await mountCard();
  const checkbox = host.querySelector<HTMLInputElement>(".telemetry-consent-checkbox")!;
  await act(async () => {
    click(checkbox);
  });
  expect(checkbox.checked).toBe(false);

  const continueBtn = host.querySelector<HTMLButtonElement>(".telemetry-consent-card .btn-primary")!;
  await act(async () => {
    click(continueBtn);
    await new Promise(r => setTimeout(r, 20));
  });
  expect(calls).toEqual([
    { method: "GET", path: "/api/telemetry" },
    { method: "PUT", path: "/api/telemetry", body: { decision: "declined" } },
  ]);
  expect(host.querySelector(".telemetry-consent-card")).toBeNull();
});

test("Escape and backdrop dismiss send POST /api/telemetry/notice without recording a decision", async () => {
  setup();
  await mountCard();
  const dialog = host.querySelector("dialog.telemetry-consent-overlay")!;
  expect(dialog).toBeTruthy();

  const WindowEvent = (win as unknown as { Event: typeof Event }).Event;
  await act(async () => {
    dialog.dispatchEvent(new WindowEvent("cancel", { bubbles: false, cancelable: true }));
    await new Promise(r => setTimeout(r, 20));
  });
  expect(calls).toEqual([
    { method: "GET", path: "/api/telemetry" },
    { method: "POST", path: "/api/telemetry/notice" },
  ]);
  expect(host.querySelector(".telemetry-consent-card")).toBeNull();

  // Backdrop dismiss also sends POST /api/telemetry/notice without recording a decision.
  statusResponse = makeStatus();
  calls = [];
  await mountCard();
  const backdrop = host.querySelector<HTMLButtonElement>(".modal-backdrop-dismiss")!;
  expect(backdrop).toBeTruthy();
  await act(async () => {
    click(backdrop);
    await new Promise(r => setTimeout(r, 20));
  });
  expect(calls).toEqual([
    { method: "GET", path: "/api/telemetry" },
    { method: "POST", path: "/api/telemetry/notice" },
  ]);
  expect(host.querySelector(".telemetry-consent-card")).toBeNull();
});

test("stays hidden once decided or when an environment opt-out override is active", async () => {
  setup();
  for (const state of [
    makeStatus({ effective: true, reason: "accepted", decision: "accepted" }),
    makeStatus({ effective: false, reason: "declined", decision: "declined" }),
    makeStatus({ effective: false, reason: "env-ocx-telemetry", envOverride: "OCX_TELEMETRY" }),
    makeStatus({ effective: false, reason: "env-do-not-track", envOverride: "DO_NOT_TRACK" }),
  ]) {
    statusResponse = state;
    calls = [];
    await mountCard();
    expect(host.querySelector(".telemetry-consent-card")).toBeNull();
    expect(calls).toEqual([{ method: "GET", path: "/api/telemetry" }]);
    if (root) {
      const current = root;
      await act(async () => {
        current.unmount();
      });
      root = null;
    }
  }
});
