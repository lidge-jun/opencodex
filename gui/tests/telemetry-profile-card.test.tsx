import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { TelemetryProfileCard } from "../src/components/telemetry-profile-card";
import { LanguageProvider } from "../src/i18n/provider";
import { TELEMETRY_STATUS_CHANGED_EVENT } from "../src/telemetry-api";
import { profileLeaderboardUrl } from "../src/telemetry-profile-api";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;
let calls: Array<{ method: string; path: string; body?: unknown }>;
let status: Record<string, unknown>;
let rank: Record<string, unknown>;
let deleteReply: Record<string, unknown>;
let postReply: () => Response | Promise<Response>;

const PROFILE = { handle: "jun-dev", displayName: "Jun", avatar: "teal", connectedAt: "2026-11-01T00:00:00.000Z", lastSentDay: "2026-11-08", pendingDelete: false, revoked: false };

function setup() {
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
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previous;
  originalFetch = globalThis.fetch;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  calls = [];
  status = { ok: true, connected: false, unreadable: false, profile: null, telemetryEffective: true, nextDay: null };
  rank = {
    periods: {
      day: { rank: 3, of: 41, tokens: 1_250_000, requests: 210 },
      week: { rank: 1, of: 97, tokens: 9_800_000, requests: 1400 },
      month: { rank: null, of: 120, tokens: 0, requests: 0 },
    },
    families: [{ family: "claude-opus", requests: 900, tokens: 7_000_000 }, { family: "gpt-6", requests: 500, tokens: 2_800_000 }],
  };
  deleteReply = { ok: true, status: "deleted", deleted: true };
  postReply = () => {
    status = { ...status, connected: true, profile: PROFILE };
    return Response.json({ ok: true, ...status });
  };
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = new URL(String(input), "http://127.0.0.1").pathname;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push(body !== undefined ? { method, path, body } : { method, path });
      if (path === "/api/telemetry/profile/rank") return Response.json({ ok: true, rank });
      if (method === "POST") return postReply();
      if (method === "DELETE") {
        if (deleteReply.status === "deleted") status = { ...status, connected: false, profile: null };
        else status = { ...status, profile: { ...PROFILE, pendingDelete: true } };
        return Response.json(deleteReply);
      }
      return Response.json(status);
    },
  });
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

async function settle(ms = 20) {
  await act(async () => { await new Promise(r => setTimeout(r, ms)); });
}

async function mount() {
  setup();
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><TelemetryProfileCard apiBase="" /></LanguageProvider>);
  });
  await settle();
}

function card() {
  return host.querySelector('[data-testid="telemetry-profile-card"]');
}

function buttonByText(text: string): HTMLButtonElement {
  const button = [...host.querySelectorAll("button")].find(b => b.textContent?.trim() === text);
  if (!button) throw new Error(`no button ${text}`);
  return button as HTMLButtonElement;
}

async function click(target: Element) {
  await act(async () => { target.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event); });
  await settle();
}

async function type(name: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
  });
}

test("hidden while anonymous telemetry is off and nothing is connected", async () => {
  status = { ...status, telemetryEffective: false };
  await mount();
  expect(card()).toBeNull();
});

test("hidden when the profile route is refused, as on a Remote Link Child", async () => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => new Response(JSON.stringify({ error: "not link-readable" }), { status: 403 }),
  });
  await mount();
  expect(card()).toBeNull();
});

test("connect stays disabled until a valid handle, a name, a colour and the public acknowledgement", async () => {
  await mount();
  expect(card()?.textContent).toContain("Never shared");
  await click(buttonByText("Connect"));
  const submit = () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  expect(submit().disabled).toBe(true);
  await type("handle", "Jun-Dev");
  await type("displayName", "Jun");
  expect(submit().disabled).toBe(true);
  await click(host.querySelector('button[aria-label="teal"]')!);
  expect(submit().disabled).toBe(true);
  const checkbox = host.querySelector<HTMLInputElement>('input[name="acknowledgePublic"]')!;
  expect(checkbox.checked).toBe(false);
  await click(checkbox);
  expect(submit().disabled).toBe(false);
  await click(submit());
  await settle(50);
  const post = calls.find(c => c.method === "POST")!;
  expect(post).toEqual({ method: "POST", path: "/api/telemetry/profile", body: { handle: "jun-dev", displayName: "Jun", avatar: "teal", acknowledgePublic: true } });
  expect(card()?.textContent).toContain("@jun-dev");
});

test("a refused session explains how to connect instead", async () => {
  postReply = () => new Response(JSON.stringify({ ok: false, code: "agent_consent_required" }), { status: 403 });
  await mount();
  await click(buttonByText("Connect"));
  await type("handle", "jun");
  await type("displayName", "Jun");
  await click(host.querySelector('button[aria-label="blue"]')!);
  await click(host.querySelector('input[name="acknowledgePublic"]')!);
  await click(host.querySelector('button[type="submit"]')!);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("ocx telemetry profile connect");
});

