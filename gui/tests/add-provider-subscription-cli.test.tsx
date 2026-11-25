import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import AddProviderModal from "../src/components/AddProviderModal";
import { selectValue } from "./helpers/custom-select";

/**
 * `claude-cli` drives the signed-in Claude Code CLI and bills that subscription; it is not an
 * API-key path even though its row is keyless. Picking it from the add-provider catalog has to
 * show that warning before the Add button can be pressed, list it under Paid rather than Free,
 * keep its own adapter in the form, and still save.
 */

const PRESETS = [
  { id: "claude-cli", label: "Claude Code CLI (subscription)", adapter: "claude-cli", baseUrl: "https://api.anthropic.com", auth: "key", keyOptional: true, defaultModel: "claude-sonnet-5", note: "Runs Claude subscription traffic through the official CLI." },
  { id: "antigravity-acp", label: "Antigravity CLI (ACP, local)", adapter: "agy-acp", baseUrl: "https://antigravity.google/docs/cli/acp", auth: "key", keyOptional: true, defaultModel: "gemini-3.8-flash", note: "Drives the official Antigravity CLI." },
  { id: "step-cli", label: "StepCode CLI (subscription)", adapter: "step-cli", baseUrl: "https://api.stepfun.com/step_plan", auth: "key", keyOptional: true, defaultModel: "step-5-preview" },
  { id: "keyless", label: "Keyless Free", adapter: "openai-chat", baseUrl: "https://api.example.com/v1", auth: "key", keyOptional: true },
  { id: "google-vertex", label: "Google Vertex AI", adapter: "google", baseUrl: "https://aiplatform.googleapis.com", auth: "key", defaultModel: "gemini-3-pro" },
];

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;
let posted: Array<Record<string, unknown>>;
let added: string[];

beforeEach(() => {
  previous = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previous;
  originalFetch = globalThis.fetch;
  posted = [];
  added = [];
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/provider-presets") return Response.json({ providers: PRESETS });
      if (url.pathname === "/api/oauth/providers") return Response.json({ providers: [] });
      if (url.pathname === "/api/usage") return Response.json({ providers: [] });
      if (url.pathname === "/api/providers" && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Response.json({ ok: true });
      }
      return Response.json({});
    },
  });
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  }
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  await win.happyDOM?.close?.();
});

async function mount(initialTier: "free" | "paid") {
  const { createRoot } = await import("react-dom/client");
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <AddProviderModal apiBase="" existingNames={[]} initialTier={initialTier} onClose={() => {}} onAdded={name => { added.push(name); }} />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise(r => setTimeout(r, 60)); });
}

function rowsText(): string {
  return win.document.querySelector(".provider-catalog-rows")?.textContent ?? "";
}

function warning() {
  return win.document.querySelector("[data-subscription-cli-warning]");
}

test("claude-cli is listed under Paid, not Free", async () => {
  await mount("free");
  expect(rowsText()).toContain("Keyless Free");
  expect(rowsText()).not.toContain("Claude Code CLI");

  await mount("paid");
  expect(rowsText()).toContain("Claude Code CLI (subscription)");
  expect(rowsText()).toContain("Subscription CLI");
  expect(rowsText()).not.toContain("Keyless Free");
});

test("step-cli has a subscription badge under Paid and is absent from Free", async () => {
  await mount("free");
  expect(rowsText()).not.toContain("StepCode CLI");

  await mount("paid");
  const row = [...win.document.querySelectorAll(".provider-catalog-row-wrap > button")]
    .find(el => el.textContent?.includes("StepCode CLI"));
  expect(row?.textContent).toContain("Subscription CLI");
});

test("StepCode setup names its own CLI and API-key alternative and saves without a key", async () => {
  await mount("paid");
  const row = [...win.document.querySelectorAll(".provider-catalog-row-wrap > button")]
    .find(el => el.textContent?.includes("StepCode CLI"));
  expect(row).toBeDefined();
  await act(async () => { (row as unknown as HTMLButtonElement).click(); });
  expect(warning()?.textContent).toContain("StepCode");
  expect(warning()?.textContent).toContain("Step Plan");
  expect(warning()?.textContent).toContain("step --sdk-stdio");
  expect(warning()?.textContent).toContain("stepfun");
  expect(warning()?.textContent).not.toContain("anthropic-apikey");
  expect(win.document.querySelector('input[type="password"]')).toBeNull();

  const addButton = [...win.document.querySelectorAll("button.btn-primary")]
    .find(el => el.textContent === "Add provider") as unknown as HTMLButtonElement;
  await act(async () => { addButton.click(); await new Promise(r => setTimeout(r, 20)); });
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({ name: "step-cli", provider: { adapter: "step-cli" } });
  expect(posted[0]?.provider).not.toHaveProperty("apiKey");
  expect(added).toEqual(["step-cli"]);
});

