import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import ProviderModelsNotice, { type ProviderModelsNoticeProps } from "../src/components/ProviderModelsNotice";
import { LanguageProvider } from "../src/i18n/provider";
import { useProviderModelsNotice } from "../src/pages/use-provider-models-notice";
import { useProvidersFetch } from "../src/pages/use-providers-fetch";
import type { ProvidersConfig } from "../src/pages/providers-shared";

const keys = ["window", "document", "navigator", "localStorage", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let saved: Record<string, unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null;

beforeEach(() => {
  saved = Object.fromEntries(keys.map(key => [key, Reflect.get(globalThis, key)]));
  win = new Window({ url: "http://localhost/#providers" });
  win.localStorage.setItem("ocx-lang", "en");
  for (const key of ["window", "document", "navigator", "localStorage", "sessionStorage"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? win : win[key] });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
  root = null;
});
afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  await win.happyDOM.close();
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: saved[key] });
});
async function render(node: ReactNode) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => { root ??= createRoot(host); root.render(node); });
}
function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === label);
  if (!found) throw new Error(`missing button ${label}`);
  return found;
}

test("all-OFF notice has keyboard navigation, explicit actions and focus restoration", async () => {
  const trigger = win.document.createElement("button");
  win.document.body.appendChild(trigger);
  trigger.focus();
  let closed = 0, opened = 0;
  const props: ProviderModelsNoticeProps = {
    provider: "openrouter", loading: false, failed: false, providerKnown: true, initialRegistration: true,
    selection: { status: "all-off", modelCount: 20 }, onClose: () => { closed++; }, onOpenModels: () => { opened++; },
  };
  await render(<LanguageProvider><ProviderModelsNotice {...props} /></LanguageProvider>);
  expect(host.querySelector('[role="dialog"]')?.getAttribute("aria-modal")).toBe("true");
  expect(host.textContent).toContain("turned OFF at registration");
  expect(host.textContent).toContain("20 models");
  expect(win.document.activeElement as unknown).toBe(button("Open Models"));
  button("Open Models").dispatchEvent(new win.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }) as never);
  expect(win.document.activeElement as unknown).toBe(button("Close"));
  button("Close").dispatchEvent(new win.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }) as never);
  expect(win.document.activeElement as unknown).toBe(button("Open Models"));
  button("Open Models").click();
  expect(opened).toBe(1);
  button("Open Models").dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as never);
  expect(closed).toBe(1);
  await act(async () => { root!.unmount(); root = null; });
  expect(win.document.activeElement).toBe(trigger);
});

test("pending/error recovery and generic OAuth/re-login copy stay truthful", async () => {
  let retried = 0;
  const props: ProviderModelsNoticeProps = {
    provider: "xai", loading: false, failed: false, providerKnown: true, initialRegistration: false,
    selection: { status: "pending" }, onClose: () => {}, onOpenModels: () => {}, onRetry: () => { retried++; },
  };
  await render(<LanguageProvider><ProviderModelsNotice {...props} /></LanguageProvider>);
  expect(host.textContent).toContain("not confirmed yet");
  button("Retry").click();
  expect(retried).toBe(1);
  await render(<LanguageProvider><ProviderModelsNotice {...props} failed /></LanguageProvider>);
  expect(host.textContent).toContain("was saved");
  await render(<LanguageProvider><ProviderModelsNotice {...props} selection={{ status: "all-off", modelCount: 20 }} catalogRefreshPending /></LanguageProvider>);
  expect(host.textContent).not.toContain("turned OFF at registration");
  expect(host.textContent).not.toContain("20 models");
  expect(host.textContent).toContain("Choose which models appear");
  expect(host.textContent).toContain("ocx sync");
});

test("notice waits for post-discovery config refresh and ignores closed/superseded operations", async () => {
  let controller: ReturnType<typeof useProviderModelsNotice>;
  const gates: Array<() => void> = [];
  const refresh = () => new Promise<"applied">(resolve => gates.push(() => resolve("applied")));
  function Harness() { controller = useProviderModelsNotice("/notice", refresh); return null; }
  await render(<Harness />);
  await act(async () => { controller!.open("one", true); });
  await act(async () => { controller!.modelsSettled(true); });
  expect(controller!.notice?.loading).toBe(true);
  await act(async () => { gates.shift()!(); await Promise.resolve(); });
  expect(controller!.notice?.loading).toBe(false);
  await act(async () => { controller!.modelsSettled(false); controller!.close(); });
  await act(async () => { gates.shift()!(); await Promise.resolve(); });
  expect(controller!.notice).toBeNull();
  await act(async () => { controller!.open("old", true); controller!.modelsSettled(true); controller!.open("new", true); });
  await act(async () => { gates.shift()!(); await Promise.resolve(); });
  expect(controller!.notice?.context.provider).toBe("new");
  expect(controller!.notice?.loading).toBe(true);
});

test("returning to an API target does not reopen its old notice", async () => {
  let controller: ReturnType<typeof useProviderModelsNotice>;
  const refresh = async () => "applied" as const;
  function Harness({ base }: { base: string }) { controller = useProviderModelsNotice(base, refresh); return null; }
  await render(<Harness base="/a" />);
  await act(async () => { controller!.open("old", true); });
  await render(<Harness base="/b" />);
  expect(controller!.notice).toBeNull();
  await render(<Harness base="/a" />);
  expect(controller!.notice).toBeNull();
});

test("failed config refresh is not announced as successful model setup", async () => {
  let controller: ReturnType<typeof useProviderModelsNotice>;
  function Harness() { controller = useProviderModelsNotice("/failed", async () => "failed"); return null; }
  await render(<Harness />);
  await act(async () => { controller!.open("vendor", true); });
  await act(async () => { controller!.modelsSettled(true); await Promise.resolve(); });
  expect(controller!.notice?.loading).toBe(false);
  expect(controller!.notice?.failed).toBe(true);
});

test("an older pending config response cannot overwrite the newer completed snapshot", async () => {
  let loader: ReturnType<typeof useProvidersFetch>;
  const observed: { config: ProvidersConfig | null } = { config: null };
  const responses: Array<(response: Response) => void> = [];
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: () => new Promise<Response>(resolve => responses.push(resolve)) });
  function Harness() {
    const [config, setConfig] = useState<ProvidersConfig | null>(null);
    observed.config = config;
    loader = useProvidersFetch({ apiBase: "/fresh", t: key => key, setConfig, setOauthProviders: () => {}, setOauthStatus: () => {}, notify: () => {}, invalidateProviderQuotas: () => {} });
    return null;
  }
  await render(<Harness />);
  const first = loader!.fetchConfig();
  const second = loader!.fetchConfig();
  const snapshot = (status: string) => ({ port: 0, defaultProvider: "vendor", providers: { vendor: { adapter: "openai-chat", baseUrl: "https://example.test", initialModelSelection: { status } } } });
  await act(async () => { responses[1]!(Response.json(snapshot("all-off"))); await second; });
  await act(async () => { responses[0]!(Response.json(snapshot("pending"))); await first; });
  expect(observed.config?.providers.vendor.initialModelSelection?.status).toBe("all-off");
});