test("a connected profile shows ranks, totals, top families and a leaderboard link", async () => {
  status = { ...status, connected: true, profile: PROFILE };
  await mount();
  const text = card()?.textContent ?? "";
  expect(text).toContain("#3 of 41");
  expect(text).toContain("#1 of 97");
  expect(text).toContain("Not ranked yet");
  expect(text).toContain("claude-opus, gpt-6");
  const link = [...host.querySelectorAll("a")].find(a => a.textContent === "View leaderboard")!;
  expect(link.getAttribute("href")).toBe("https://opencodex.me/dashboard/?profile=jun-dev#leaderboard");
});

test("disconnect asks first, then deletes; an unreachable service shows the pending state", async () => {
  status = { ...status, connected: true, profile: PROFILE };
  deleteReply = { ok: true, status: "deletion_pending", deleted: false };
  await mount();
  await click(buttonByText("Disconnect"));
  expect(calls.some(c => c.method === "DELETE")).toBe(false);
  await click(buttonByText("Delete profile"));
  await settle(50);
  expect(calls.filter(c => c.method === "DELETE")).toHaveLength(1);
  expect(card()?.textContent).toContain("Deletion is pending");
  deleteReply = { ok: true, status: "deleted", deleted: true };
  await click(buttonByText("Retry"));
  await settle(50);
  expect(calls.filter(c => c.method === "DELETE")).toHaveLength(2);
});

test("a connected profile stays visible to disconnect while anonymous telemetry is off", async () => {
  status = { ...status, connected: true, profile: PROFILE, telemetryEffective: false };
  await mount();
  expect(card()?.textContent).toContain("Paused while anonymous telemetry is off");
  expect(buttonByText("Disconnect")).toBeTruthy();
});

test("a pending deletion shows from the disconnect reply even when the refresh cannot reach the proxy", async () => {
  status = { ...status, connected: true, profile: PROFILE };
  await mount();
  const realFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "DELETE") return Response.json({ ok: true, status: "deletion_pending", deleted: false });
      if (new URL(String(input), "http://127.0.0.1").pathname === "/api/telemetry/profile") return new Response("down", { status: 503 });
      return realFetch(input, init);
    },
  });
  await click(buttonByText("Disconnect"));
  await click(buttonByText("Delete profile"));
  await settle(50);
  expect(card()?.textContent).toContain("Deletion is pending");
});

test("an unreadable profile file offers Disconnect, which clears it", async () => {
  status = { ...status, connected: false, unreadable: true, profile: null };
  deleteReply = { ok: true, status: "local_removed", deleted: false };
  await mount();
  expect(card()?.textContent).toContain("Disconnect removes it");
  await click(buttonByText("Disconnect"));
  await settle(50);
  expect(calls.filter(c => c.method === "DELETE")).toHaveLength(1);
});

test("leaderboard links are built only for valid handles", () => {
  expect(profileLeaderboardUrl("a-1-b2")).toBe("https://opencodex.me/dashboard/?profile=a-1-b2#leaderboard");
  expect(profileLeaderboardUrl("x\"><script>")).toBeNull();
});

test("switching anonymous telemetry in Proxy details updates the card without waiting for the poll", async () => {
  await mount();
  expect(card()).not.toBeNull();
  status = { ...status, telemetryEffective: false };
  await act(async () => {
    win.dispatchEvent(new win.CustomEvent(TELEMETRY_STATUS_CHANGED_EVENT, { detail: {} }) as unknown as Event);
  });
  await settle(50);
  expect(card()).toBeNull();
});


test("Connect shows a spinner until the collector answers", async () => {
  let release!: () => void;
  postReply = () => new Promise<Response>(resolve => {
    release = () => resolve(new Response(JSON.stringify({ ok: false, code: "collector_unavailable" }), { status: 502 }));
  });
  await mount();
  await click(buttonByText("Connect"));
  await type("handle", "jun");
  await type("displayName", "Jun");
  await click(host.querySelector('button[aria-label="blue"]')!);
  await click(host.querySelector('input[name="acknowledgePublic"]')!);
  const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  expect(submit.querySelector("svg")).toBeNull();
  await click(submit);
  expect(submit.getAttribute("aria-busy")).toBe("true");
  expect(submit.querySelector("svg.animate-spin")).not.toBeNull();
  await act(async () => { release(); });
  await settle(50);
  expect(submit.getAttribute("aria-busy")).toBe("false");
  expect(submit.querySelector("svg")).toBeNull();
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
});

