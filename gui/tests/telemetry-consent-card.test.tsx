import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { DesktopStarOnboarding } from "../src/components/desktop-star-onboarding";
import { TelemetryConsentCard } from "../src/components/telemetry-consent-card";
import { LanguageProvider } from "../src/i18n/provider";
import * as telemetryApi from "../src/telemetry-api";
import {
  TELEMETRY_STATUS_CHANGED_EVENT,
  type TelemetryStatusSnapshot,
} from "../src/telemetry-api";

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
let failMethods: Set<string>;
let statusEvents: TelemetryStatusSnapshot[];
/** When set, PUT /api/telemetry answers with this instead of saving. */
let putReply: (() => Response) | null;

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
    previewEligible: false,
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
      if (path === "/api/github/star") {
        return Response.json({ state: "not-starred", url: "https://github.com/lidge-jun/opencodex" });
      }
      if (path === "/api/telemetry" && method === "PUT") {
        if (putReply) return putReply();
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
  expect(card?.querySelector("h3")?.textContent).toBe("Help improve opencodex with anonymous usage stats");
  expect(card?.querySelector(".modal-desc")?.textContent).toContain(
    "telemetry.opencodex.me; only project-wide totals are published at opencodex.me/dashboard",
  );
  expect(card?.querySelector(".modal-desc")?.textContent).toContain("OCX_TELEMETRY=0 or DO_NOT_TRACK=1");
  expect(card?.querySelector("summary")?.textContent).toBe("Preview the JSON");
  const checkbox = host.querySelector<HTMLInputElement>(".telemetry-consent-checkbox")!;
  expect(checkbox).toBeTruthy();
  expect(checkbox.checked).toBe(true);
  expect(host.querySelector(".telemetry-preview-ineligible")?.textContent).toBe(
    "This day would not be sent",
  );
  expect(host.querySelector(".telemetry-preview-json")?.textContent).toContain(`"day": "2026-11-06"`);
  // Opening alone must not send any write request.
  expect(calls).toEqual([{ method: "GET", path: "/api/telemetry" }]);

  // When previewEligible is true or omitted, the ineligible note is not rendered.
  statusResponse = makeStatus({ previewEligible: true });
  await mountCard();
  expect(host.querySelector(".telemetry-preview-ineligible")).toBeNull();

  delete statusResponse.previewEligible;
  await mountCard();
  expect(host.querySelector(".telemetry-preview-ineligible")).toBeNull();
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

test("Escape and backdrop dismiss record nothing and the popup returns on the next app start while undecided", async () => {
  setup();
  expect("postTelemetryNotice" in telemetryApi).toBe(false);
  expect(telemetryApi.parseTelemetryStatus({ effective: false, previewEligible: false })?.previewEligible).toBe(false);
  expect(telemetryApi.parseTelemetryStatus({ effective: true, previewEligible: true })?.previewEligible).toBe(true);
  expect(telemetryApi.parseTelemetryStatus({ effective: true })?.previewEligible).toBeUndefined();
  win.addEventListener(TELEMETRY_STATUS_CHANGED_EVENT, ((event: Event) => {
    const detail = (event as CustomEvent<TelemetryStatusSnapshot>).detail;
    if (detail) statusEvents.push(detail);
  }) as never);

  await mountCard();
  const dialog = host.querySelector("dialog.telemetry-consent-overlay")!;
  expect(dialog).toBeTruthy();

  const WindowEvent = (win as unknown as { Event: typeof Event }).Event;
  await act(async () => {
    dialog.dispatchEvent(new WindowEvent("cancel", { bubbles: false, cancelable: true }));
    await new Promise(r => setTimeout(r, 20));
  });
  expect(calls).toEqual([{ method: "GET", path: "/api/telemetry" }]);
  expect(host.querySelector(".telemetry-consent-card")).toBeNull();
  expect(statusEvents).toEqual([]);

  // Escape keydown on the dialog also closes without recording anything.
  calls = [];
  await mountCard();
  const dialogOnNextStart = host.querySelector("dialog.telemetry-consent-overlay")!;
  expect(dialogOnNextStart).toBeTruthy();
  await act(async () => {
    dialogOnNextStart.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event,
    );
    await new Promise(r => setTimeout(r, 20));
  });
  expect(calls).toEqual([{ method: "GET", path: "/api/telemetry" }]);
  expect(host.querySelector(".telemetry-consent-card")).toBeNull();
  expect(statusEvents).toEqual([]);

  // Next app start while still undecided: popup returns, and backdrop dismiss also records nothing.
  calls = [];
  await mountCard();
  expect(host.querySelector(".telemetry-consent-card")).toBeTruthy();
  const backdrop = host.querySelector<HTMLButtonElement>(".modal-backdrop-dismiss")!;
  expect(backdrop).toBeTruthy();
  await act(async () => {
    click(backdrop);
    await new Promise(r => setTimeout(r, 20));
  });
  expect(calls).toEqual([{ method: "GET", path: "/api/telemetry" }]);
  expect(host.querySelector(".telemetry-consent-card")).toBeNull();
  expect(statusEvents).toEqual([]);

  // Subsequent app start while still undecided: popup returns again.
  calls = [];
  await mountCard();
  expect(host.querySelector(".telemetry-consent-card")).toBeTruthy();
  expect(calls).toEqual([{ method: "GET", path: "/api/telemetry" }]);
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

test("subscribes to TELEMETRY_STATUS_CHANGED_EVENT and closes when a decision is recorded elsewhere", async () => {
  setup();
  await mountCard();
  expect(host.querySelector(".telemetry-consent-card")).toBeTruthy();

  const CustomEventCtor = (win as unknown as { CustomEvent: typeof CustomEvent }).CustomEvent;
  const decided = makeStatus({
    effective: false,
    reason: "declined",
    decision: "declined",
    decidedAt: "2026-11-07T00:00:00.000Z",
  });
  await act(async () => {
    win.dispatchEvent(new CustomEventCtor(TELEMETRY_STATUS_CHANGED_EVENT, { detail: decided }));
    await new Promise(r => setTimeout(r, 20));
  });
  expect(host.querySelector(".telemetry-consent-card")).toBeNull();
  expect(calls).toEqual([{ method: "GET", path: "/api/telemetry" }]);
});

test("defers opening while another modal dialog is open and opens once it closes", async () => {
  setup();
  const otherDialog = win.document.createElement("dialog") as unknown as HTMLDialogElement;
  otherDialog.className = "modal-overlay other-modal";
  otherDialog.setAttribute("open", "");
  win.document.body.appendChild(otherDialog as never);

  await mountCard();
  expect(host.querySelector("dialog.telemetry-consent-overlay")).toBeNull();

  await act(async () => {
    otherDialog.removeAttribute("open");
    otherDialog.remove();
    await new Promise(r => setTimeout(r, 20));
  });
  expect(host.querySelector("dialog.telemetry-consent-overlay")).toBeTruthy();
});

test("handles GET and PUT failures without recording consent or trapping the user", async () => {
  setup();
  win.addEventListener(TELEMETRY_STATUS_CHANGED_EVENT, ((event: Event) => {
    const detail = (event as CustomEvent<TelemetryStatusSnapshot>).detail;
    if (detail) statusEvents.push(detail);
  }) as never);

  // 1. GET /api/telemetry failure keeps the consent card closed and writes nothing.
  failMethods.add("GET /api/telemetry");
  await mountCard();
  expect(host.querySelector(".telemetry-consent-card")).toBeNull();
  expect(calls).toEqual([{ method: "GET", path: "/api/telemetry" }]);
  expect(statusEvents).toEqual([]);

  // 2. PUT /api/telemetry failure keeps the card open, shows error notice, and emits no status change.
  if (root) {
    const current = root;
    await act(async () => {
      current.unmount();
    });
    root = null;
  }
  failMethods.clear();
  failMethods.add("PUT /api/telemetry");
  calls = [];
  await mountCard();
  const continueBtn = host.querySelector<HTMLButtonElement>(".telemetry-consent-card .btn-primary")!;
  await act(async () => {
    click(continueBtn);
    await new Promise(r => setTimeout(r, 20));
  });
  expect(host.querySelector(".telemetry-consent-card")).toBeTruthy();
  expect(host.querySelector(".notice-err")?.textContent).toContain("Could not save telemetry preference.");
  expect(continueBtn.disabled).toBe(false);
  expect(statusEvents).toEqual([]);

  // Retry after clearing failure succeeds and closes the dialog.
  failMethods.clear();
  await act(async () => {
    click(continueBtn);
    await new Promise(r => setTimeout(r, 20));
  });
  expect(host.querySelector(".telemetry-consent-card")).toBeNull();
  expect(statusEvents).toHaveLength(1);
  expect(statusEvents[0]?.decision).toBe("accepted");
});

test("App does not enable DesktopStarOnboarding or TelemetryConsentCard on a Remote Link Child when target discovery fails", async () => {
  setup(DESKTOP_UA);
  win.localStorage.setItem("ocx-desktop-star-onboarding", "seen");
  for (const [name, content] of [
    ["opencodex-runtime-role", "client"],
    ["opencodex-session-token", "ocx_session_test"],
    ["opencodex-session-csrf", "test-csrf"],
    ["opencodex-session-origin", "http://127.0.0.1:10100"],
    ["opencodex-session-server-origin", "http://127.0.0.1:10100"],
  ] as const) {
    const meta = win.document.createElement("meta");
    meta.setAttribute("name", name);
    meta.setAttribute("content", content);
    win.document.head.appendChild(meta);
  }
  (globalThis as Record<string, unknown>).__APP_VERSION__ = "0.0.0-test";
  failMethods.add("GET /api/machine/status");

  const [{ createRoot }, { default: App }, { resetApiAuthFetchForTests, installApiAuthFetch, installApiSessionFromHtml }] = await Promise.all([
    import("react-dom/client"),
    import("../src/App"),
    import("../src/api"),
  ]);
  resetApiAuthFetchForTests();
  Object.defineProperty(win, "fetch", { configurable: true, value: globalThis.fetch });
  installApiAuthFetch();
  installApiSessionFromHtml(
    "shared",
    '<meta name="opencodex-session-token" content="ocx_session_test"><meta name="opencodex-session-csrf" content="test-csrf"><meta name="opencodex-session-origin" content="http://127.0.0.1:10100"><meta name="opencodex-session-server-origin" content="http://127.0.0.1:10100">',
  );
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: win.fetch });
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <App />
      </LanguageProvider>,
    );
  });
  await act(async () => {
    await new Promise(r => setTimeout(r, 60));
  });
  resetApiAuthFetchForTests();
  expect(host.querySelector(".star-onboarding")).toBeNull();
  expect(calls.some(c => c.path === "/api/telemetry")).toBe(false);
  expect(host.querySelector("dialog.telemetry-consent-overlay")).toBeNull();
});

