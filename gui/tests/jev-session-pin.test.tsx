import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { draftEquals, parseComboList, toPutBody, validateComboDraft } from "../src/combo-workspace-data";
import ComboWorkspace from "../src/components/ComboWorkspace";
import { AddComboModal } from "../src/components/combo-workspace-add-modal";
import { LanguageProvider } from "../src/i18n/provider";
import Combos from "../src/pages/Combos";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<string, unknown>;
let testWindow: Window;
let root: Root | undefined;
let host: HTMLDivElement;
let originalFetch: typeof fetch;
let sequence = 0;
const row = { id: "pin", model: "combo/pin", strategy: "jev", targets: [{ provider: "openai", model: "gpt-5" }] };

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)]));
  originalFetch = globalThis.fetch;
  testWindow = new Window({ url: "http://localhost/#models/combos" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  for (const [key, value] of Object.entries({ document: testWindow.document, window: testWindow,
    navigator: testWindow.navigator, localStorage: testWindow.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  globalThis.fetch = originalFetch;
  testWindow.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
});

async function flush() {
  await act(async () => { await new Promise<void>(done => testWindow.setTimeout(done, 0)); });
}

function input(id: string) { return host.querySelector<HTMLInputElement>(id)!; }
function save() { return host.querySelector<HTMLButtonElement>("#cwi-edit-save")!; }
async function enter(id: string, value: string) {
  await act(async () => {
    const element = input(id);
    Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
}
async function toggle() {
  expect(input("#cwi-edit-session-pin")).not.toBeNull();
  await act(async () => { input("#cwi-edit-session-pin").click(); });
}
async function submit() {
  await act(async () => { save().click(); });
  await flush();
}

async function openPage(sessionPin?: unknown) {
  let stored: Record<string, unknown> = { ...row, ...(sessionPin === undefined ? {} : { sessionPin }) };
  const puts: Array<{ combo: Record<string, unknown> }> = [];
  let failure: "http" | "network" | undefined;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith("/api/combos")) {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        if (failure === "network") throw new Error("offline");
        if (failure === "http") return Response.json({ error: "save rejected" }, { status: 500 });
        stored = { ...stored, ...body.combo };
        return Response.json({ success: true }); // no echoed combo required
      }
      return Response.json({ combos: [stored] });
    }
    if (String(url).endsWith("/api/config")) return Response.json({ providers: { openai: { adapter: "openai-responses" } } });
    if (String(url).endsWith("/api/models")) return Response.json([{ provider: "openai", id: "gpt-5" }]);
    if (String(url).endsWith("/api/provider-quotas")) return Response.json({ reports: [] });
    if (String(url).endsWith("/api/sidecar-settings")) return Response.json({ vision: { enabled: true } });
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const { createRoot } = await import("react-dom/client");
  root = createRoot(host);
  await act(async () => { root!.render(<LanguageProvider><Combos apiBase={"/pin-test-" + ++sequence} /></LanguageProvider>); });
  await flush();
  await act(async () => { host.querySelector<HTMLButtonElement>(".combos-workspace-rail-row")!.click(); });
  await flush();
  return { puts, fail: (value?: typeof failure) => { failure = value; } };
}

test("JEV pin parsing, omission, explicit clearing and exact stored TTL round-trip", () => {
  const legacy = parseComboList({ combos: [row] })[0]!;
  expect(Object.hasOwn(legacy, "sessionPin")).toBe(false);
  expect(Object.hasOwn(toPutBody(legacy).combo, "sessionPin")).toBe(false);
  for (const sessionPin of [null, { ttlMs: 90001 }]) {
    const parsed = parseComboList({ combos: [{ ...row, sessionPin }] })[0]!;
    expect(parsed.sessionPin).toEqual(sessionPin);
    expect(toPutBody(parsed).combo.sessionPin).toEqual(sessionPin);
    expect(Object.hasOwn(toPutBody({ ...parsed, strategy: "failover" }).combo, "sessionPin")).toBe(false);
  }
  for (const sessionPin of [{ ttlMs: 1 }, { ttlMs: "60000" }, { ttlMs: 60000, extra: true }]) {
    expect(parseComboList({ combos: [{ ...row, sessionPin }] })[0]!.sessionPin).toBeUndefined();
  }
  expect(draftEquals(legacy, { ...legacy, sessionPin: null })).toBe(false);
  expect(draftEquals({ ...legacy, sessionPin: { ttlMs: 60000 } }, { ...legacy, sessionPin: { ttlMs: 60000 } })).toBe(true);
});

test("pin TTL validates inclusive bounds, integers and missing values", () => {
  const draft = parseComboList({ combos: [row] })[0]!;
  const options = { existingIds: [], providers: { openai: {} } };
  for (const ttlMs of [60000, 86400000, 90001]) {
    expect(validateComboDraft({ ...draft, sessionPin: { ttlMs } }, options)).toBeNull();
  }
  for (const ttlMs of [0, 59999, 86400001, 60000.5, NaN, Infinity]) {
    expect(validateComboDraft({ ...draft, sessionPin: { ttlMs } }, options)).toBe("invalidSessionPin");
  }
});

test("toggle on and off save explicit object and null through the real page PUT", async () => {
  const { puts } = await openPage();
  expect(save().disabled).toBe(true);
  await toggle();
  expect(input("#cwi-edit-session-pin-ttl").value).toBe("60000");
  await enter("#cwi-edit-session-pin-ttl", "1200000");
  expect(save().disabled).toBe(false);
  await submit();
  expect(puts.at(-1)!.combo.sessionPin).toEqual({ ttlMs: 1200000 });
  await toggle();
  expect(input("#cwi-edit-session-pin-ttl")).toBeNull();
  await submit();
  expect(puts.at(-1)!.combo.sessionPin).toBeNull();
});

test("legacy missing pin stays omitted on unrelated save, but on then off explicitly clears it", async () => {
  const { puts } = await openPage();
  expect(input("#cwi-edit-session-pin")?.checked).toBe(false);
  await enter("#cwi-edit-alias", "renamed-pin");
  await submit();
  expect(Object.hasOwn(puts[0]!.combo, "sessionPin")).toBe(false);
  await toggle();
  await toggle();
  expect(save().disabled).toBe(false);
  await submit();
  expect(puts.at(-1)!.combo.sessionPin).toBeNull();
});

test("invalid and blank enabled TTL show accessible bounds errors without sending", async () => {
  const { puts } = await openPage({ ttlMs: 1200000 });
  for (const value of ["59999", "86400001", "60000.5", ""]) {
    await enter("#cwi-edit-session-pin-ttl", value);
    await submit();
    expect(puts).toHaveLength(0);
    const ttl = input("#cwi-edit-session-pin-ttl");
    expect(ttl.getAttribute("aria-invalid")).toBe("true");
    expect(host.querySelector("#cwi-edit-session-pin-error")?.textContent).toContain("60000");
    expect(host.querySelector(".notice-err")?.textContent).toContain("86400000");
  }
  await enter("#cwi-edit-session-pin-ttl", "86400000");
  await submit();
  expect(puts.at(-1)!.combo.sessionPin).toEqual({ ttlMs: 86400000 });
});

for (const failure of ["http", "network"] as const) test(`${failure} save failure retains the edited pin and allows retry`, async () => {
  const page = await openPage({ ttlMs: 90001 });
  await enter("#cwi-edit-session-pin-ttl", "180000");
  page.fail(failure);
  await submit();
  expect(input("#cwi-edit-session-pin-ttl").value).toBe("180000");
  expect(input("#cwi-edit-session-pin").checked).toBe(true);
  expect(save().disabled).toBe(false);
  expect(host.querySelector(".notice-err")).not.toBeNull();
  page.fail();
  await submit();
  expect(page.puts).toHaveLength(2);
  expect(page.puts[1]!.combo.sessionPin).toEqual({ ttlMs: 180000 });
  expect(save().disabled).toBe(true);
});

test("same-ID refresh after save replaces optimistic pin state before another save", async () => {
  const { createRoot } = await import("react-dom/client");
  root = createRoot(host);
  const saved: ReturnType<typeof toPutBody>[] = [];
  const render = (ttlMs: number) => <LanguageProvider><ComboWorkspace
    combos={parseComboList({ combos: [{ ...row, sessionPin: { ttlMs } }] })}
    providerQuotaStates={{}} providers={[{ name: "openai" }]} models={[{ provider: "openai", id: "gpt-5" }]}
    onRefresh={() => {}} onSave={async item => { saved.push(toPutBody(item)); return { ok: true }; }}
    onRemove={async () => ({ ok: true })} onAdd={() => {}} adding={false} onCloseAdd={() => {}} onCreated={() => {}}
  /></LanguageProvider>;
  await act(async () => { root!.render(render(60000)); });
  await act(async () => { host.querySelector<HTMLButtonElement>(".combos-workspace-rail-row")!.click(); });
  await flush();
  await enter("#cwi-edit-session-pin-ttl", "120000");
  await submit();
  await act(async () => { root!.render(render(240000)); });
  await flush();
  expect(input("#cwi-edit-session-pin-ttl").value).toBe("240000");
  await enter("#cwi-edit-alias", "fresh-pin");
  await submit();
  expect(saved.at(-1)!.combo.sessionPin).toEqual({ ttlMs: 240000 });
});

test("the JEV create dialog uses the same pin controls and validation", async () => {
  const { createRoot } = await import("react-dom/client");
  root = createRoot(host);
  const saved: ReturnType<typeof toPutBody>[] = [];
  await act(async () => { root!.render(<LanguageProvider><AddComboModal
    initialDraft={parseComboList({ combos: [row] })[0]} existingIds={[]} existingAliases={[]}
    providerMap={{ openai: {} }} providerQuotaStates={{}} providers={[{ name: "openai" }]}
    models={[{ provider: "openai", id: "gpt-5" }]} onClose={() => {}}
    onSubmit={async item => { saved.push(toPutBody(item)); return { ok: true }; }}
  /></LanguageProvider>); });
  expect(input("#cwi-new-session-pin").checked).toBe(false);
  await act(async () => { input("#cwi-new-session-pin").click(); });
  await enter("#cwi-new-session-pin-ttl", "");
  const create = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "Create combo")!;
  await act(async () => { create.click(); });
  expect(saved).toHaveLength(0);
  expect(host.querySelector("#cwi-new-session-pin-error")?.getAttribute("role")).toBe("alert");
  await enter("#cwi-new-session-pin-ttl", "60000");
  await act(async () => { create.click(); });
  expect(saved[0]!.combo.sessionPin).toEqual({ ttlMs: 60000 });
});
