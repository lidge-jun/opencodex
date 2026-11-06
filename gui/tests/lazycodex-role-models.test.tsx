import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { validateAgentRoleEffort } from "../../src/codex/agent-role-models";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "crypto", "IS_REACT_ACT_ENVIRONMENT"] as const;

let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let mountCount = 0;
let apiBase = "";
let puts: Array<{ url: string; body: unknown }> = [];
let omoWriteStatus = "written";
let putFailure: { status: number; body: unknown } | null = null;
let rolesFailure: { status: number; body: unknown } | null = null;
let rolesBody: unknown;
let effortsFailure = false;
let rolesHold: Promise<void> | null = null;
let fetched: string[] = [];

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
  apiBase = `http://ocx-lazycodex-roles-${mountCount}.invalid`;
  puts = [];
  fetched = [];
  omoWriteStatus = "written";
  putFailure = null;
  rolesFailure = null;
  effortsFailure = false;
  rolesHold = null;
  rolesBody = {
    lazycodex: { detected: true, pluginEnabled: true, pluginInstalled: true },
    omoJsonc: { state: "present" },
    roles: [
      { role: "explorer", model: "gpt-5.5", omoJsoncModel: null },
      { role: "librarian", model: null, omoJsoncModel: null },
    ],
  };
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    fetched.push(url);
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      puts.push({ url, body });
      if (putFailure) return json(putFailure.body, putFailure.status);
      if (body.model === undefined && body.effort === undefined) return json({ error: "empty", code: "empty_update" }, 400);
      if (body.effort !== undefined && body.effort !== null) {
        try {
          validateAgentRoleEffort(body.effort);
        } catch {
          return json({ error: "invalid effort", code: "invalid_effort" }, 400);
        }
      }
      const role = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
      const current = rolesBody as { roles: Array<{ role: string; model: string | null; effort?: string | null; omoJsoncModel?: string | null }> };
      // Like the server, an omitted model leaves both the role pin and the omo.jsonc model alone.
      const model = body.model === undefined ? undefined : body.model as string;
      rolesBody = {
        ...current,
        roles: current.roles.map(row => row.role === role ? {
          ...row,
          model: model ?? row.model,
          effort: body.effort === undefined ? row.effort ?? null : body.effort,
          omoJsoncModel: omoWriteStatus === "written" && model !== undefined ? model : row.omoJsoncModel ?? null,
        } : row),
      };
      // Like the server, a write without a batch starts one and the response names it.
      return json({ ok: true, toml: { status: "written" }, omoJsonc: { status: omoWriteStatus }, batch: body.batch ?? `server-${puts.length}` });
    }
    if (url.endsWith("/api/subagent-models")) return json({ available: ["gpt-5.5", "xai/grok-4.5"] });
    if (url.endsWith("/api/injection-model")) {
      return effortsFailure ? json({ error: "unavailable" }, 503) : json({ efforts: ["low", "medium", "high"] });
    }
    if (rolesFailure) return json(rolesFailure.body, rolesFailure.status);
    const snapshot = rolesBody;
    if (rolesHold) await rolesHold;
    return json(snapshot);
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
  const [{ createRoot }, { LanguageProvider }, { default: LazyCodexRoleModels }] = await Promise.all([
    import("react-dom/client"),
    import("../src/i18n/provider"),
    import("../src/pages/integrations/LazyCodexRoleModels"),
  ]);
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><LazyCodexRoleModels apiBase={apiBase} active /></LanguageProvider>);
  });
  await settle();
}

function saveButton(role: string): HTMLButtonElement {
  const row = [...container.querySelectorAll("tbody tr")].find(tr => tr.textContent?.includes(role));
  return row!.querySelector("button.btn-primary") as HTMLButtonElement;
}

async function pick(role: string, model: string, label = `Model for ${role}`): Promise<void> {
  const trigger = testWindow.document.querySelector(`[aria-label="${label}"]`) as unknown as HTMLButtonElement;
  await act(async () => { trigger.click(); });
  const option = [...testWindow.document.querySelectorAll('[role="option"]')].find(node => node.textContent === model) as unknown as HTMLElement;
  await act(async () => { option.click(); });
}

