/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { resetApiAuthFetchForTests } from "../src/api";
import ApiKeys from "../src/pages/ApiKeys";

const KEY = "ocx_data_audio_panel_fixture";
const BASE = "http://localhost/v1";
const AUDIO = {
  transcriptionEndpoint: `${BASE}/audio/transcriptions`, dictationStreamEndpoint: "ws://localhost/v1/audio/transcriptions/stream",
  liveEndpoint: "ws://localhost/v1/live", realtimeCallsEndpoint: `${BASE}/realtime/calls`,
  transcriptionModel: "gpt-4o-transcribe", liveModel: "gpt-live-1-codex",
  transcriptionConfigured: true, dictationConfigured: true, liveConfigured: true,
};
const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "WebSocket", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<string, PropertyDescriptor | undefined>;
let win: Window;
let root: Root | undefined;
let container: HTMLDivElement;
let audio: unknown;
let sent: RequestInit[];
let responder: (init: RequestInit) => Promise<Response>;

class Socket {
  static OPEN = 1;
  static latest: Socket | undefined;
  readyState = 0;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  sent: string[] = [];
  constructor(readonly url: string, readonly protocols: string[]) { Socket.latest = this; }
  send(value: string) { this.sent.push(value); }
  close() { this.closed = true; }
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  win = new Window({ url: "http://localhost/" });
  for (const key of ["document", "window", "navigator", "localStorage", "sessionStorage", "HTMLElement"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? win : win[key] });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: Socket });
  win.localStorage.setItem("ocx-lang", "en");
  audio = AUDIO; sent = []; Socket.latest = undefined;
  responder = async () => Response.json({ text: "Synthetic transcript" });
  Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/keys")) return Response.json({ keys: [], baseUrl: BASE, endpoint: `${BASE}/responses`, authMatrix: [{ endpoint: "/v1/models", bearer: "accepted", dedicated: "accepted", xApiKey: "accepted" }], ...(audio === undefined ? {} : { audio }) });
    if (url.endsWith("/v1/models")) return Response.json({ data: [] });
    if (url.endsWith("/v1/audio/transcriptions")) { sent.push(init!); return responder(init!); }
    return new Response(null, { status: 404 });
  } });
  resetApiAuthFetchForTests(); clearClientResourceStoresForTests();
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  clearClientResourceStoresForTests(); resetApiAuthFetchForTests();
  win.close();
  for (const key of globals) {
    if (previous[key]) Object.defineProperty(globalThis, key, previous[key]!);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function render(active = true, apiBase = "http://localhost") {
  if (!root) {
    container = win.document.createElement("div") as unknown as HTMLDivElement;
    win.document.body.appendChild(container);
    root = (await import("react-dom/client")).createRoot(container);
  }
  await act(async () => { root!.render(<LanguageProvider><ApiKeys apiBase={apiBase} active={active} /></LanguageProvider>); });
  await flush();
}
async function typeKey(section: string, value = KEY) {
  const input = container.querySelector<HTMLInputElement>(`${section} input[type=password]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
  });
}
async function selectFile() {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["synthetic"], "fixture.wav")] });
  await act(async () => { input.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event); });
}
async function submit(section: string) {
  await act(async () => { container.querySelector<HTMLButtonElement>(`${section} button[type=submit]`)!.click(); });
  await flush();
}
const DICTATION = "#api-section-dictation";
const LIVE = "#api-section-live-voice";

test("real API page uploads, copies transcript, and keeps keys out of caches and examples", async () => {
  await render();
  expect(sent).toHaveLength(0);
  await typeKey(DICTATION); await selectFile(); await submit(DICTATION);
  expect(sent).toHaveLength(1);
  expect(new Headers(sent[0]!.headers).get("x-opencodex-api-key")).toBe(KEY);
  expect(container.querySelector(".audio-api-result")?.textContent).toContain("Synthetic transcript");
  let copied = "";
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied = text; } } });
  await act(async () => { container.querySelector<HTMLButtonElement>(".audio-api-result button")!.click(); });
  expect(copied).toBe("Synthetic transcript");
  expect(container.querySelector(".audio-api-examples")?.textContent).not.toContain(KEY);
  for (const storage of [win.localStorage, win.sessionStorage]) {
    for (let i = 0; i < storage.length; i++) expect(storage.getItem(storage.key(i)!)).not.toContain(KEY);
  }
});

test("upload errors are localized, cancellation and inactive panels cannot publish late text", async () => {
  await render(); await typeKey(DICTATION); await selectFile();
  responder = async () => new Response("private account details", { status: 401 });
  await submit(DICTATION);
  expect(container.querySelector(`${DICTATION} [role=alert]`)?.textContent).toContain("Key rejected");
  expect(container.textContent).not.toContain("private account details");
  let resolveResponse!: (response: Response) => void;
  responder = () => new Promise(resolve => { resolveResponse = resolve; });
  await submit(DICTATION);
  const signal = sent.at(-1)!.signal!;
  await render(false);
  expect(signal.aborted).toBe(true);
  await act(async () => { resolveResponse(Response.json({ text: "late transcript" })); });
  await render(true);
  expect(container.textContent).not.toContain("late transcript");
  expect(container.querySelector<HTMLInputElement>(`${DICTATION} input[type=password]`)!.value).toBe("");
});

test("voice reports real readiness, filters event payloads and releases on deactivation", async () => {
  await render();
  expect(Socket.latest).toBeUndefined();
  await typeKey(LIVE); await submit(LIVE);
  const socket = Socket.latest!;
  expect(socket).toBeDefined();
  await act(async () => { socket.readyState = 1; socket.onopen?.(); });
  expect(container.querySelector(`${LIVE} [role=status]`)?.textContent).toBe("Connecting...");
  await act(async () => { socket.onmessage?.({ data: JSON.stringify({ type: "session.started", session: { id: "fixture" }, token: "never-render" }) }); });
  expect(container.querySelector(`${LIVE} [role=status]`)?.textContent).toBe("Session ready");
  expect(container.textContent).not.toContain("never-render");
  await render(false);
  expect(socket.closed).toBe(true); expect(socket.onmessage).toBeNull();
});

test("missing or malformed audio metadata leaves existing key management usable", async () => {
  audio = { ...AUDIO, liveEndpoint: "wss://unexpected.example/v1/live" };
  await render();
  expect(container.querySelector(DICTATION)?.textContent).toContain("Audio metadata unavailable");
  expect(container.querySelector(`${DICTATION} input`)).toBeNull();
  expect(container.textContent).toContain("Generate");
  expect(sent).toHaveLength(0);
});

test("Cancel, key replacement and duplicate clicks cannot publish a superseded upload", async () => {
  const replies: Array<(response: Response) => void> = [];
  responder = () => new Promise(resolve => { replies.push(resolve); });
  await render(); await typeKey(DICTATION); await selectFile();
  await act(async () => {
    const button = container.querySelector<HTMLButtonElement>(`${DICTATION} button[type=submit]`)!;
    button.click(); button.click();
  });
  await flush();
  expect(sent).toHaveLength(1);
  await act(async () => { container.querySelector<HTMLButtonElement>(`${DICTATION} .audio-api-actions button[type=button]`)!.click(); });
  expect(sent[0]!.signal!.aborted).toBe(true);
  await submit(DICTATION);
  expect(sent).toHaveLength(2);
  await typeKey(DICTATION, KEY + "-replacement");
  expect(sent[1]!.signal!.aborted).toBe(true);
  await submit(DICTATION);
  expect(sent).toHaveLength(3);
  await act(async () => { replies[0]!(Response.json({ text: "stale A" })); replies[1]!(Response.json({ text: "stale B" })); });
  expect(container.textContent).not.toContain("stale A"); expect(container.textContent).not.toContain("stale B");
  await act(async () => { replies[2]!(Response.json({ text: "Current C" })); });
  expect(container.querySelector(".audio-api-result")?.textContent).toContain("Current C");
});

test("origin changes close the prior socket and clear the transient key", async () => {
  await render(); await typeKey(LIVE); await submit(LIVE);
  const socket = Socket.latest!;
  await render(true, "http://127.0.0.1");
  expect(socket.closed).toBe(true);
  expect(container.querySelector<HTMLInputElement>(`${LIVE} input[type=password]`)!.value).toBe("");
});

test("unknown fields cannot write secrets to the list cache", async () => {
  audio = { ...AUDIO, apiKey: "sensitive-extra-marker" };
  await render();
  expect(container.querySelector(`${DICTATION} input`)).toBeNull();
  expect(win.sessionStorage.getItem("ocx.apikeys.list.v2:http://localhost")).not.toContain("sensitive-extra-marker");
});

test("old server and malformed cache audio never invent configured support", async () => {
  audio = undefined;
  win.sessionStorage.setItem("ocx.apikeys.list.v2:http://localhost", JSON.stringify({
    keys: [], claudeCodeEnabled: true,
    authMatrix: [{ endpoint: "/v1/models", bearer: "accepted", dedicated: "accepted", xApiKey: "accepted" }],
    endpoints: { baseUrl: BASE, responses: `${BASE}/responses`, chatCompletions: `${BASE}/chat/completions`, messages: `${BASE}/messages`, models: `${BASE}/models`, audio: { ...AUDIO, liveConfigured: "yes" } },
  }));
  await render();
  expect(container.querySelector(DICTATION)?.textContent).toContain("Audio metadata unavailable");
  expect(container.querySelector(`${LIVE} input`)).toBeNull();
  expect(sent).toHaveLength(0);
});
