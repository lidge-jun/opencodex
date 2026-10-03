import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useRef, useState } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { useT } from "../src/i18n/shared";
import AddProviderModal from "../src/components/AddProviderModal";
import { useAddProviderOAuth } from "../src/components/use-add-provider-oauth";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: unknown[];
let win: Window;
let host: HTMLElement;
let root: Root;
let oldFetch: typeof fetch;
let finishStatus: (() => void) | undefined;
let cancelled: number;
let patches: unknown[];
let patchFailure: "http" | "network" | undefined;
let holdPatch = false;
let finishPatch: (() => void) | undefined;
const preset = { id: "github-copilot", label: "GitHub Copilot", adapter: "openai-chat", baseUrl: "https://api.githubcopilot.com", auth: "oauth", oauthProvider: "github-copilot" };

beforeEach(() => {
  previous = globals.map(key => Reflect.get(globalThis, key));
  oldFetch = globalThis.fetch;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { value: "en-US", configurable: true });
  for (const [key, value] of Object.entries({ document: win.document, window: win, navigator: win.navigator, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true }))
    Object.defineProperty(globalThis, key, { value, configurable: true });
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
  cancelled = 0; patches = []; finishStatus = undefined; patchFailure = undefined; holdPatch = false; finishPatch = undefined;
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/oauth/providers") return Response.json({ providers: ["github-copilot"] });
    if (path === "/api/provider-presets") return Response.json({ providers: [preset] });
    if (path === "/api/oauth/login") return Response.json({ deviceCode: "TEST-CODE" });
    if (path === "/api/oauth/status") return await new Promise<Response>(resolve => { finishStatus = () => resolve(Response.json({ loggedIn: true })); });
    if (path === "/api/oauth/login/cancel") { cancelled++; return Response.json({ ok: true }); }
    if (path === "/api/providers" && init?.method === "PATCH") {
      patches.push(JSON.parse(String(init.body)));
      if (holdPatch) return await new Promise<Response>(resolve => { finishPatch = () => resolve(Response.json({ ok: true })); });
      if (patchFailure === "network") throw new Error("synthetic network refusal");
      return patchFailure === "http" ? Response.json({ error: "refused" }, { status: 409 }) : Response.json({ ok: true });
    }
    return Response.json({});
  }) as typeof fetch;
});
afterEach(async () => {
  if (root) await act(async () => { root.unmount(); });
  globalThis.fetch = oldFetch;
  globals.forEach((key, index) => Object.defineProperty(globalThis, key, { value: previous[index], configurable: true }));
  await win.happyDOM.close();
});
async function mount(node: React.ReactNode) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => { root = createRoot(host); root.render(<LanguageProvider>{node}</LanguageProvider>); });
}
async function click(fragment: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.includes(fragment));
  expect(button).toBeTruthy();
  await act(async () => { button!.click(); });
}
async function waitForPoll() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2100)); });
  expect(finishStatus).toBeDefined();
}
async function finish() { await act(async () => { finishStatus!(); await Promise.resolve(); }); }
function Harness({ complete }: { complete: (name: string) => Promise<void> }) {
  const t = useT(); const aliveRef = useRef(true);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  const { loginOAuth } = useAddProviderOAuth({ apiBase: "", t, aliveRef, onAdded: complete });
  return <><button onClick={() => { void loginOAuth("github-copilot", { setOauthBusy: setBusy, setOauthMsg: setMessage,
    setOauthMsgTone: () => {}, setOauthUrl: () => {}, setManualCode: () => {}, setManualCodeMsg: () => {}, setManualCodeOk: () => {} }); }}>Start</button>
    <span>{busy ? "busy" : "idle"}</span><span>{message}</span></>;
}

test("polling uses the latest completion callback", async () => {
  const calls: string[] = [];
  await mount(<Harness complete={async () => { calls.push("old"); }} />);
  await click("Start");
  await act(async () => { root.render(<LanguageProvider><Harness complete={async () => { calls.push("latest"); }} /></LanguageProvider>); });
  await waitForPoll(); await finish();
  expect(calls).toEqual(["latest"]);
  expect(cancelled).toBe(0);
});

test.each(["http", "network"] as const)("Copilot %s save failure preserves setup without cancelling successful login", async failure => {
  patchFailure = failure;
  const added: string[] = [];
  await mount(<AddProviderModal apiBase="" existingNames={[]} initialTier="paid" onClose={() => {}} onAdded={name => added.push(name)} />);
  await click("GitHub Copilot");
  const select = [...host.querySelectorAll<HTMLSelectElement>("select")].find(node => [...node.options].some(option => option.value === "auto"))!;
  expect(select).toBeTruthy();
  await act(async () => { select.value = "auto"; select.dispatchEvent(new win.Event("change", { bubbles: true })); });
  await click("Log in with");
  const check = host.querySelector<HTMLInputElement>('.oauth-tos-ack input')!;
  await act(async () => { check.click(); });
  await click("Continue");
  await waitForPoll(); await finish();
  expect(patches).toEqual([{ copilotModelSelection: "auto" }]);
  expect(added).toEqual([]);
  expect(cancelled).toBe(0);
  expect(host.textContent).toContain("Save failed");
  expect(host.textContent).not.toContain("Network error");
  expect(select.disabled).toBe(false);
  expect(select.value).toBe("auto");
});


test("successful Copilot setup saves the selected mode before notifying the parent exactly once", async () => {
  const added: string[] = [];
  await mount(<AddProviderModal apiBase="" existingNames={[]} initialTier="paid" onClose={() => {}} onAdded={name => {
    expect(patches).toEqual([{ copilotModelSelection: "manual" }]);
    added.push(name);
  }} />);
  await click("GitHub Copilot");
  const select = [...host.querySelectorAll<HTMLSelectElement>("select")].find(node => [...node.options].some(option => option.value === "manual"))!;
  await act(async () => { select.value = "manual"; select.dispatchEvent(new win.Event("change", { bubbles: true })); });
  await click("Log in with");
  await act(async () => { host.querySelector<HTMLInputElement>(".oauth-tos-ack input")!.click(); });
  await click("Continue");
  await waitForPoll(); await finish();
  expect(added).toEqual(["github-copilot"]);
  expect(patches).toHaveLength(1);
  expect(cancelled).toBe(0);
  expect(host.textContent).not.toContain("Save failed");
});


test("leaving the preset during the completion PATCH cannot close the newly selected setup", async () => {
  holdPatch = true;
  const added: string[] = [];
  await mount(<AddProviderModal apiBase="" existingNames={[]} initialTier="paid" onClose={() => {}} onAdded={name => added.push(name)} />);
  await click("GitHub Copilot");
  const select = [...host.querySelectorAll<HTMLSelectElement>("select")].find(node => [...node.options].some(option => option.value === "auto"))!;
  await act(async () => { select.value = "auto"; select.dispatchEvent(new win.Event("change", { bubbles: true })); });
  await click("Log in with");
  await act(async () => { host.querySelector<HTMLInputElement>(".oauth-tos-ack input")!.click(); });
  await click("Continue");
  await waitForPoll(); await finish();
  expect(finishPatch).toBeDefined();
  await click("Back");
  await act(async () => { finishPatch!(); await Promise.resolve(); });
  expect(added).toEqual([]);
  expect(patches).toEqual([{ copilotModelSelection: "auto" }]);
  expect(host.querySelector(".oauth-tos-ack")).toBeNull();
});