test("selecting claude-cli shows the subscription warning above Add, and Add still saves", async () => {
  await mount("paid");
  expect(warning()).toBeNull();
  const row = [...win.document.querySelectorAll(".provider-catalog-row-wrap > button")]
    .find(el => (el.textContent ?? "").includes("Claude Code CLI")) as unknown as HTMLButtonElement;
  await act(async () => { row.click(); });

  const note = warning();
  expect(note).not.toBeNull();
  expect(note?.getAttribute("role")).toBe("note");
  expect(note?.textContent).toContain("Subscription CLI, not an API key");
  expect(note?.textContent).toContain("Claude Code CLI");
  expect(note?.querySelector("code.chip")?.textContent).toBe("claude -p");
  expect(note?.textContent).toContain("anthropic-apikey");
  // The green free-tier box and the key field are replaced, not shown beside the warning.
  expect(win.document.body.textContent).not.toContain("Free tier");
  expect(win.document.querySelector('input[type="password"]')).toBeNull();

  // The form keeps the preset's own adapter rather than falling back to the first option.
  const adapter = win.document.querySelector('[role="combobox"][aria-label="Adapter"]') as unknown as HTMLButtonElement;
  expect(selectValue(adapter)).toBe("claude-cli");

  const addButton = [...win.document.querySelectorAll("button.btn-primary")]
    .find(el => el.textContent === "Add provider") as unknown as HTMLButtonElement;
  expect(addButton).toBeDefined();
  // Document order: the warning renders before the save control.
  expect(Boolean(note!.compareDocumentPosition(addButton as never) & 4)).toBe(true);
  await act(async () => { addButton.click(); });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
  expect(posted).toHaveLength(1);
  expect((posted[0]?.provider as { adapter?: string } | undefined)?.adapter).toBe("claude-cli");
  expect(posted[0]?.name).toBe("claude-cli");
  expect(added).toEqual(["claude-cli"]);
});

test("a keyless free row keeps the free-tier box and no subscription warning", async () => {
  await mount("free");
  const row = [...win.document.querySelectorAll(".provider-catalog-row-wrap > button")]
    .find(el => (el.textContent ?? "").includes("Keyless Free")) as unknown as HTMLButtonElement;
  await act(async () => { row.click(); });
  expect(warning()).toBeNull();
  expect(win.document.body.textContent).toContain("Free tier");
});

test("the Antigravity ACP row is a subscription CLI with its own warning, never a free tier", async () => {
  await mount("free");
  expect(rowsText()).not.toContain("Antigravity CLI");
  await mount("paid");
  expect(rowsText()).toContain("Antigravity CLI (ACP, local)");
  const row = [...win.document.querySelectorAll(".provider-catalog-row-wrap > button")]
    .find(el => (el.textContent ?? "").includes("Antigravity CLI")) as unknown as HTMLButtonElement;
  await act(async () => { row.click(); });
  const note = warning();
  expect(note?.textContent).toContain("Subscription CLI, not an API key");
  expect(note?.textContent).toContain("agy acp");
  // It names only the fallback the code refuses: subagent fallback, not every fallback route.
  expect(note?.textContent).toContain("subagent fallback routing");
  expect(note?.textContent).toContain("proxy host");
  expect(note?.textContent).toContain("An undeclared loopback relay");
  expect(note?.textContent).toContain("dashboardTrustedProxy");
  expect(note?.textContent).toContain("google");
  expect(note?.textContent).not.toContain("Claude");
  expect(win.document.body.textContent).not.toContain("Free tier");
  expect(win.document.querySelector('input[type="password"]')).toBeNull();
});

test("Vertex accepts ADC project and location without a dummy API key", async () => {
  await mount("paid");
  const row = [...win.document.querySelectorAll(".provider-catalog-row-wrap > button")]
    .find(el => (el.textContent ?? "").includes("Google Vertex AI")) as unknown as HTMLButtonElement;
  await act(async () => { row.click(); });
  const inputFor = (label: string) => [...win.document.querySelectorAll("label")]
    .find(element => element.textContent?.includes(label))?.querySelector("input") as unknown as HTMLInputElement;
  const project = inputFor("Project ID");
  const location = inputFor("Location");
  expect(project).toBeDefined();
  expect(location).toBeDefined();
  expect(location.getAttribute("aria-label")).toBe("Location (optional)");
  expect(win.document.body.textContent).toContain("Application Default Credentials");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!;
    setter.call(project, "demo-project"); project.dispatchEvent(new win.Event("input", { bubbles: true }));
    setter.call(location, "us-central1"); location.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
  const addButton = [...win.document.querySelectorAll("button.btn-primary")]
    .find(el => el.textContent === "Add provider") as unknown as HTMLButtonElement;
  await act(async () => { addButton.click(); await new Promise(r => setTimeout(r, 20)); });
  expect(posted).toHaveLength(1);
  expect(posted[0]?.provider).toMatchObject({ googleMode: "vertex", project: "demo-project", location: "us-central1", liveModels: false });
  expect(posted[0]?.provider).not.toHaveProperty("apiKey");
});

test("Vertex API-key express setup leaves the optional project unset", async () => {
  await mount("paid");
  const row = [...win.document.querySelectorAll(".provider-catalog-row-wrap > button")]
    .find(el => (el.textContent ?? "").includes("Google Vertex AI")) as unknown as HTMLButtonElement;
  await act(async () => { row.click(); });
  const input = win.document.querySelector('input[type="password"]') as unknown as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(input, "fixture-key");
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
  const add = [...win.document.querySelectorAll("button.btn-primary")]
    .find(el => el.textContent === "Add provider") as unknown as HTMLButtonElement;
  await act(async () => { add.click(); await new Promise(r => setTimeout(r, 20)); });
  expect(posted[0]?.provider).toMatchObject({ googleMode: "vertex", apiKey: "fixture-key" });
  expect(posted[0]?.provider).not.toHaveProperty("project");
  expect(posted[0]?.provider).not.toHaveProperty("location");
});
