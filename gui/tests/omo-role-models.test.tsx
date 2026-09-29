import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;

let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let mountCount = 0;
let apiBase = "";
let puts: Array<{ url: string; body: unknown }> = [];
let omoWriteStatus = "written";
let putFailure: { status: number; body: unknown } | null = null;
let rolesBody: unknown;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#integrations/omo" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mountCount += 1;
  apiBase = `http://ocx-omo-roles-${mountCount}.invalid`;
  puts = [];
  omoWriteStatus = "written";
  putFailure = null;
  rolesBody = {
    roles: [
      { role: "explorer", model: "gpt-5.5", omoModel: null },
      { role: "librarian", model: null, omoModel: null },
    ],
    omo: { state: "present" },
  };
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      puts.push({ url, body });
      if (putFailure) return json(putFailure.body, putFailure.status);
      const role = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
      const current = rolesBody as { roles: Array<{ role: string; model: string | null }> };
      rolesBody = { ...current, roles: current.roles.map(row => row.role === role ? { ...row, model: body.model } : row) };
      return json({ ok: true, toml: { status: "written" }, omo: { status: omoWriteStatus } });
    }
    if (url.endsWith("/api/subagent-models")) return json({ available: ["gpt-5.5", "xai/grok-4.5"] });
    return json(rolesBody);
  }) as typeof fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: mockFetch });
  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function settle(): Promise<void> {
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 30)); });
}

async function mount(): Promise<void> {
  const [{ createRoot }, { LanguageProvider }, { default: OmoRoleModels }] = await Promise.all([
    import("react-dom/client"),
    import("../src/i18n/provider"),
    import("../src/pages/integrations/OmoRoleModels"),
  ]);
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><OmoRoleModels apiBase={apiBase} active /></LanguageProvider>);
  });
  await settle();
}

function saveButton(role: string): HTMLButtonElement {
  const row = [...container.querySelectorAll("tbody tr")].find(tr => tr.textContent?.includes(role));
  return row!.querySelector("button.btn-primary") as HTMLButtonElement;
}

async function pick(role: string, model: string): Promise<void> {
  const trigger = testWindow.document.querySelector(`[aria-label="Model for ${role}"]`) as unknown as HTMLButtonElement;
  await act(async () => { trigger.click(); });
  const option = [...testWindow.document.querySelectorAll('[role="option"]')].find(node => node.textContent === model) as unknown as HTMLElement;
  await act(async () => { option.click(); });
}

test("lists roles with their pins and saves a picked model for one row", async () => {
  await mount();
  expect(container.textContent).toContain("explorer");
  expect(container.textContent).toContain("gpt-5.5");
  expect(container.textContent).toContain("No model pin");
  expect(saveButton("explorer").disabled).toBe(true);
  await pick("explorer", "xai/grok-4.5");
  expect(saveButton("explorer").disabled).toBe(false);
  await act(async () => { saveButton("explorer").click(); });
  await settle();
  expect(puts).toEqual([{ url: `${apiBase}/api/codex-agent-roles/explorer`, body: { model: "xai/grok-4.5" } }]);
  expect(container.textContent).toContain("explorer now runs on xai/grok-4.5.");
});

test("says when omo.jsonc was skipped because of its comments", async () => {
  rolesBody = { ...(rolesBody as object), omo: { state: "comments" } };
  omoWriteStatus = "skipped_comments";
  await mount();
  expect(container.textContent).toContain("omo.jsonc contains comments");
  await pick("librarian", "gpt-5.5");
  await act(async () => { saveButton("librarian").click(); });
  await settle();
  expect(container.textContent).toContain("saving would remove its comments");
});

test("a failed omo.jsonc mirror can be retried with the same model", async () => {
  omoWriteStatus = "write_failed";
  await mount();
  await pick("explorer", "xai/grok-4.5");
  await act(async () => { saveButton("explorer").click(); });
  await settle();
  expect(container.textContent).toContain("omo.jsonc could not be written");
  expect(container.textContent).toContain("xai/grok-4.5");
  expect(saveButton("explorer").disabled).toBe(false);
  expect(saveButton("explorer").textContent).toBe("Retry omo.jsonc");
  omoWriteStatus = "written";
  await act(async () => { saveButton("explorer").click(); });
  await settle();
  expect(puts.map(entry => entry.body)).toEqual([{ model: "xai/grok-4.5" }, { model: "xai/grok-4.5" }]);
  expect(container.textContent).toContain("explorer now runs on xai/grok-4.5.");
  expect(saveButton("explorer").disabled).toBe(true);
  expect(saveButton("explorer").textContent).toBe("Save");
});

test("a failed save shows the localized message rather than the server text", async () => {
  putFailure = { status: 500, body: { error: "EACCES: permission denied, open '/secret/path'", code: "write_failed" } };
  await mount();
  await pick("explorer", "xai/grok-4.5");
  await act(async () => { saveButton("explorer").click(); });
  await settle();
  expect(container.textContent).toContain("Could not save the model for explorer.");
  expect(container.textContent).not.toContain("EACCES");
});
