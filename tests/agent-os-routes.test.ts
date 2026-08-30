import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleManagementAPI } from "../src/server/management-api";
import { closeAgentOsDbForTests } from "../src/agent-os/db";
import { registerAgent } from "../src/agent-os/registry";
import { enqueueTask } from "../src/agent-os/tasks";
import { writeMemory } from "../src/agent-os/memory";
import { recordReview } from "../src/agent-os/reviews";
import type { OcxConfig } from "../src/types";

const tempHomes: string[] = [];

function openFreshDb(): void {
  const dir = mkdtempSync(join(tmpdir(), "agent-os-routes-"));
  tempHomes.push(dir);
  closeAgentOsDbForTests();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../src/agent-os/db").openAgentOsDb(dir);
}

afterEach(() => {
  closeAgentOsDbForTests();
  while (tempHomes.length) rmSync(tempHomes.pop()!, { recursive: true, force: true });
});

function baseConfig(): OcxConfig {
  return {
    port: 10100,
    hostname: "127.0.0.1",
    defaultProvider: "a",
    providers: [],
  } as unknown as OcxConfig;
}

async function api(path: string): Promise<Response> {
  const url = new URL(`http://127.0.0.1:10100${path}`);
  const response = await handleManagementAPI(
    new Request(url, { headers: { Host: url.host } }),
    url,
    baseConfig(),
    { saveConfigPreservingClaudeCode: () => {} },
  );
  expect(response).not.toBeNull();
  return response!;
}

describe("agent-os observatory routes (read-only)", () => {
  test("GET /api/agent-os/agents returns registered agents", async () => {
    openFreshDb();
    registerAgent({ id: "agent_codex", name: "Codex", provider: "openai" });
    const res = await api("/api/agent-os/agents");
    const body = await res.json() as { agents: { id: string }[] };
    expect(body.agents.map((a) => a.id)).toContain("agent_codex");
  });

  test("GET /api/agent-os/tasks lists queued tasks", async () => {
    openFreshDb();
    const task = enqueueTask({ kind: "scan", title: "Scan repo" });
    const res = await api("/api/agent-os/tasks");
    const body = await res.json() as { tasks: { id: string }[] };
    expect(body.tasks.map((t) => t.id)).toContain(task.id);
  });

  test("memory routes read scoped records", async () => {
    openFreshDb();
    const mem = writeMemory({ scope: "decision", subjectId: "proj_x", title: "Keep approvals", content: "Deploy needs a human yes." });
    const byScope = await api("/api/agent-os/memory?scope=decision");
    const list = await byScope.json() as { memories: { id: string }[] };
    expect(list.memories.map((m) => m.id)).toContain(mem.id);
    const single = await api(`/api/agent-os/memory?id=${mem.id}`);
    const one = await single.json() as { title: string };
    expect(one.title).toBe("Keep approvals");
  });

  test("reviews route aggregates the council deterministically", async () => {
    openFreshDb();
    recordReview({ subjectKind: "task", subjectId: "t9", reviewer: "code", verdict: "pass", score: 90 });
    recordReview({ subjectKind: "task", subjectId: "t9", reviewer: "security", verdict: "warn", score: 60 });
    const res = await api("/api/agent-os/reviews?subjectKind=task&subjectId=t9");
    const body = await res.json() as { final: string };
    expect(body.final).toBe("needs_review");
  });

  test("ask route answers from local data with sources", async () => {
    openFreshDb();
    writeMemory({ scope: "global", title: "Pao rule", content: "fail closed" });
    const res = await api("/api/agent-os/ask?q=memory%20decision");
    const body = await res.json() as { intent: string; sources: string[] };
    expect(body.intent).toBe("memory");
    expect(body.sources.length).toBeGreaterThan(0);
  });

  test("write methods are rejected — observatory is read-only", async () => {
    openFreshDb();
    const url = new URL("http://127.0.0.1:10100/api/agent-os/agents");
    const response = await handleManagementAPI(
      new Request(url, { method: "POST", body: "{}", headers: { Host: url.host } }),
      url,
      baseConfig(),
      { saveConfigPreservingClaudeCode: () => {} },
    );
    expect(response?.status).toBe(405);
  });
});

