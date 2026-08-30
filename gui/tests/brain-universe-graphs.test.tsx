import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import BrainUniverse from "../src/pages/BrainUniverse";

const originalFetch = globalThis.fetch;
const domGlobals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof domGlobals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  clearClientResourceStoresForTests();
  previousGlobals = Object.fromEntries(
    domGlobals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#brain" });
  testWindow.localStorage.setItem("ocx-lang", "en");
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);

  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith("/api/agent-os/agents")) return Response.json({ agents: [] });
    if (url.endsWith("/api/agent-os/tasks")) return Response.json({ tasks: [] });
    if (url.endsWith("/api/agent-os/skills")) return Response.json({ skills: [], issues: [] });
    if (url.endsWith("/api/agent-os/nodes")) return Response.json({ nodes: [] });
    if (url.endsWith("/api/agent-os/memory")) return Response.json({ memories: [] });
    if (url.endsWith("/api/agent-os/permits/pending")) return Response.json({ approvals: [] });
    if (url.endsWith("/api/agent-os/policies")) return Response.json({ policies: [] });
    if (url.endsWith("/api/agent-os/projects")) {
      return Response.json({
        projects: [{
          id: "proj_1",
          name: "Atlas Project",
          rootPath: "C:/workspace/atlas",
          scanEnabled: true,
          scanMode: "standard",
        }],
      });
    }
    if (url.endsWith("/api/agent-os/projects/proj_1/atlas")) {
      return Response.json({
        project: { id: "proj_1", name: "Atlas Project", rootPath: "C:/workspace/atlas" },
        scan: { id: "scan_1", mode: "standard", createdMs: 1 },
        nodes: [
          { id: "project:proj_1", type: "project", label: "Atlas Project", path: "" },
          { id: "folder:proj_1:src", type: "folder", label: "src", path: "src" },
          { id: "file:proj_1:src/index.ts", type: "file", label: "index.ts", path: "src/index.ts" },
        ],
        edges: [
          { source: "project:proj_1", target: "folder:proj_1:src", type: "contains" },
          { source: "folder:proj_1:src", target: "file:proj_1:src/index.ts", type: "contains" },
        ],
        stats: { fileCount: 1, folderCount: 1, totalBytes: 10, extensions: { ts: 1 } },
      });
    }
    if (url.endsWith("/api/agent-os/universe")) {
      return Response.json({
        nodes: [
          { id: "universe:root", type: "universe", label: "Pao Brain Universe" },
          { id: "project:proj_1", type: "project", label: "Atlas Project", projectId: "proj_1" },
        ],
        edges: [{ source: "universe:root", target: "project:proj_1", type: "contains" }],
        projects: [{
          id: "proj_1",
          name: "Atlas Project",
          rootPath: "C:/workspace/atlas",
          latestScan: { scanId: "scan_1", mode: "standard", createdMs: 1, filesScanned: 1 },
        }],
      });
    }
    if (url.includes("/api/agent-os/audit")) {
      return Response.json({
        events: [
          { id: 1, tsMs: 1, tool: "get_workspace_status", actor: "agent", result: "success", inputSummary: "" },
          { id: 2, tsMs: 2, tool: "start_render_job", actor: "agent", result: "success", inputSummary: "projectId=p1" },
        ],
      });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }) as typeof fetch;
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  globalThis.fetch = originalFetch;
  clearClientResourceStoresForTests();
  for (const key of domGlobals) {
    const descriptor = previousGlobals[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await testWindow.happyDOM?.close?.();
});

async function mount(): Promise<void> {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <BrainUniverse apiBase="" />
      </LanguageProvider>,
    );
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
    await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 5));
  }
}

async function clickTab(label: string): Promise<void> {
  const button = [...container.querySelectorAll<HTMLButtonElement>(".brain-tab")]
    .find((candidate) => candidate.textContent?.includes(label));
  expect(button).toBeTruthy();
  await act(async () => button?.click());
}

test("Atlas tab loads a persisted project graph with folder and file nodes", async () => {
  await mount();
  await waitFor(() => container.textContent?.includes("Atlas") ?? false);
  expect(container.querySelector(".brain-webmcp-status")).not.toBeNull();
  await clickTab("Atlas");
  await waitFor(() => container.textContent?.includes("index.ts") ?? false);
  expect(container.textContent).toContain("Atlas Project");
  expect(container.textContent).toContain("src");
  expect(container.textContent).toContain("index.ts");
  expect(container.querySelector('[data-brain-node-type="file"]')).not.toBeNull();
});

test("Universe tab loads multi-project graph summary", async () => {
  await mount();
  await waitFor(() => container.textContent?.includes("Universe") ?? false);
  await clickTab("Universe");
  await waitFor(() => container.textContent?.includes("Pao Brain Universe") ?? false);
  expect(container.textContent).toContain("Atlas Project");
  expect(container.querySelector('[data-brain-node-type="universe"]')).not.toBeNull();
});

test("Tool Inspector and Agent Activity surfaces render from the shared catalog and audit trail", async () => {
  await mount();
  await waitFor(() => container.textContent?.includes("WebMCP") ?? false);
  await clickTab("Tools");
  await waitFor(() => container.textContent?.includes("get_workspace_status") ?? false);
  expect(container.textContent).toContain("create_stock_project");
  await clickTab("Activity");
  await waitFor(() => container.textContent?.includes("get_workspace_status") ?? false);
  expect(container.textContent).toContain("start_render_job");
});