test("focus starts on the heading after showModal, so a stray Enter cannot accept", async () => {
  setup();
  await mountCard();
  const heading = host.querySelector(".telemetry-consent-card h3");
  expect(heading).toBeTruthy();
  expect(win.document.activeElement).toBe(heading as unknown as Element);
  const continueBtn = host.querySelector(".telemetry-consent-card .btn-primary");
  expect(win.document.activeElement).not.toBe(continueBtn as unknown as Element);
  expect(calls).toEqual([{ method: "GET", path: "/api/telemetry" }]);
});

test("links the full privacy policy, the same URL the CLI and installer show", async () => {
  setup();
  await mountCard();
  const link = host.querySelector<HTMLAnchorElement>(".telemetry-consent-card a.telemetry-policy-link");
  expect(link?.textContent).toBe("Read the full privacy policy");
  expect(link?.getAttribute("href")).toBe(telemetryApi.TELEMETRY_POLICY_URL);
  expect(link?.getAttribute("target")).toBe("_blank");
  const disclosure = readFileSync(join(import.meta.dir, "..", "..", "src", "telemetry", "disclosure.ts"), "utf8");
  expect(disclosure).toContain(`export const TELEMETRY_POLICY_URL = "${telemetryApi.TELEMETRY_POLICY_URL}";`);
  const items = host.querySelector(".telemetry-consent-card")?.textContent ?? "";
  expect(items).toContain("A per-day install hash that changes every day");
  expect(items).toContain("release channel");
  expect(items).toContain("first-report flag");
  expect(items).toContain("account IDs or emails");
});

