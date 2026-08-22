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
  isRoutedRoleModel,
  parseSubagentRole,
  parseSubagentRoles,
  renderRolesCatalog,
  salvageSubagentRoles,
  compactRolesCatalog,
  SUBAGENT_ROLE_MODEL_MAX,
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

  test("rejects a model id longer than the bound", () => {
    const parsed = parseSubagentRole({
      id: "reviewer",
      description: "PR review",
      model: `p/${"m".repeat(SUBAGENT_ROLE_MODEL_MAX)}`,
      developerInstructions: "Review.",
    });
    expect(parsed).toMatchObject({ ok: false, error: expect.stringContaining("model") });
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

  test("deduplicates existing roster entries before filling the five-slot window", () => {
    const result = unionRoleModelsIntoRoster(
      ["a", "a", "b", "c", "d"],
      [role({ id: "r", model: "role-model" })],
    );
    expect(result.models).toEqual(["role-model", "a", "b", "c", "d"]);
  });
});

describe("isRoutedRoleModel", () => {
  test("treats openrouter/gpt-* as routed even though the model id starts with gpt-", () => {
    expect(isRoutedRoleModel("openrouter/gpt-5.4", { work: "acct-1" })).toBe(true);
  });

  test("treats a configured account-qualified gpt-* row as native", () => {
    expect(isRoutedRoleModel("work/gpt-5.4", { work: "acct-1" })).toBe(false);
  });

  test("treats a bare native gpt-* id as not routed", () => {
    expect(isRoutedRoleModel("gpt-5.4", { work: "acct-1" })).toBe(false);
  });
});

describe("compactRolesCatalog", () => {
  test("fits eight max-length role models into a 700-character budget", () => {
    const longModel = `p/${"m".repeat(SUBAGENT_ROLE_MODEL_MAX - 2)}`;
    const roles = Array.from({ length: 8 }, (_, i) => role({
      id: `role-${i}`,
      model: longModel,
      description: "x".repeat(240),
    }));
    const text = compactRolesCatalog(roles, 700);
    expect(text.length).toBeLessThanOrEqual(700);
    expect(text.length).toBeGreaterThan(0);
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

  test("remove PUTs an atomic remove id rather than a whole-catalog snapshot", async () => {
    const runtime = fakeRuntime();
    expect(await handleAgentCommand(["roles", "remove", "reviewer", "--json"], runtime.deps)).toBe(0);
    expect(runtime.requests).toEqual([{
      path: "/api/subagent-roles",
      method: "PUT",
      body: { remove: "reviewer" },
    }]);
  });
});
