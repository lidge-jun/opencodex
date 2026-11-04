import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAgentCommand } from "../../src/cli/agent";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import type { RoleModelChange } from "../../src/codex/role-model-history";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";
import { ManagementRequest } from "../helpers/management-auth";
import { STORE_BUDGET_MS } from "../helpers/test-budget";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const saved = { CODEX_HOME: process.env.CODEX_HOME, OPENCODEX_HOME: process.env.OPENCODEX_HOME,
  HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const config = { port: 10100, providers: {}, defaultProvider: "openai" } as OcxConfig;
let root: string;
let codexHome: string;
let mirrorPath: string;
let historyPath: string;

interface Proposal {
  role: string;
  model: string | null;
  effort: string | null;
  status: "proposed" | "unsized" | "unassigned";
  proposedModel: string | null;
  proposedEffort: string | null;
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-cli-role-history-")));
  codexHome = join(root, "codex");
  const userHome = join(root, "home");
  process.env.CODEX_HOME = codexHome;
  process.env.OPENCODEX_HOME = join(root, "ocx");
  process.env.HOME = process.env.USERPROFILE = userHome;
  mkdirSync(join(codexHome, "agents"), { recursive: true });
  mkdirSync(join(userHome, ".omo"), { recursive: true });
  const plugin = join(codexHome, "plugins", "cache", "sisyphuslabs", "omo", "5.1.1");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, "lazycodex-install.json"), "{}");
  writeFileSync(join(codexHome, "config.toml"), '[plugins."omo@sisyphuslabs"]\nenabled = true\n');
  mirrorPath = join(userHome, ".omo", "omo.jsonc");
  historyPath = join(root, "ocx", "integrations", "codex-agent-roles.jsonl");
});

afterEach(() => {
  for (const key of Object.keys(saved) as Array<keyof typeof saved>) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  removeTreeWithRetry(root);
});

const rolePath = (role: string) => join(codexHome, "agents", `${role}.toml`);
const roleText = (role: string) => readFileSync(rolePath(role), "utf8");
const original = '# Keep the role instructions.\nmodel = "a/before"\nmodel_reasoning_effort = "high"\n';

function seed(count: number): Proposal[] {
  const proposals = Array.from({ length: count }, (_, i): Proposal => ({
    role: `role-${i}`, model: "a/before", effort: "high", status: "proposed",
    proposedModel: "a/after", proposedEffort: "low",
  }));
  for (const proposal of proposals) writeFileSync(rolePath(proposal.role), original);
  writeFileSync(mirrorPath, JSON.stringify({ "[codex]": { agents: Object.fromEntries(
    proposals.map(p => [p.role, { model: "a/before", reasoning: "high" }]),
  ) } }));
  return proposals;
}

async function management(path: string, init?: RequestInit): Promise<Response> {
  const request = new ManagementRequest(`http://127.0.0.1:10100${path}`, init);
  const response = await handleManagementAPI(request, new URL(request.url), config);
  if (!response) throw new Error(`fixture route not handled: ${path}`);
  return response;
}

async function listedHistory(): Promise<RoleModelChange[]> {
  const response = await management("/api/codex-agent-roles");
  expect(response.status).toBe(200);
  return (await response.json() as { history: RoleModelChange[] }).history;
}

interface WriteCall { role: string; body: Record<string, unknown>; status?: number; result?: Record<string, unknown> }
function runtime(proposals: Proposal[], hooks: { before?: (role: string) => void; after?: (role: string) => void } = {}) {
  const writes: WriteCall[] = [];
  const deps: RuntimeApiDeps = {
    baseUrl: "http://127.0.0.1:10100",
    fetchImpl: (async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/codex-agent-roles/auto-assign") return Response.json({ sizingModel: "fixture", proposals });
      const role = decodeURIComponent(path.split("/").at(-1)!);
      const call: WriteCall = { role, body: JSON.parse(String(init?.body)) };
      writes.push(call);
      hooks.before?.(role);
      const response = await management(path, init);
      call.status = response.status;
      call.result = await response.clone().json() as Record<string, unknown>;
      hooks.after?.(role);
      return response;
    }) as typeof fetch,
  };
  return { deps, writes };
}