test("a session the server refuses for consent explains how to choose instead of a generic error", async () => {
  setup();
  putReply = () =>
    Response.json(
      { ok: false, code: "agent_consent_required", error: "Telemetry consent requires a human dashboard session." },
      { status: 403 },
    );
  await mountCard();
  await act(async () => {
    click(host.querySelector(".telemetry-consent-card .btn-primary")!);
    await new Promise(r => setTimeout(r, 20));
  });
  // Nothing was recorded, the popup stays, and the notice names the ways that work.
  expect(host.querySelector(".telemetry-consent-card")).toBeTruthy();
  const notice = host.querySelector(".telemetry-consent-card .notice-err")?.textContent ?? "";
  expect(notice).toContain("restored from a remembered device");
  expect(notice).toContain("ocx telemetry disable");
  expect(notice).not.toContain("Could not save telemetry preference");
});

test("a saved decision whose reply and re-read both fail still counts as saved", async () => {
  setup();
  await mountCard();
  putReply = () => new Response("not json", { status: 200 });
  failMethods.add("GET /api/telemetry");
  await act(async () => {
    click(host.querySelector(".telemetry-consent-card .btn-primary")!);
    await new Promise(r => setTimeout(r, 20));
  });
  expect(calls.filter(call => call.method === "PUT")).toEqual([
    { method: "PUT", path: "/api/telemetry", body: { decision: "accepted" } },
  ]);
  expect(host.querySelector(".telemetry-consent-card")).toBeNull();
  expect(host.querySelector(".notice-err")).toBeNull();
});