describe("agent-os permit gateway routes (human-gated)", () => {
  test("request creates a pending approval; issue refuses before a human grants", async () => {
    openFreshDb();
    const url = new URL("http://127.0.0.1:10100/api/agent-os/permits/request");
    const requested = await handleManagementAPI(
      new Request(url, {
        method: "POST",
        body: JSON.stringify({ capability: "fs.write", scope: { kind: "file", path: "src/x.ts" }, reason: "fix" }),
        headers: { Host: url.host },
      }),
      url,
      baseConfig(),
      { saveConfigPreservingClaudeCode: () => {} },
    );
    expect(requested?.status).toBe(202);
    const { approvalId } = await requested!.json() as { approvalId: string };

    const issueUrl = new URL("http://127.0.0.1:10100/api/agent-os/permits/issue");
    const refused = await handleManagementAPI(
      new Request(issueUrl, {
        method: "POST",
        body: JSON.stringify({ approvalId, scope: { kind: "file", path: "src/x.ts" } }),
        headers: { Host: issueUrl.host },
      }),
      issueUrl,
      baseConfig(),
      { saveConfigPreservingClaudeCode: () => {} },
    );
    expect(refused?.status).toBe(409);
  });

  test("pending approvals are visible on the observatory route", async () => {
    openFreshDb();
    const url = new URL("http://127.0.0.1:10100/api/agent-os/permits/request");
    await handleManagementAPI(
      new Request(url, {
        method: "POST",
        body: JSON.stringify({ capability: "fs.write", scope: { kind: "file", path: "a.txt" }, reason: "demo" }),
        headers: { Host: url.host },
      }),
      url,
      baseConfig(),
      { saveConfigPreservingClaudeCode: () => {} },
    );
    const list = await api("/api/agent-os/permits/pending");
    const body = await list.json() as { approvals: { status: string }[] };
    expect(body.approvals.length).toBe(1);
    expect(body.approvals[0].status).toBe("pending");
  });
});

describe("agent-os policy management routes (admin-owned)", () => {
  test("GET empty, POST creates, policy takes effect, DELETE removes", async () => {
    openFreshDb();
    const empty = await api("/api/agent-os/policies");
    expect(((await empty.json()) as { policies: unknown[] }).policies).toEqual([]);
    const url = new URL("http://127.0.0.1:10100/api/agent-os/policies");
    const created = await handleManagementAPI(
      new Request(url, {
        method: "POST",
        body: JSON.stringify({ subjectType: "agent", subjectId: "agent_pol", capability: "fs.read", effect: "allow" }),
        headers: { Host: url.host },
      }),
      url,
      baseConfig(),
      { saveConfigPreservingClaudeCode: () => {} },
    );
    expect(created?.status).toBe(201);
    const { evaluateCapability } = await import("../src/agent-os/policy");
    expect(evaluateCapability("agent", "agent_pol", "fs.read").allowed).toBe(true);
    const list = await api("/api/agent-os/policies");
    const { policies } = await list.json() as { policies: { id: string }[] };
    expect(policies).toHaveLength(1);
    const delUrl = new URL("http://127.0.0.1:10100/api/agent-os/policies/" + policies[0].id);
    const removed = await handleManagementAPI(
      new Request(delUrl, { method: "DELETE", headers: { Host: delUrl.host } }),
      delUrl,
      baseConfig(),
      { saveConfigPreservingClaudeCode: () => {} },
    );
    expect(removed?.status).toBe(200);
    expect(evaluateCapability("agent", "agent_pol", "fs.read").allowed).toBe(false);
  });
});

