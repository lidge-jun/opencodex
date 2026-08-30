import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

import { buildToolCatalog, registerWebMcpTools } from "../src/webmcp/registry";

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
let testWindow: Window | null = null;

afterEach(() => {
  const descriptor = originalDocument;
  if (descriptor) Object.defineProperty(globalThis, "document", descriptor);
  testWindow = null;
});

function fakeFetch(routes: Record<string, unknown>) {
  return async (path: string) => ({
    ok: true,
    status: 200,
    json: async () => routes[path] ?? {},
  });
}

describe("webmcp tool registry", () => {
  test("catalog exposes the P0 tool set with correct risk tiers and annotations", () => {
    const catalog = buildToolCatalog({ apiBase: "" });
    const names = catalog.map((tool) => tool.name);
    expect(names).toContain("get_workspace_status");
    expect(names).toContain("create_stock_project");
    expect(names).toContain("generate_stock_ideas");
    expect(names).toContain("generate_video_prompt");
    expect(names).toContain("start_render_job");
    expect(names).toContain("get_render_status");
    expect(names).toContain("review_asset");
    expect(names).toContain("generate_stock_metadata");
    expect(names).toContain("prepare_stock_export");
    const status = catalog.find((tool) => tool.name === "get_workspace_status");
    expect(status?.readOnly).toBe(true);
    expect(status?.riskTier).toBe("R0");
    const render = catalog.find((tool) => tool.name === "start_render_job");
    expect(render?.riskTier).toBe("R3");
    expect(render?.readOnly).toBe(false);
  });

  test("get_workspace_status executes through the shared API surface", async () => {
    const catalog = buildToolCatalog({
      apiBase: "",
      fetchLike: fakeFetch({
        "/api/agent-os/projects": { projects: [{ id: "p1" }] },
        "/api/agent-os/tasks": { tasks: [{ id: "t1", status: "running" }] },
        "/api/agent-os/permits/pending": { approvals: [{ id: "a1" }] },
      }),
    });
    const tool = catalog.find((entry) => entry.name === "get_workspace_status")!;
    const result = await tool.execute({});
    expect(result).toEqual({ ok: true, workspace: "PaohupByPaoZa", projects: 1, runningTasks: 1, pendingApprovals: 1 });
  });

  test("invalid input is rejected before any side effect", async () => {
    const catalog = buildToolCatalog({ apiBase: "" });
    const create = catalog.find((entry) => entry.name === "create_stock_project")!;
    const result = await create.execute({ name: "../etc/passwd" });
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("invalid_input");
    expect((result as { errors: string[] }).errors.join(" ")).toContain("path traversal");
  });

  test("oversized and non-numeric inputs are rejected", async () => {
    const catalog = buildToolCatalog({ apiBase: "" });
    const ideas = catalog.find((entry) => entry.name === "generate_stock_ideas")!;
    const badCount = await ideas.execute({ topic: "factory", count: "many" });
    expect(badCount.ok).toBe(false);
    const oversizedTopic = "x".repeat(400);
    const badTopic = await ideas.execute({ topic: oversizedTopic });
    expect(badTopic.ok).toBe(false);
  });

  test("registration degrades gracefully when WebMCP is unavailable", async () => {
    const result = await registerWebMcpTools({ apiBase: "" });
    expect(result.availability).toBe("unavailable");
    expect(result.registered).toEqual([]);
  });

  test("registration registers tools when document.modelContext exists", async () => {
    testWindow = new Window({ url: "http://localhost/" });
    Object.defineProperties(globalThis, {
      document: { configurable: true, value: testWindow.document },
      window: { configurable: true, value: testWindow },
      navigator: { configurable: true, value: testWindow.navigator },
    });
    const registered: string[] = [];
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool: (tool: { name: string }) => { registered.push(tool.name); },
      },
    });
    const result = await registerWebMcpTools({
      apiBase: "",
      fetchLike: fakeFetch({
        "/api/agent-os/projects": { projects: [{ id: "p1" }] },
        "/api/agent-os/tasks": { tasks: [] },
        "/api/agent-os/permits/pending": { approvals: [] },
      }),
    });
    expect(result.availability).toBe("ready");
    expect(result.registered).toContain("get_workspace_status");
    expect(registered).toContain("get_workspace_status");
  });
});