async function invoke(deps: RuntimeApiDeps, json = true, apply = true) {
  const out = spyOn(console, "log").mockImplementation(() => {});
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    const exit = await handleAgentCommand(["roles", "suggest", ...(apply ? ["--apply"] : []), ...(json ? ["--json"] : [])], deps);
    const stdout = out.mock.calls.flat().join("\n");
    return { exit, stdout, stderr: err.mock.calls.flat().join("\n"), receipt: json && stdout ? JSON.parse(stdout) : undefined };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

async function restoreBatch(changes: RoleModelChange[]): Promise<string> {
  let batch: string | undefined;
  for (const change of changes) {
    const response = await management(`/api/codex-agent-roles/${encodeURIComponent(change.role)}`, {
      method: "PUT",
      body: JSON.stringify({ model: change.before.model ?? undefined, effort: change.before.effort,
        restores: change.batch, ...(batch ? { batch } : {}) }),
    });
    expect(response.status).toBe(200);
    const written = await response.json() as { batch: string };
    if (batch) expect(written.batch).toBe(batch);
    batch = written.batch;
  }
  return batch!;
}

describe("CLI role suggestions preserve bounded whole-batch history", () => {
  test("50 real writes share one listed batch and every role restores after the source leaves the listing", async () => {
    const proposals = seed(50);
    const mirrorBefore = JSON.parse(readFileSync(mirrorPath, "utf8"));
    const transport = runtime(proposals);
    const { exit, receipt } = await invoke(transport.deps);
    expect(exit).toBe(0);
    expect(receipt.applied).toHaveLength(50);
    expect(receipt.applied[0]).toEqual({ role: "role-0", model: "a/after", effort: "low" });
    expect(transport.writes).toHaveLength(50);
    expect(transport.writes[0]!.body).not.toHaveProperty("batch");
    expect(new Set(transport.writes.slice(1).map(w => w.body.batch))).toEqual(new Set([receipt.batch]));
    const changes = await listedHistory();
    expect(changes).toHaveLength(50);
    expect(new Set(changes.map(c => c.batch))).toEqual(new Set([receipt.batch]));
    const stored = readFileSync(historyPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(stored.map(row => row.n)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(proposals.every(p => roleText(p.role).includes('model = "a/after"'))).toBe(true);
    const restored = await restoreBatch(changes);
    expect(proposals.map(p => roleText(p.role))).toEqual(Array(50).fill(original));
    expect(JSON.parse(readFileSync(mirrorPath, "utf8"))).toEqual(mirrorBefore);
    const latest = await listedHistory();
    expect(latest).toHaveLength(50);
    expect(new Set(latest.map(c => c.batch))).toEqual(new Set([restored]));
  }, { timeout: STORE_BUDGET_MS });

  test.each([false, true])("51 changed roles are refused before any PUT or file change (json=%s)", async json => {
    const proposals = seed(51);
    const mirrorBefore = readFileSync(mirrorPath, "utf8");
    const transport = runtime(proposals);
    const result = await invoke(transport.deps, json);
    expect(result.exit).toBe(5);
    expect(transport.writes).toEqual([]);
    expect(proposals.map(p => roleText(p.role))).toEqual(Array(51).fill(original));
    expect(readFileSync(mirrorPath, "utf8")).toBe(mirrorBefore);
    expect(existsSync(historyPath)).toBe(false);
    expect(result.stderr).toContain("51 changed proposals exceed the 50-role batch limit. No role files were written.");
    if (json) {
      expect(result.receipt).toMatchObject({ applied: [], complete: false,
        refusal: { code: "too_many_role_changes", limit: 50, count: 51 }, unattemptedRoles: proposals.map(p => p.role) });
    } else expect(result.stdout).toContain("Preview without --apply");
  });

  test("already-set, unsized and unassigned roles do not consume the 50-change budget", async () => {
    const proposals = seed(53);
    Object.assign(proposals[50]!, { proposedModel: "a/before", proposedEffort: "high" });
    Object.assign(proposals[51]!, { status: "unsized", proposedModel: null, proposedEffort: null });
    Object.assign(proposals[52]!, { status: "unassigned", proposedModel: null, proposedEffort: null });
    const transport = runtime(proposals);
    const { exit, receipt } = await invoke(transport.deps);
    expect(exit).toBe(0);
    expect(receipt.skipped).toEqual(["role-50"]);
    expect(receipt.applied).toHaveLength(50);
    expect(transport.writes).toHaveLength(50);
    expect(proposals.slice(50).map(p => roleText(p.role))).toEqual(Array(3).fill(original));
    expect(await listedHistory()).toHaveLength(50);
  }, { timeout: STORE_BUDGET_MS });

  test("preview remains available above the apply limit", async () => {
    const proposals = seed(51);
    const transport = runtime(proposals);
    const { exit, receipt } = await invoke(transport.deps, true, false);
    expect(exit).toBe(0);
    expect(receipt).toEqual({ sizingModel: "fixture", proposals });
    const preview = await invoke(transport.deps, false, false);
    expect(preview.exit).toBe(0);
    expect(preview.stdout).toContain("--apply accepts up to 50 changed roles in one batch");
    expect(transport.writes).toEqual([]);
    expect(existsSync(historyPath)).toBe(false);
  });

  test.each([false, true])("a real role refusal reports and preserves the restorable prefix (json=%s)", async json => {
    const proposals = seed(3);
    writeFileSync(mirrorPath, '{\n // keep this comment\n "[codex]": {"agents": {}}\n}\n');
    const transport = runtime(proposals, { before: role => { if (role === "role-1") unlinkSync(rolePath(role)); } });
    const result = await invoke(transport.deps, json);
    expect(result.exit).toBe(4);
    expect(transport.writes.map(w => w.status)).toEqual([200, 404]);
    expect(result.stderr).toBe(`Error: ${transport.writes[1]!.result!.error}`);
    expect(roleText("role-0")).toContain('model = "a/after"');
    expect(roleText("role-2")).toBe(original);
    const changes = await listedHistory();
    expect(changes).toHaveLength(1);
    if (json) {
      expect(result.receipt).toMatchObject({ complete: false, batch: changes[0]!.batch,
        applied: [{ role: "role-0", model: "a/after", effort: "low" }], unconfirmedRole: "role-1",
        unattemptedRoles: ["role-2"], omoJsoncNotWritten: [{ role: "role-0", status: "skipped_comments" }] });
    } else {
      expect(result.stdout).toContain("Confirmed writes: role-0.");
      expect(result.stdout).toContain("Write not confirmed for role-1; it may have been saved. Not attempted: role-2.");
      expect(result.stdout).toContain(`Recorded history batch: ${changes[0]!.batch}`);
      expect(result.stdout).toContain("role-0: omo.jsonc not written (skipped_comments)");
    }
    await restoreBatch(changes);
    expect(roleText("role-0")).toBe(original);
  });

  test.each([0, 1])("a response lost after real write %s is unconfirmed, never retried or rolled back", async lostIndex => {
    const proposals = seed(3);
    const lostRole = `role-${lostIndex}`;
    const transport = runtime(proposals, { after: role => { if (role === lostRole) throw new TypeError("fixture response lost"); } });
    const { exit, receipt, stderr } = await invoke(transport.deps);
    expect(exit).toBe(1);
    expect(stderr).toBe("Error: Management API is unreachable: fixture response lost");
    expect(transport.writes).toHaveLength(lostIndex + 1);
    expect(receipt.applied.map((p: { role: string }) => p.role)).toEqual(proposals.slice(0, lostIndex).map(p => p.role));
    expect(receipt.unconfirmedRole).toBe(lostRole);
    expect(receipt.unattemptedRoles).toEqual(proposals.slice(lostIndex + 1).map(p => p.role));
    expect(receipt.complete).toBe(false);
    expect(roleText(lostRole)).toContain('model = "a/after"');
    expect(proposals.slice(lostIndex + 1).map(p => roleText(p.role))).toEqual(Array(2 - lostIndex).fill(original));
    const changes = await listedHistory();
    expect(changes).toHaveLength(lostIndex + 1);
    expect(new Set(changes.map(c => c.batch)).size).toBe(1);
    if (lostIndex === 0) expect(receipt).not.toHaveProperty("batch");
    else expect(receipt.batch).toBe(changes[0]!.batch);
    // Reading the real history recovers even the unacknowledged write's server-issued batch.
    await restoreBatch(changes);
    expect(proposals.map(p => roleText(p.role))).toEqual(Array(3).fill(original));
  });
});