describe("agent-os project registry + scanner routes", () => {
  test("register project, scan it read-only, list sessions", async () => {
    openFreshDb();
    const projectRoot = mkdtempSync(join(tmpdir(), "agent-os-route-proj-"));
    tempHomes.push(projectRoot);
    writeFileSync(join(projectRoot, "README.md"), "# proj");
    writeFileSync(join(projectRoot, ".env"), "SECRET=1");

    const url = new URL("http://127.0.0.1:10100/api/agent-os/projects");
    const created = await handleManagementAPI(
      new Request(url, {
        method: "POST",
        body: JSON.stringify({ name: "RouteProj", rootPath: projectRoot, scanMode: "quick" }),
        headers: { Host: url.host },
      }),
      url,
      baseConfig(),
      { saveConfigPreservingClaudeCode: () => {} },
    );
    expect(created?.status).toBe(201);
    const { project } = await created!.json() as { project: { id: string } };

    const list = await api("/api/agent-os/projects");
    const projects = await list.json() as { projects: { id: string }[] };
    expect(projects.projects.map((p) => p.id)).toContain(project.id);

    const scanUrl = new URL("http://127.0.0.1:10100/api/agent-os/projects/" + project.id + "/scan");
    const scan = await handleManagementAPI(
      new Request(scanUrl, { method: "POST", headers: { Host: scanUrl.host } }),
      scanUrl,
      baseConfig(),
      { saveConfigPreservingClaudeCode: () => {} },
    );
    expect(scan?.status).toBe(200);
    const coverage = await scan!.json() as { coverage: { filesScanned: number; filesSecretExcluded: number } };
    expect(coverage.coverage.filesScanned).toBeGreaterThan(0);
    expect(coverage.coverage.filesSecretExcluded).toBe(1);

    const sessions = await api("/api/agent-os/sessions?projectId=" + project.id);
    expect(((await sessions.json()) as { sessions: unknown[] }).sessions).toEqual([]);
  });

  test("atlas exposes persisted folder/file nodes and contains edges after a scan", async () => {
    openFreshDb();
    const projectRoot = mkdtempSync(join(tmpdir(), "agent-os-atlas-proj-"));
    tempHomes.push(projectRoot);
    mkdirSync(join(projectRoot, "src", "domain"), { recursive: true });
    writeFileSync(join(projectRoot, "README.md"), "# Atlas");
    writeFileSync(join(projectRoot, "src", "domain", "index.ts"), "export const atlas = true;");

    const createUrl = new URL("http://127.0.0.1:10100/api/agent-os/projects");
    const created = await handleManagementAPI(
      new Request(createUrl, {
        method: "POST",
        body: JSON.stringify({ name: "AtlasProj", rootPath: projectRoot, scanMode: "standard" }),
        headers: { Host: createUrl.host },
      }),
      createUrl,
      baseConfig(),
      { saveConfigPreservingClaudeCode: () => {} },
    );
    const { project } = await created!.json() as { project: { id: string } };
    const scanUrl = new URL("http://127.0.0.1:10100/api/agent-os/projects/" + project.id + "/scan");
    await handleManagementAPI(
      new Request(scanUrl, { method: "POST", headers: { Host: scanUrl.host } }),
      scanUrl,
      baseConfig(),
      { saveConfigPreservingClaudeCode: () => {} },
    );

    const atlas = await api("/api/agent-os/projects/" + project.id + "/atlas");
    expect(atlas.status).toBe(200);
    const body = await atlas.json() as {
      nodes: { id: string; type: string; label: string; path?: string }[];
      edges: { source: string; target: string; type: string }[];
      stats: { fileCount: number; folderCount: number };
    };
    expect(body.nodes.some((node) => node.type === "project" && node.label === "AtlasProj")).toBe(true);
    expect(body.nodes.some((node) => node.type === "folder" && node.path === "src/domain")).toBe(true);
    expect(body.nodes.some((node) => node.type === "file" && node.path === "src/domain/index.ts")).toBe(true);
    expect(body.edges.some((edge) => edge.type === "contains")).toBe(true);
    expect(body.stats.fileCount).toBe(2);
    expect(body.stats.folderCount).toBeGreaterThanOrEqual(2);
  });

  test("universe aggregates registered projects and their latest scan state", async () => {
    openFreshDb();
    const firstRoot = mkdtempSync(join(tmpdir(), "agent-os-universe-a-"));
    const secondRoot = mkdtempSync(join(tmpdir(), "agent-os-universe-b-"));
    tempHomes.push(firstRoot, secondRoot);
    writeFileSync(join(firstRoot, "a.ts"), "export {};");
    writeFileSync(join(secondRoot, "b.ts"), "export {};");

    for (const [name, rootPath] of [["Universe A", firstRoot], ["Universe B", secondRoot]]) {
      const createUrl = new URL("http://127.0.0.1:10100/api/agent-os/projects");
      const created = await handleManagementAPI(
        new Request(createUrl, {
          method: "POST",
          body: JSON.stringify({ name, rootPath, scanMode: "quick" }),
          headers: { Host: createUrl.host },
        }),
        createUrl,
        baseConfig(),
        { saveConfigPreservingClaudeCode: () => {} },
      );
      const { project } = await created!.json() as { project: { id: string } };
      const scanUrl = new URL("http://127.0.0.1:10100/api/agent-os/projects/" + project.id + "/scan");
      await handleManagementAPI(
        new Request(scanUrl, { method: "POST", headers: { Host: scanUrl.host } }),
        scanUrl,
        baseConfig(),
        { saveConfigPreservingClaudeCode: () => {} },
      );
    }

    const universe = await api("/api/agent-os/universe");
    expect(universe.status).toBe(200);
    const body = await universe.json() as {
      nodes: { type: string; label: string }[];
      edges: { type: string }[];
      projects: { name: string; latestScan: { filesScanned: number } | null }[];
    };
    expect(body.nodes.filter((node) => node.type === "project").map((node) => node.label).sort())
      .toEqual(["Universe A", "Universe B"]);
    expect(body.edges.filter((edge) => edge.type === "contains").length).toBeGreaterThanOrEqual(2);
    expect(body.projects.every((project) => project.latestScan?.filesScanned === 1)).toBe(true);
  });
});

describe("agent-os webmcp audit routes", () => {
  test("records a tool call audit event and lists it back", async () => {
    openFreshDb();
    const url = new URL("http://127.0.0.1:10100/api/agent-os/audit");
    const recorded = await handleManagementAPI(
      new Request(url, {
        method: "POST",
        body: JSON.stringify({
          tool: "get_workspace_status",
          actor: "agent",
          result: "success",
          durationMs: 12,
        }),
        headers: { Host: url.host },
      }),
      url,
      baseConfig(),
      { saveConfigPreservingClaudeCode: () => {} },
    );
    expect(recorded?.status).toBe(201);

    const rejected = await handleManagementAPI(
      new Request(url, {
        method: "POST",
        body: JSON.stringify({ tool: "", result: "success" }),
        headers: { Host: url.host },
      }),
      url,
      baseConfig(),
      { saveConfigPreservingClaudeCode: () => {} },
    );
    expect(rejected?.status).toBe(400);

    const list = await api("/api/agent-os/audit");
    const body = await list.json() as { events: { tool: string; actor: string; result: string }[] };
    expect(body.events).toHaveLength(1);
    expect(body.events[0].tool).toBe("get_workspace_status");
    expect(body.events[0].actor).toBe("agent");
    expect(body.events[0].result).toBe("success");
  });
});