test("a Continue whose request drops reads the status back and closes if the choice was saved", async () => {
  setup();
  await mountCard();
  // The server saved the decline, but the connection dropped before the reply.
  putReply = () => {
    statusResponse = { ...statusResponse, effective: false, reason: "declined", decision: "declined", decidedAt: "2026-11-07T00:00:00.000Z", noticeShownAt: "2026-11-07T00:00:00.000Z" };
    throw new TypeError("network connection was lost");
  };
  await act(async () => {
    click(host.querySelector(".telemetry-consent-checkbox")!);
  });
  await act(async () => {
    click(host.querySelector(".telemetry-consent-card .btn-primary")!);
    await new Promise(r => setTimeout(r, 30));
  });
  expect(host.querySelector(".telemetry-consent-card")).toBeNull();

  // When nothing was saved, the popup stays and says so.
  statusResponse = makeStatus();
  putReply = () => {
    throw new TypeError("network connection was lost");
  };
  await mountCard();
  await act(async () => {
    click(host.querySelector(".telemetry-consent-card .btn-primary")!);
    await new Promise(r => setTimeout(r, 30));
  });
  expect(host.querySelector(".telemetry-consent-card")).toBeTruthy();
  expect(host.querySelector(".telemetry-consent-card .notice-err")?.textContent).toContain("Could not save telemetry preference");
});