test("lists roles with their pins and saves a picked model for one row", async () => {
  await mount();
  expect(container.textContent).toContain("omo (Codex / LazyCodex)");
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

test("picking only a reasoning effort enables Save and sends the effort with the current model", async () => {
  await mount();
  expect(saveButton("explorer").disabled).toBe(true);
  await pick("explorer", "high", "Reasoning effort (explorer)");
  expect(saveButton("explorer").disabled).toBe(false);
  await act(async () => { saveButton("explorer").click(); });
  await settle();
  expect(puts).toEqual([{ url: `${apiBase}/api/codex-agent-roles/explorer`, body: { model: "gpt-5.5", effort: "high" } }]);
  expect(container.textContent).toContain("explorer now runs on gpt-5.5 · high.");
  expect(container.textContent).toContain("gpt-5.5 · high");
  expect(saveButton("explorer").disabled).toBe(true);
});

test("a failed effort list still loads the table and saves a model", async () => {
  effortsFailure = true;
  rolesBody = {
    ...(rolesBody as object),
    roles: [{ role: "explorer", model: "gpt-5.5", effort: "medium", omoJsoncModel: null }],
  };
  await mount();
  expect(container.textContent).not.toContain("Could not load Codex agent roles.");
  expect(container.textContent).toContain("gpt-5.5 · medium");
  await pick("explorer", "xai/grok-4.5");
  await act(async () => { saveButton("explorer").click(); });
  await settle();
  expect(puts).toEqual([{ url: `${apiBase}/api/codex-agent-roles/explorer`, body: { model: "xai/grok-4.5" } }]);
});

test("renders nothing and loads no model list when LazyCodex is not detected", async () => {
  rolesBody = { lazycodex: { detected: false, pluginEnabled: false, pluginInstalled: false }, omoJsonc: null, roles: [] };
  await mount();
  expect(container.innerHTML).toBe("");
  expect(fetched).toEqual([`${apiBase}/api/codex-agent-roles`]);
});

test("a failed role load shows the localized error with a retry that recovers the table", async () => {
  rolesFailure = { status: 500, body: { error: "EACCES: permission denied, open '/secret/path'" } };
  await mount();
  expect(container.textContent).toContain("Could not load Codex agent roles.");
  expect(container.textContent).not.toContain("EACCES");
  expect(container.querySelector("table")).toBeNull();
  const retry = [...container.querySelectorAll("button")].find(button => button.textContent === "Retry") as HTMLButtonElement;
  expect(retry).toBeDefined();
  rolesFailure = null;
  await act(async () => { retry.click(); });
  await settle();
  expect(container.textContent).not.toContain("Could not load Codex agent roles.");
  expect(container.textContent).toContain("explorer");
});

test("says when omo.jsonc was skipped because of its comments", async () => {
  rolesBody = { ...(rolesBody as object), omoJsonc: { state: "comments" } };
  omoWriteStatus = "skipped_comments";
  await mount();
  expect(container.textContent).toContain("omo.jsonc has comments");
  await pick("librarian", "gpt-5.5");
  await act(async () => { saveButton("librarian").click(); });
  await settle();
  expect(container.textContent).toContain("comments a save would remove");
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

function pinExplorerEffort(effort: string): void {
  rolesBody = {
    ...(rolesBody as object),
    roles: [{ role: "explorer", model: "gpt-5.5", effort, omoJsoncModel: null }],
  };
}

async function saveEffortWithFailedMirror(): Promise<void> {
  omoWriteStatus = "write_failed";
  await pick("explorer", "high", "Reasoning effort (explorer)");
  await act(async () => { saveButton("explorer").click(); });
  await settle();
}

test("retrying a failed mirror while the reload is still pending resends the saved effort", async () => {
  pinExplorerEffort("low");
  await mount();
  let release = () => {};
  rolesHold = new Promise<void>(resolve => { release = resolve; });
  await saveEffortWithFailedMirror();
  expect(saveButton("explorer").disabled).toBe(false);
  await act(async () => { saveButton("explorer").click(); });
  await settle();
  expect(puts.map(entry => entry.body)).toEqual([{ model: "gpt-5.5", effort: "high" }, { model: "gpt-5.5", effort: "high" }]);
  await act(async () => { release(); });
  await settle();
});

test("retrying a failed mirror after a failed reload resends the saved effort", async () => {
  pinExplorerEffort("low");
  await mount();
  rolesFailure = { status: 500, body: { error: "unavailable" } };
  await saveEffortWithFailedMirror();
  expect(current("explorer")).toBe("gpt-5.5 · high");
  await act(async () => { saveButton("explorer").click(); });
  await settle();
  expect(puts.map(entry => entry.body)).toEqual([{ model: "gpt-5.5", effort: "high" }, { model: "gpt-5.5", effort: "high" }]);
});

test("a model-only save keeps an unchanged effort out of the PUT, even one the server would refuse", async () => {
  pinExplorerEffort("future-provider-effort");
  await mount();
  expect(container.textContent).toContain("gpt-5.5 · future-provider-effort");
  await pick("explorer", "xai/grok-4.5");
  await act(async () => { saveButton("explorer").click(); });
  await settle();
  expect(puts.map(entry => entry.body)).toEqual([{ model: "xai/grok-4.5" }]);
  expect(container.textContent).toContain("xai/grok-4.5 · future-provider-effort");
  expect(container.textContent).not.toContain("Could not save");
});

test("none, minimal and ultra are efforts the role write accepts", () => {
  for (const effort of ["none", "minimal", "ultra"]) expect(validateAgentRoleEffort(effort)).toBe(effort);
  expect(() => validateAgentRoleEffort("future-provider-effort")).toThrow();
});

for (const reload of ["pending", "failed"] as const) {
  test(`a model-only mirror retry still omits the effort after a ${reload} reload`, async () => {
    pinExplorerEffort("future-provider-effort");
    await mount();
    omoWriteStatus = "write_failed";
    let release = () => {};
    if (reload === "pending") rolesHold = new Promise<void>(resolve => { release = resolve; });
    else rolesFailure = { status: 500, body: { error: "unavailable" } };
    await pick("explorer", "xai/grok-4.5");
    await act(async () => { saveButton("explorer").click(); });
    await settle();
    expect(saveButton("explorer").textContent).toBe("Retry omo.jsonc");
    await act(async () => { saveButton("explorer").click(); });
    await settle();
    expect(puts.map(entry => entry.body)).toEqual([{ model: "xai/grok-4.5" }, { model: "xai/grok-4.5" }]);
    await act(async () => { release(); });
    await settle();
  });
}

test("a failed save shows the localized message rather than the server text", async () => {
  putFailure = { status: 500, body: { error: "EACCES: permission denied, open '/secret/path'", code: "write_failed" } };
  await mount();
  await pick("explorer", "xai/grok-4.5");
  await act(async () => { saveButton("explorer").click(); });
  await settle();
  expect(container.textContent).toContain("Could not save the model for explorer.");
  expect(container.textContent).not.toContain("EACCES");
});

function roleRow(role: string): HTMLElement {
  return [...container.querySelectorAll("tbody tr")].find(tr => tr.querySelector("td")?.textContent === role) as HTMLElement;
}

function current(role: string): string | null {
  return roleRow(role).querySelectorAll("td")[1]!.textContent;
}

async function effortOptions(role: string): Promise<Array<string | null>> {
  const trigger = container.querySelector(`[aria-label="Reasoning effort (${role})"]`) as HTMLButtonElement;
  await act(async () => { trigger.click(); });
  const options = [...testWindow.document.querySelectorAll('[role="option"]')].map(node => node.textContent);
  await act(async () => { trigger.click(); });
  return options;
}

for (const reloadFails of [false, true]) {
  test(`Inherit clears a pinned effort and preserves a null mirror retry (reload fails: ${reloadFails})`, async () => {
    pinExplorerEffort("high");
    await mount();
    expect(await effortOptions("explorer")).toEqual(["Inherit effort", "high", "low", "medium"]);
    expect(saveButton("explorer").disabled).toBe(true);
    await pick("explorer", "Inherit effort", "Reasoning effort (explorer)");
    expect(saveButton("explorer").disabled).toBe(false);
    omoWriteStatus = "write_failed";
    if (reloadFails) rolesFailure = { status: 503, body: { error: "unavailable" } };
    await act(async () => { saveButton("explorer").click(); });
    await settle();
    expect(current("explorer")).toBe("gpt-5.5");
    expect(await effortOptions("explorer")).toEqual(["Inherit effort", "low", "medium", "high"]);
    expect(saveButton("explorer").disabled).toBe(false);
    omoWriteStatus = "written";
    await act(async () => { saveButton("explorer").click(); });
    await settle();
    expect(puts.map(entry => entry.body)).toEqual([{ model: "gpt-5.5", effort: null }, { model: "gpt-5.5", effort: null }]);
    expect(current("explorer")).toBe("gpt-5.5");
    expect(saveButton("explorer").disabled).toBe(true);
  });
}

for (const reloadFails of [false, true]) {
  test(`model changes retain an outstanding effort mirror write (reload fails: ${reloadFails})`, async () => {
    pinExplorerEffort("low");
    await mount();
    if (reloadFails) rolesFailure = { status: 503, body: { error: "unavailable" } };
    await saveEffortWithFailedMirror();
    expect(current("explorer")).toBe("gpt-5.5 · high");
    expect(await effortOptions("explorer")).toEqual(["Inherit effort", "high", "low", "medium"]);
    expect(saveButton("explorer").disabled).toBe(false);
    await pick("explorer", "xai/grok-4.5");
    omoWriteStatus = "written";
    await act(async () => { saveButton("explorer").click(); });
    await settle();
    expect(puts.map(entry => entry.body)).toEqual([{ model: "gpt-5.5", effort: "high" }, { model: "xai/grok-4.5", effort: "high" }]);
    expect(current("explorer")).toBe("xai/grok-4.5 · high");
    expect(saveButton("explorer").disabled).toBe(true);
  });
}

test("a new effort choice outranks an outstanding mirror effort", async () => {
  pinExplorerEffort("low");
  await mount();
  await saveEffortWithFailedMirror();
  await pick("explorer", "xai/grok-4.5");
  await pick("explorer", "Inherit effort", "Reasoning effort (explorer)");
  expect(saveButton("explorer").disabled).toBe(false);
  omoWriteStatus = "written";
  await act(async () => { saveButton("explorer").click(); });
  await settle();
  expect(puts.map(entry => entry.body)).toEqual([{ model: "gpt-5.5", effort: "high" }, { model: "xai/grok-4.5", effort: null }]);
  expect(current("explorer")).toBe("xai/grok-4.5");
  expect(saveButton("explorer").disabled).toBe(true);
});

test("a successful mirror with a failed reload publishes its confirmed model and effort", async () => {
  pinExplorerEffort("low");
  await mount();
  rolesFailure = { status: 503, body: { error: "unavailable" } };
  await pick("explorer", "xai/grok-4.5");
  await pick("explorer", "high", "Reasoning effort (explorer)");
  await act(async () => { saveButton("explorer").click(); });
  await settle();
  expect(puts.map(entry => entry.body)).toEqual([{ model: "xai/grok-4.5", effort: "high" }]);
  expect(current("explorer")).toBe("xai/grok-4.5 · high");
  expect(await effortOptions("explorer")).toEqual(["Inherit effort", "high", "low", "medium"]);
  expect(saveButton("explorer").disabled).toBe(true);
  await pick("explorer", "Inherit effort", "Reasoning effort (explorer)");
  expect(saveButton("explorer").disabled).toBe(false);
});

test("a pre-save GET resolving late cannot overwrite a confirmed save", async () => {
  pinExplorerEffort("low");
  await mount();
  let release = () => {};
  rolesHold = new Promise<void>(resolve => { release = resolve; });
  const { invalidateClientResource } = await import("../src/client-resource");
  await act(async () => { invalidateClientResource(`lazycodex-role-models:${apiBase}`); });
  await settle();
  rolesFailure = { status: 503, body: { error: "unavailable" } };
  await pick("explorer", "high", "Reasoning effort (explorer)");
  await act(async () => { saveButton("explorer").click(); });
  await settle();
  await act(async () => { release(); });
  await settle();
  expect(puts.map(entry => entry.body)).toEqual([{ model: "gpt-5.5", effort: "high" }]);
  expect(current("explorer")).toBe("gpt-5.5 · high");
  expect(await effortOptions("explorer")).toEqual(["Inherit effort", "high", "low", "medium"]);
  expect(saveButton("explorer").disabled).toBe(true);
});

function inheritLibrarian(effort: string | null): void {
  rolesBody = {
    ...(rolesBody as object),
    roles: [
      { role: "explorer", model: "gpt-5.5", effort: null, omoJsoncModel: null },
      { role: "librarian", model: null, effort, omoJsoncModel: "omo/pick" },
    ],
  };
}

function librarianRow(): { model: string | null; effort: string | null; omoJsoncModel: string | null } {
  const { model, effort, omoJsoncModel } = (rolesBody as { roles: Array<{ role: string; model: string | null; effort: string | null; omoJsoncModel: string | null }> })
    .roles.find(row => row.role === "librarian")!;
  return { model, effort, omoJsoncModel };
}

for (const reloadFails of [false, true]) {
  test(`a role that inherits its model saves a new effort without a model (reload fails: ${reloadFails})`, async () => {
    inheritLibrarian("high");
    await mount();
    expect(current("librarian")).toBe("No model pin · high");
    expect(saveButton("librarian").disabled).toBe(true);
    await pick("librarian", "low", "Reasoning effort (librarian)");
    expect(saveButton("librarian").disabled).toBe(false);
    if (reloadFails) rolesFailure = { status: 503, body: { error: "unavailable" } };
    await act(async () => { saveButton("librarian").click(); });
    await settle();
    expect(puts).toEqual([{ url: `${apiBase}/api/codex-agent-roles/librarian`, body: { effort: "low" } }]);
    expect(librarianRow()).toEqual({ model: null, effort: "low", omoJsoncModel: "omo/pick" });
    expect(container.textContent).toContain("librarian now runs on No model pin · low.");
    expect(current("librarian")).toBe("No model pin · low");
    expect(saveButton("librarian").disabled).toBe(true);
    expect(saveButton("librarian").textContent).toBe("Save");
  });
}

test("Inherit effort clears a model-inheriting role's effort without a model", async () => {
  inheritLibrarian("high");
  await mount();
  await pick("librarian", "Inherit effort", "Reasoning effort (librarian)");
  expect(saveButton("librarian").disabled).toBe(false);
  await act(async () => { saveButton("librarian").click(); });
  await settle();
  expect(puts.map(entry => entry.body)).toEqual([{ effort: null }]);
  expect(current("librarian")).toBe("No model pin");
  expect(container.textContent).toContain("librarian now runs on No model pin.");
  expect(saveButton("librarian").disabled).toBe(true);
});

test("a role with neither a model nor an effort pin saves once an effort is picked", async () => {
  await mount();
  expect(current("librarian")).toBe("No model pin");
  expect(saveButton("librarian").disabled).toBe(true);
  expect(saveButton("librarian").textContent).toBe("Save");
  await pick("librarian", "high", "Reasoning effort (librarian)");
  await act(async () => { saveButton("librarian").click(); });
  await settle();
  expect(puts.map(entry => entry.body)).toEqual([{ effort: "high" }]);
  expect(current("librarian")).toBe("No model pin · high");
  expect(saveButton("librarian").disabled).toBe(true);
});

for (const [choice, sent] of [["low", "low"], ["Inherit effort", null]] as const) {
  for (const reload of ["pending", "failed"] as const) {
    test(`an effort-only mirror retry resends ${String(sent)} without a model after a ${reload} reload`, async () => {
      inheritLibrarian("high");
      await mount();
      omoWriteStatus = "write_failed";
      let release = () => {};
      if (reload === "pending") rolesHold = new Promise<void>(resolve => { release = resolve; });
      else rolesFailure = { status: 503, body: { error: "unavailable" } };
      await pick("librarian", choice, "Reasoning effort (librarian)");
      await act(async () => { saveButton("librarian").click(); });
      await settle();
      expect(container.textContent).toContain("omo.jsonc could not be written");
      expect(current("librarian")).toBe(sent ? `No model pin · ${sent}` : "No model pin");
      expect(saveButton("librarian").disabled).toBe(false);
      expect(saveButton("librarian").textContent).toBe("Retry omo.jsonc");
      omoWriteStatus = "written";
      await act(async () => { saveButton("librarian").click(); });
      await settle();
      expect(puts.map(entry => entry.body)).toEqual([{ effort: sent }, { effort: sent }]);
      expect(saveButton("librarian").disabled).toBe(true);
      expect(saveButton("librarian").textContent).toBe("Save");
      await act(async () => { release(); });
      await settle();
    });
  }
}

test("picking a model after a failed effort-only mirror sends both, and only then pins a model", async () => {
  inheritLibrarian("high");
  await mount();
  omoWriteStatus = "write_failed";
  await pick("librarian", "low", "Reasoning effort (librarian)");
  await act(async () => { saveButton("librarian").click(); });
  await settle();
  await pick("librarian", "xai/grok-4.5");
  expect(saveButton("librarian").textContent).toBe("Save");
  omoWriteStatus = "written";
  await act(async () => { saveButton("librarian").click(); });
  await settle();
  expect(puts.map(entry => entry.body)).toEqual([{ effort: "low" }, { model: "xai/grok-4.5", effort: "low" }]);
  expect(current("librarian")).toBe("xai/grok-4.5 · low");
});

test("lists the role change history as one entry per batch and restores a batch's earlier values together", async () => {
  rolesBody = {
    ...(rolesBody as Record<string, unknown>),
    history: [
      { at: "2026-10-22T00:09:35.000Z", batch: "apply-all", role: "librarian", before: { model: null, effort: "medium" }, after: { model: "xai/grok-4.5", effort: "low" } },
      { at: "2026-10-22T00:09:34.000Z", batch: "apply-all", role: "explorer", before: { model: "gpt-5.5", effort: null }, after: { model: "xai/grok-4.5", effort: "low" } },
    ],
  };
  await mount();
  const entries = container.querySelectorAll(".lazycodex-role-history > ul > li");
  expect(entries.length).toBe(1);
  expect(entries[0]!.textContent).toContain("explorer: gpt-5.5 → xai/grok-4.5 · low");
  const restore = entries[0]!.querySelector("button") as HTMLButtonElement;
  await act(async () => { restore.click(); });
  await settle();
  expect(puts.map(put => ({ role: put.url.slice(put.url.lastIndexOf("/") + 1), body: put.body }))).toEqual([
    { role: "librarian", body: { effort: "medium", restores: "apply-all" } },
    { role: "explorer", body: { model: "gpt-5.5", effort: null, batch: "server-1", restores: "apply-all" } },
  ]);
  expect(container.textContent).toContain("Restored 2 role(s)");
});

test("keeps the role table editable and says why Restore is gone when the history cannot be read", async () => {
  rolesBody = { ...(rolesBody as Record<string, unknown>), history: [], historyUnavailable: true };
  await mount();
  expect(container.textContent).toContain("The change history could not be read");
  expect(container.querySelector(".lazycodex-role-history")).toBeNull();
  expect(saveButton("explorer")).not.toBeNull();
});

test("stops a Restore at the first failed role and warns that the batch is only partly back", async () => {
  rolesBody = {
    ...(rolesBody as Record<string, unknown>),
    history: [
      { at: "2026-10-22T00:09:35.000Z", batch: "apply-all", role: "librarian", before: { model: null, effort: "medium" }, after: { model: "xai/grok-4.5", effort: "low" } },
      { at: "2026-10-22T00:09:34.000Z", batch: "apply-all", role: "explorer", before: { model: "gpt-5.5", effort: null }, after: { model: "xai/grok-4.5", effort: "low" } },
    ],
  };
  await mount();
  putFailure = { status: 500, body: { error: "write failed" } };
  const restore = container.querySelector(".lazycodex-role-history > ul > li button") as HTMLButtonElement;
  await act(async () => { restore.click(); });
  await settle();
  expect(puts).toHaveLength(1);
  expect(container.textContent).toContain("Restore stopped at librarian: 0 of 2 role(s) went back");
  expect(container.textContent).not.toContain("Restored 0 role(s)");
});

for (const availability of ["absent", "throws"] as const) {
  test(`Restore writes the batch back and frees its button when randomUUID is ${availability}`, async () => {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: availability === "absent" ? {}
      : { randomUUID: () => { throw new Error("insecure context"); } } });
    rolesBody = {
      ...(rolesBody as Record<string, unknown>),
      history: [
        { at: "2026-10-22T00:09:35.000Z", batch: "apply-all", role: "librarian", before: { model: null, effort: "medium" }, after: { model: "xai/grok-4.5", effort: "low" } },
        { at: "2026-10-22T00:09:34.000Z", batch: "apply-all", role: "explorer", before: { model: "gpt-5.5", effort: null }, after: { model: "xai/grok-4.5", effort: "low" } },
      ],
    };
    await mount();
    const restore = () => container.querySelector(".lazycodex-role-history > ul > li button") as HTMLButtonElement;
    await act(async () => { restore().click(); });
    await settle();
    expect(puts).toHaveLength(2);
    expect(puts.map(put => (put.body as { batch?: string }).batch)).toEqual([undefined, "server-1"]);
    expect(container.textContent).toContain("Restored 2 role(s)");
    expect(restore().disabled).toBe(false);
    expect(restore().textContent).toBe("Restore");
  });
}
