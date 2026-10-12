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
let reloadFails = false;
let mirrorStatus = "written";
let roleRows: Array<{ role: string; model: string | null; effort: string | null; omoJsoncModel: string | null }>;
let requests: Array<{ method: string; url: string; body: unknown }> = [];

const PROPOSALS = {
  sizingModel: "gpt-5.5",
  sizingError: null,
  proposals: [
    { role: "explorer", model: "gpt-5.5", effort: "high", status: "proposed", tier: "fast", effortIntent: "glance", rationale: "Read-only search.", moveUpIf: "It edits.", moveDownIf: "Never.", proposedModel: "a/small", proposedEffort: "low", reason: null },
    { role: "worker", model: null, effort: null, status: "proposed", tier: "standard", effortIntent: "measured", rationale: "Writes code.", moveUpIf: "Cross-module.", moveDownIf: "Renames only.", proposedModel: "a/mid", proposedEffort: null, reason: null },
    { role: "vague", model: null, effort: null, status: "unsized", reason: "the sizing model did not answer with JSON" },
  ],
  candidates: [],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#integrations/codex" });
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
  apiBase = `http://ocx-lazycodex-auto-${mountCount}.invalid`;
  requests = [];
  reloadFails = false;
  mirrorStatus = "written";
  roleRows = [
    { role: "explorer", model: "gpt-5.5", effort: "high", omoJsoncModel: null },
    { role: "vague", model: null, effort: null, omoJsoncModel: null },
    { role: "worker", model: null, effort: "high", omoJsoncModel: null },
  ];
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    if (method !== "GET") requests.push({ method, url, body: JSON.parse(String(init?.body)) });
    if (url.endsWith("/auto-assign")) return json(PROPOSALS);
    if (method === "PUT") {
      const body = JSON.parse(String(init?.body));
      const role = url.slice(url.lastIndexOf("/") + 1);
      roleRows = roleRows.map(row => row.role === role ? { ...row, model: body.model ?? row.model, effort: body.effort === undefined ? row.effort : body.effort } : row);
      return json({ ok: true, toml: { status: "written" }, omoJsonc: { status: mirrorStatus } });
    }
    if (url.endsWith("/api/subagent-models")) return json({ available: ["gpt-5.5", "a/small", "a/mid"] });
    if (url.endsWith("/api/injection-model")) return json({ efforts: ["low", "medium", "high"] });
    if (reloadFails) return json({ error: "unavailable" }, 503);
    return json({
      lazycodex: { detected: true, pluginEnabled: true, pluginInstalled: true },
      omoJsonc: { state: "present" },
      roles: roleRows,
    });
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

function button(label: string, scope: ParentNode = container): HTMLButtonElement {
  const found = [...scope.querySelectorAll("button")].find(node => node.textContent === label);
  if (!found) throw new Error(`no button ${label}`);
  return found as HTMLButtonElement;
}

function proposal(role: string): HTMLElement {
  return container.querySelector(`[aria-label="Proposal for ${role}"]`) as HTMLElement;
}

async function click(node: HTMLButtonElement): Promise<void> {
  await act(async () => { node.click(); });
  await settle();
}

test("auto-assign shows proposals for review and writes nothing until a row is applied", async () => {
  await mount();
  await click(button("Auto-assign"));
  expect(requests).toEqual([{ method: "POST", url: `${apiBase}/api/codex-agent-roles/auto-assign`, body: {} }]);
  expect(container.textContent).toContain("Sized with gpt-5.5");
  expect(proposal("explorer").textContent).toContain("a/small · low");
  expect(proposal("explorer").textContent).toContain("Fast tier, glance effort");
  expect(proposal("explorer").textContent).toContain("Move up if: It edits.");
  expect(proposal("vague").textContent).toContain("Not sized: the sizing model did not answer with JSON");
  expect(proposal("vague").querySelector("button")).toBeNull();

  await click(button("Apply", proposal("explorer")));
  expect(requests.slice(1)).toEqual([
    { method: "PUT", url: `${apiBase}/api/codex-agent-roles/explorer`, body: { model: "a/small", effort: "low" } },
  ]);
  expect(proposal("explorer").textContent).toContain("Applied");
});

test("apply all writes each remaining proposal once and skips unsized roles", async () => {
  await mount();
  await click(button("Auto-assign"));
  await click(button("Apply all"));
  expect(requests.slice(1)).toEqual([
    { method: "PUT", url: `${apiBase}/api/codex-agent-roles/explorer`, body: { model: "a/small", effort: "low" } },
    { method: "PUT", url: `${apiBase}/api/codex-agent-roles/worker`, body: { model: "a/mid" } },
  ]);
  expect(container.textContent).toContain("Applied 2 of 2 proposals.");
  expect(button("Apply all").disabled).toBe(true);
});

test("a proposal that matches the role's current model and effort is shown as already set", async () => {
  PROPOSALS.proposals[0] = { ...PROPOSALS.proposals[0]!, model: "a/small", effort: "low" };
  try {
    await mount();
    await click(button("Auto-assign"));
    expect(proposal("explorer").textContent).toContain("Already set");
    expect(proposal("explorer").querySelector("button")).toBeNull();
    await click(button("Apply all"));
    expect(requests.slice(1).map(r => r.url)).toEqual([`${apiBase}/api/codex-agent-roles/worker`]);
  } finally {
    PROPOSALS.proposals[0] = { ...PROPOSALS.proposals[0]!, model: "gpt-5.5", effort: "high" };
  }
});

function roleRow(role: string): HTMLElement {
  return [...container.querySelectorAll("tbody tr")].find(tr => tr.querySelector("td")?.textContent === role) as HTMLElement;
}

async function expectEffortOptions(role: string, options: string[]): Promise<void> {
  const trigger = container.querySelector(`[aria-label="Reasoning effort (${role})"]`) as HTMLButtonElement;
  await act(async () => { trigger.click(); });
  expect([...testWindow.document.querySelectorAll('[role="option"]')].map(node => node.textContent)).toEqual(options);
  await act(async () => { trigger.click(); });
}

for (const mirrorFails of [false, true]) {
  test(`a no-ladder proposal retains a pin through failed reloads and mirror retries (mirror fails: ${mirrorFails})`, async () => {
    await mount();
    await click(button("Auto-assign"));
    reloadFails = true;
    mirrorStatus = mirrorFails ? "write_failed" : "written";
    await click(button("Apply", proposal("worker")));
    expect(requests.slice(1)).toEqual([{ method: "PUT", url: `${apiBase}/api/codex-agent-roles/worker`, body: { model: "a/mid" } }]);
    expect(roleRow("worker").querySelectorAll("td")[1]!.textContent).toBe("a/mid · high");
    expect(container.textContent).toContain("worker now runs on a/mid · high");
    await expectEffortOptions("worker", ["Inherit effort", "high", "low", "medium"]);
    const save = roleRow("worker").querySelector("button.btn-primary") as HTMLButtonElement;
    expect(save.disabled).toBe(!mirrorFails);
    if (mirrorFails) {
      expect(save.textContent).toBe("Retry omo.jsonc");
      mirrorStatus = "written";
      await click(save);
      expect(requests.slice(1).map(r => r.body)).toEqual([{ model: "a/mid" }, { model: "a/mid" }]);
      expect(roleRow("worker").querySelectorAll("td")[1]!.textContent).toBe("a/mid · high");
      expect((roleRow("worker").querySelector("button.btn-primary") as HTMLButtonElement).disabled).toBe(true);
    }
  });
}

test("Apply all merges both confirmed rows when every reload fails", async () => {
  await mount();
  await click(button("Auto-assign"));
  reloadFails = true;
  await click(button("Apply all"));
  expect(requests.slice(1).map(r => r.body)).toEqual([{ model: "a/small", effort: "low" }, { model: "a/mid" }]);
  expect(roleRow("explorer").querySelectorAll("td")[1]!.textContent).toBe("a/small · low");
  expect(roleRow("worker").querySelectorAll("td")[1]!.textContent).toBe("a/mid · high");
  await expectEffortOptions("explorer", ["Inherit effort", "low", "medium", "high"]);
  await expectEffortOptions("worker", ["Inherit effort", "high", "low", "medium"]);
  for (const role of ["explorer", "worker"]) {
    expect((roleRow(role).querySelector("button.btn-primary") as HTMLButtonElement).disabled).toBe(true);
  }
  expect(button("Apply all").disabled).toBe(true);
});
test("applying a no-ladder proposal resends an effort whose omo.jsonc mirror is still pending", async () => {
  roleRows = roleRows.map(row => row.role === "worker" ? { ...row, model: "gpt-5.5", effort: "high" } : row);
  mirrorStatus = "write_failed";
  await mount();
  const trigger = container.querySelector('[aria-label="Reasoning effort (worker)"]') as HTMLButtonElement;
  await act(async () => { trigger.click(); });
  const low = [...testWindow.document.querySelectorAll('[role="option"]')].find(node => node.textContent === "low") as unknown as HTMLElement;
  await act(async () => { low.click(); });
  await click(roleRow("worker").querySelector("button.btn-primary") as HTMLButtonElement);
  mirrorStatus = "written";
  await click(button("Auto-assign"));
  await click(button("Apply", proposal("worker")));
  expect(requests.filter(r => r.method === "PUT").map(r => r.body)).toEqual([
    { model: "gpt-5.5", effort: "low" },
    { model: "a/mid", effort: "low" },
  ]);
  expect(roleRow("worker").querySelectorAll("td")[1]!.textContent).toBe("a/mid · low");
  expect((roleRow("worker").querySelector("button.btn-primary") as HTMLButtonElement).disabled).toBe(true);
});

test("Apply after a failed effort-only mirror on a model-inheriting role carries that effort", async () => {
  mirrorStatus = "write_failed";
  await mount();
  expect(roleRow("worker").querySelectorAll("td")[1]!.textContent).toBe("No model pin · high");
  const trigger = container.querySelector('[aria-label="Reasoning effort (worker)"]') as HTMLButtonElement;
  await act(async () => { trigger.click(); });
  const low = [...testWindow.document.querySelectorAll('[role="option"]')].find(node => node.textContent === "low") as unknown as HTMLElement;
  await act(async () => { low.click(); });
  await click(roleRow("worker").querySelector("button.btn-primary") as HTMLButtonElement);
  expect(roleRow("worker").querySelectorAll("td")[1]!.textContent).toBe("No model pin · low");
  mirrorStatus = "written";
  await click(button("Auto-assign"));
  await click(button("Apply", proposal("worker")));
  expect(requests.filter(r => r.method === "PUT").map(r => r.body)).toEqual([
    { effort: "low" },
    { model: "a/mid", effort: "low" },
  ]);
  expect(roleRow("worker").querySelectorAll("td")[1]!.textContent).toBe("a/mid · low");
});
