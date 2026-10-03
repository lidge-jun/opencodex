import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/en";
import SubagentForceControl from "../src/components/subagents-workspace/SubagentForceControl";

let root: Root | undefined;
let host: HTMLElement;
let window: Window;
let force: string | null;
let fail: boolean;
let gate: Promise<void> | undefined;
let writes: unknown[];
let originals: Record<string, PropertyDescriptor | undefined>;
const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"];

beforeEach(async () => {
  originals = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  window = new Window({ url: "http://localhost" });
  Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
  for (const key of globals.slice(0, 5)) Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? window : window[key as keyof Window] });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  force = null; fail = false; gate = undefined; writes = [];
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "PUT") {
      writes.push(JSON.parse(String(init.body)));
      if (gate) await gate;
      if (fail) return Response.json({ error: "fixture failure" }, { status: 500 });
      force = (writes.at(-1) as { force: string | null }).force;
      return Response.json({ force });
    }
    return Response.json({ force, forceAvailable: ["combo/other", "combo/featured", "combo/other"], forceStatus: {
      targetValid: force !== "retired/model", version: "2.1.256", support: "unsupported", settingsOverride: true, settingsReadable: true,
    } });
  } });
  host = window.document.createElement("div") as unknown as HTMLElement;
  window.document.body.appendChild(host);
  const { createRoot } = await import("react-dom/client");
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  for (const key of globals) {
    const descriptor = originals[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await window.happyDOM.close();
});
async function render(apiBase = "") {
  await act(async () => { root!.render(<LanguageProvider><SubagentForceControl key={apiBase} apiBase={apiBase} roster={["retired/model", "combo/featured"]} /></LanguageProvider>); });
}
function toggle() { return host.querySelector("button[aria-pressed]") as HTMLButtonElement; }
async function select(value: string) {
  await act(async () => {
    const element = host.querySelector("select")!;
    element.value = value;
    element.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}

test("default off requires a model; labeled native controls save enable and clear", async () => {
  await render();
  expect(toggle().disabled).toBe(true);
  expect(toggle().getAttribute("aria-label")).toBe(en["sub.forceTitle"]);
  expect(host.querySelector("label")?.textContent).toContain(en["sub.forceModel"]);
  expect([...host.querySelectorAll("option")].map(option => option.value)).toEqual(["", "combo/featured", "combo/other"]);
  await select("combo/featured");
  await act(async () => toggle().click());
  expect(writes).toEqual([{ force: "combo/featured" }]);
  expect(toggle().getAttribute("aria-pressed")).toBe("true");
  expect(host.textContent).toContain(en["sub.forceSaved"]);
  expect(host.textContent).toContain(en["sub.forceOld"]);
  expect(host.textContent).toContain(en["sub.forceOverride"]);
  expect(host.textContent).toContain(en["sub.forceHelp"]);
  await act(async () => toggle().click());
  expect(writes.at(-1)).toEqual({ force: null });
});

test("invalid persisted target remains visible and can be cleared", async () => {
  force = "retired/model";
  await render();
  expect(host.querySelector("select")?.value).toBe(force);
  expect(host.textContent).toContain(en["sub.forceInvalid"]);
  expect(toggle().disabled).toBe(false);
  await act(async () => toggle().click());
  expect(writes).toEqual([{ force: null }]);
});

test("failed save leaves committed selection intact and in-flight writes disable controls", async () => {
  force = "combo/featured"; fail = true;
  await render();
  let release!: () => void;
  gate = new Promise(resolve => { release = resolve; });
  await select("combo/other");
  expect(toggle().disabled).toBe(true);
  expect(host.querySelector("select")?.disabled).toBe(true);
  await act(async () => { release(); await gate; });
  expect(host.querySelector("select")?.value).toBe("combo/featured");
  expect(host.textContent).toContain(en["sub.saveFailed"]);
  expect(host.textContent).not.toContain(en["sub.forceSaved"]);
});

test.each(["resolve", "reject"] as const)("cancelled load body %s cannot update a replayed effect or finish its loading state", async outcome => {
  const reads: Array<{ signal: AbortSignal; resolve: (body: string) => void; reject: (error: Error) => void }> = [];
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (_url: unknown, init: RequestInit) => {
    const response = Response.json({});
    const body = new Promise<string>((resolve, reject) => { reads.push({ signal: init.signal!, resolve, reject }); });
    response.text = () => body;
    return response;
  } });
  await act(async () => {
    root!.render(<StrictMode><LanguageProvider><SubagentForceControl apiBase="" roster={[]} /></LanguageProvider></StrictMode>);
  });
  expect(reads).toHaveLength(2);
  expect(reads[0]!.signal.aborted).toBe(true);
  expect(reads[1]!.signal.aborted).toBe(false);
  await act(async () => {
    if (outcome === "resolve") reads[0]!.resolve(JSON.stringify({ force: "retired/model", forceAvailable: ["retired/model"] }));
    else reads[0]!.reject(new Error("cancelled body"));
  });
  expect(host.querySelector("select")?.value).toBe("");
  expect(host.querySelector("option[value='retired/model']")).toBeNull();
  expect(host.textContent).not.toContain(en["sub.loadFail"]);
  expect(toggle().disabled).toBe(true);
  expect(host.querySelector("select")?.disabled).toBe(true);
  await act(async () => { reads[1]!.resolve(JSON.stringify({ force: "combo/featured", forceAvailable: ["combo/featured"] })); });
  expect(host.querySelector("select")?.value).toBe("combo/featured");
  expect(toggle().disabled).toBe(false);
  expect(host.querySelector("select")?.disabled).toBe(false);
});
