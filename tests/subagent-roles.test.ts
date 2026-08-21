/**
 * Named subagent role catalog: validation, {{roles}} rendering, roster union, CLI.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { handleAgentCommand } from "../src/cli/agent";
import {
  parseSubagentRole,
  parseSubagentRoles,
  renderRolesCatalog,
  salvageSubagentRoles,
  unionRoleModelsIntoRoster,
} from "../src/codex/agent-roles";
import type { OcxSubagentRole } from "../src/types";

const role = (over: Partial<OcxSubagentRole> & Pick<OcxSubagentRole, "id">): OcxSubagentRole => ({
  description: "when to use this specialist",
  model: "gpt-5.6-luna",
  developerInstructions: "Do the specialist work.",
  enabled: true,
  ...over,
});

describe("parseSubagentRoles", () => {
  test("accepts a valid role and defaults enabled to true", () => {
    const parsed = parseSubagentRole({
      id: "reviewer",
      description: "PR review",
      model: "anthropic/claude-sonnet-5",
      effort: "high",
      developerInstructions: "Review the diff.",
    });
    expect(parsed).toEqual({
      ok: true,
      role: {
        id: "reviewer",
        description: "PR review",
        model: "anthropic/claude-sonnet-5",
        effort: "high",
        developerInstructions: "Review the diff.",
        enabled: true,
      },
    });
  });

  test("rejects an invalid id without accepting the rest of the catalog", () => {
    const parsed = parseSubagentRoles([
      role({ id: "reviewer" }),
      { id: "Reviewer", description: "x", model: "gpt-5.6-luna", developerInstructions: "y" },
    ]);
    expect(parsed).toMatchObject({ ok: false, index: 1, error: expect.stringContaining("id") });
  });

  test("rejects a ninth role", () => {
    const roles = Array.from({ length: 9 }, (_, i) => role({ id: `role-${i}` }));
    expect(parseSubagentRoles(roles)).toMatchObject({
      ok: false,
      error: expect.stringContaining("8"),
    });
  });
});

describe("salvageSubagentRoles", () => {
  test("drops malformed entries and keeps valid neighbors", () => {
    const salvaged = salvageSubagentRoles([
      role({ id: "reviewer", model: "anthropic/claude-sonnet-5" }),
      { id: "NOPE", description: "x", model: "gpt-5.6-luna", developerInstructions: "y" },
    ]);
    expect(salvaged.roles).toEqual([expect.objectContaining({ id: "reviewer" })]);
    expect(salvaged.warnings.some(warning => warning.includes("subagentRoles"))).toBe(true);
  });

  test("preserves an explicit empty array", () => {
    expect(salvageSubagentRoles([])).toEqual({ roles: [], warnings: [] });
  });
});

describe("renderRolesCatalog", () => {
  test("renders id, model, optional effort, and when-to-use description", () => {
    const text = renderRolesCatalog([
      role({
        id: "reviewer",
        model: "anthropic/claude-sonnet-5",
        effort: "high",
        description: "PR review",
      }),
      role({ id: "explorer", model: "gpt-5.6-luna", description: "read-only search" }),
    ]);
    expect(text).toContain("reviewer (anthropic/claude-sonnet-5, high) for PR review");
    expect(text).toContain("explorer (gpt-5.6-luna) for read-only search");
    expect(text).not.toContain("Do the specialist work");
  });

  test("omits disabled roles", () => {
    const text = renderRolesCatalog([
      role({ id: "reviewer", enabled: false, description: "PR review" }),
      role({ id: "explorer", description: "read-only search" }),
    ]);
    expect(text).not.toContain("reviewer");
    expect(text).toContain("explorer");
  });
});

describe("unionRoleModelsIntoRoster", () => {
  test("puts enabled role models first and truncates to 5 with dropped role ids", () => {
    const existing = ["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4-mini"];
    const roles = [
      role({ id: "reviewer", model: "anthropic/claude-sonnet-5" }),
      role({ id: "explorer", model: "gpt-5.6-luna" }),
      role({ id: "writer", model: "kimi/k3", enabled: false }),
    ];
    const result = unionRoleModelsIntoRoster(existing, roles);
    expect(result.models).toEqual([
      "anthropic/claude-sonnet-5",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
    ]);
    expect(result.droppedRoleIds).toEqual([]);
  });

  test("warns with dropped role ids when more than 5 unique enabled models", () => {
    const roles = [
      role({ id: "a", model: "m-1" }),
      role({ id: "b", model: "m-2" }),
      role({ id: "c", model: "m-3" }),
      role({ id: "d", model: "m-4" }),
      role({ id: "e", model: "m-5" }),
      role({ id: "f", model: "m-6" }),
    ];
    const result = unionRoleModelsIntoRoster([], roles);
    expect(result.models).toEqual(["m-1", "m-2", "m-3", "m-4", "m-5"]);
    expect(result.droppedRoleIds).toEqual(["f"]);
  });
});

describe("ocx agent roles CLI", () => {
  const servers: Array<ReturnType<typeof Bun.serve>> = [];

  afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true);
    process.exitCode = 0;
  });

  function fakeRuntime(responder?: (req: Request, body: unknown) => unknown) {
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = req.method === "GET" ? null : await req.json().catch(() => null);
        requests.push({ path: url.pathname, method: req.method, body });
        const custom = responder?.(req, body);
        if (custom !== undefined) return Response.json(custom);
        return Response.json({ ok: true, roles: [] });
      },
    });
    servers.push(server);
    return { requests, deps: { baseUrl: `http://127.0.0.1:${server.port}` } };
  }

  test("status JSON round-trips the catalog from GET /api/subagent-roles", async () => {
    const catalog = {
      roles: [role({ id: "reviewer", model: "anthropic/claude-sonnet-5", effort: "high", description: "PR review" })],
    };
    const runtime = fakeRuntime((req) => {
      if (new URL(req.url).pathname === "/api/subagent-roles") return catalog;
      return undefined;
    });
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    expect(await handleAgentCommand(["roles", "status", "--json"], runtime.deps)).toBe(0);
    logSpy.mockRestore();
    expect(runtime.requests).toEqual([{ path: "/api/subagent-roles", method: "GET", body: null }]);
    expect(JSON.parse(logs.join("\n"))).toMatchObject(catalog);
  });

  test("set --file PUTs the JSON catalog without stuffing the prompt into argv", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-roles-cli-"));
    try {
      const file = join(dir, "roles.json");
      const payload = {
        roles: [role({
          id: "reviewer",
          model: "anthropic/claude-sonnet-5",
          developerInstructions: "Review the diff for regressions.",
        })],
      };
      writeFileSync(file, JSON.stringify(payload));
      const runtime = fakeRuntime();
      expect(await handleAgentCommand(["roles", "set", "--file", file, "--json"], runtime.deps)).toBe(0);
      expect(runtime.requests).toEqual([{
        path: "/api/subagent-roles",
        method: "PUT",
        body: payload,
      }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("set reads a full JSON document from stdin", async () => {
    const payload = { roles: [role({ id: "explorer", description: "search" })] };
    const runtime = fakeRuntime();
    const stdinImpl = Readable.from([JSON.stringify(payload)]) as NodeJS.ReadableStream & { isTTY?: boolean };
    stdinImpl.isTTY = false;
    expect(await handleAgentCommand(["roles", "set", "--json"], { ...runtime.deps, stdinImpl })).toBe(0);
    expect(runtime.requests).toEqual([{
      path: "/api/subagent-roles",
      method: "PUT",
      body: payload,
    }]);
  });

  test("remove PUTs the catalog without the named id", async () => {
    const existing = [
      role({ id: "reviewer" }),
      role({ id: "explorer" }),
    ];
    const runtime = fakeRuntime((req, body) => {
      if (new URL(req.url).pathname === "/api/subagent-roles" && req.method === "GET") {
        return { roles: existing };
      }
      return { ok: true, roles: (body as { roles?: unknown }).roles ?? [] };
    });
    expect(await handleAgentCommand(["roles", "remove", "reviewer", "--json"], runtime.deps)).toBe(0);
    expect(runtime.requests[0]).toEqual({ path: "/api/subagent-roles", method: "GET", body: null });
    expect(runtime.requests[1]).toEqual({
      path: "/api/subagent-roles",
      method: "PUT",
      body: { roles: [role({ id: "explorer" })] },
    });
  });
});
