import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCatalogNativeSlugs, type CatalogModel } from "../../src/codex/catalog";
import { handleManagementAPI } from "../../src/server/management-api";
import type { RoleSizingCall } from "../../src/server/management/codex-role-auto-assign";
import type { OcxConfig } from "../../src/types";
import { ManagementRequest as Request } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const EXPLORER = 'name = "explorer"\ndescription = "Read-only search."\nmodel = "stub/big"\nmodel_reasoning_effort = "high"\n';
const WORKER = 'name = "worker"\ndeveloper_instructions = """\nChange code across modules.\n"""\n';
const BARE = 'name = "bare"\n';
const saved = { CODEX_HOME: process.env.CODEX_HOME, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
let root = "";
let calls: RoleSizingCall[] = [];
let answer: { text: string; error?: string } = { text: "" };

function sized(tier: string, effort: string) {
  return { tier, effort, rationale: "why", move_up_if: "up", move_down_if: "down" };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-role-auto-assign-"));
  mkdirSync(join(root, "codex", "agents"), { recursive: true });
  writeFileSync(join(root, "codex", "agents", "explorer.toml"), EXPLORER);
  writeFileSync(join(root, "codex", "agents", "worker.toml"), WORKER);
  writeFileSync(join(root, "codex", "agents", "bare.toml"), BARE);
  writeFileSync(join(root, "codex", "config.toml"), 'model = "stub/sizer"\n');
  process.env.CODEX_HOME = join(root, "codex");
  process.env.HOME = join(root, "home");
  process.env.USERPROFILE = join(root, "home");
  calls = [];
  answer = { text: JSON.stringify({ roles: { explorer: sized("fast", "glance"), worker: sized("frontier", "exhaustive") } }) };
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  removeTreeWithRetry(root);
});

const routed = (id: string, efforts: string[]): CatalogModel => ({ id, provider: "stub", reasoningEfforts: efforts, defaultReasoningEffort: "medium" });

const config = {
  port: 10100,
  providers: {},
  defaultProvider: "openai",
  disabledModels: listCatalogNativeSlugs(),
  codexRoleTiers: { fast: ["stub/small"], frontier: ["stub/big"] },
} as unknown as OcxConfig;

const deps = {
  fetchAllModels: async () => [routed("small", ["low", "medium", "high"]), routed("big", ["low", "medium", "high", "xhigh"])],
  completeCodexRoleSizing: async (call: RoleSizingCall) => {
    calls.push(call);
    return answer;
  },
};

async function call(path: string, init?: RequestInit) {
  const response = await handleManagementAPI(new Request(`http://localhost${path}`, init), new URL(`http://localhost${path}`), config, deps);
  expect(response).not.toBeNull();
  return { status: response!.status, body: await response!.json() as Record<string, any> };
}

function snapshot(): Record<string, string> {
  const dir = join(root, "codex", "agents");
  return Object.fromEntries(readdirSync(dir).map(name => [name, readFileSync(join(dir, name), "utf8")]));
}

describe("POST /api/codex-agent-roles/auto-assign", () => {
  test("proposes a model and effort per role through one sizing call and writes nothing", async () => {
    const before = snapshot();
    const result = await call("/api/codex-agent-roles/auto-assign", { method: "POST", body: "{}" });
    expect(result.status).toBe(200);
    expect(snapshot()).toEqual(before);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe("stub/sizer");
    expect(calls[0]!.user).toContain("Read-only search.");
    expect(calls[0]!.user).not.toContain('"bare"');
    expect(result.body.sizingModel).toBe("stub/sizer");
    const byRole = Object.fromEntries((result.body.proposals as any[]).map(p => [p.role, p]));
    expect(byRole.explorer).toMatchObject({ status: "proposed", model: "stub/big", effort: "high", proposedModel: "stub/small", proposedEffort: "low", tier: "fast" });
    expect(byRole.worker).toMatchObject({ status: "proposed", proposedModel: "stub/big", proposedEffort: null, tier: "frontier" });
    expect(byRole.bare.status).toBe("unsized");
  });

  test("an unusable sizing answer or a failed call leaves roles unsized", async () => {
    answer = { text: "explorer should be fast" };
    let result = await call("/api/codex-agent-roles/auto-assign", { method: "POST", body: JSON.stringify({ model: "stub/other" }) });
    expect(calls[0]!.model).toBe("stub/other");
    expect((result.body.proposals as any[]).every(p => p.status === "unsized")).toBe(true);
    answer = { text: "", error: "role sizing HTTP 502: boom" };
    result = await call("/api/codex-agent-roles/auto-assign", { method: "POST", body: "{}" });
    expect(result.body.sizingError).toBe("role sizing HTTP 502: boom");
    expect((result.body.proposals as any[]).find(p => p.role === "worker").reason).toContain("the sizing call failed");
  });

  test("refuses without a sizing model and never calls one", async () => {
    writeFileSync(join(root, "codex", "config.toml"), "");
    const result = await call("/api/codex-agent-roles/auto-assign", { method: "POST", body: "{}" });
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("no_sizing_model");
    expect(calls).toHaveLength(0);
  });
});

describe("PUT /api/codex-agent-roles/{role} with an effort", () => {
  test("writes model and effort together and rejects an unknown effort", async () => {
    const put = (body: unknown) => call("/api/codex-agent-roles/explorer", { method: "PUT", body: JSON.stringify(body) });
    expect((await put({ model: "stub/small", effort: "turbo" })).status).toBe(400);
    expect(snapshot()["explorer.toml"]).toBe(EXPLORER);
    const result = await put({ model: "stub/small", effort: "low" });
    expect(result.body).toMatchObject({ ok: true, model: "stub/small", effort: "low" });
    expect(snapshot()["explorer.toml"]).toBe(EXPLORER.replace("stub/big", "stub/small").replace('"high"', '"low"'));
  });
});
