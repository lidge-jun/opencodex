import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLinkRoutes, type LinkRouteState } from "../../src/server/management/link-routes";
import type { ManagementContext } from "../../src/server/management/context";
import { readOperationsJournal, writeOperationsJournal, type LinkOperation } from "../../src/link/operations-journal";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/** O1: the operation journal is readable and residual or unknown entries are resolvable through the management API. */
const NOW = 1_800_000_000_000;
let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ocx-op-routes-")); });
afterEach(() => { if (root) removeTreeWithRetry(root); });

function entry(operationId: string, state: LinkOperation["state"]): LinkOperation {
  const at = new Date(NOW - 1000).toISOString();
  return { operationId, kind: "enroll", alias: "pen-" + operationId, digest: "a".repeat(64), createdAt: at, updatedAt: at, state,
    reserved: { linkId: "lnk_00000000000000aa", apiKeyId: "k-1", tunnelPort: 2200 }, effects: [], ...(state === "open" ? {} : { finishedAt: at }) };
}

function harness(principal: "admin-token" | "gui-session" = "admin-token", reloads: string[] = []) {
  const journalPath = join(root, "operations.json");
  writeOperationsJournal(journalPath, { version: 1, operations: [entry("op-residual", "residual"), entry("op-done", "committed")] });
  const config = { port: 10100, hostname: "127.0.0.1", runtimeRole: "standalone", providers: {}, apiKeys: [] } as unknown as OcxConfig;
  const state = { pendingHosts: new Map() } as unknown as LinkRouteState;
  async function call(method: string, path: string) {
    const url = new URL("http://127.0.0.1:10100" + path);
    const linkSupervisor = () => ({ reload: async () => { reloads.push(path); } });
    const ctx = { req: new Request(url, { method }), url, config, deps: { now: () => NOW, linkOperationsPath: () => journalPath, linkSupervisor }, version: "2.99.0",
      principal, trustedLoopbackIngress: true, guiSessionIssuance: null, sessionControl: { isCurrent: () => false, isPaired: () => false, revokeCurrent: () => false } } as unknown as ManagementContext;
    const response = await handleLinkRoutes(ctx, state);
    return { status: response!.status, body: await response!.json() as Record<string, unknown> };
  }
  return { call, journalPath, journal: () => readOperationsJournal(journalPath) };
}

const code = (answer: { body: Record<string, unknown> }) => (answer.body.error as { code?: string } | undefined)?.code;

test("the journal lists and reads operations", async () => {
  const h = harness();
  const list = await h.call("GET", "/api/link/operations");
  expect(list.status).toBe(200);
  expect((list.body.operations as LinkOperation[]).map(op => op.operationId)).toEqual(["op-residual", "op-done"]);
  expect((await h.call("GET", "/api/link/operations/op-done")).body).toMatchObject({ operationId: "op-done", state: "committed" });
  const missing = await h.call("GET", "/api/link/operations/nope");
  expect({ status: missing.status, code: code(missing) }).toEqual({ status: 404, code: "operation_not_found" });
  const bad = await h.call("GET", "/api/link/operations/-bad");
  expect({ status: bad.status, code: code(bad) }).toEqual({ status: 400, code: "invalid_operation_id" });
});

test("resolving a residual entry starts its retention once; a committed one is not resolvable", async () => {
  const h = harness();
  const resolved = await h.call("POST", "/api/link/operations/op-residual/resolve");
  expect(resolved).toMatchObject({ status: 200, body: { operationId: "op-residual", state: "residual", resolvedAt: new Date(NOW).toISOString() } });
  expect((await h.call("POST", "/api/link/operations/op-residual/resolve")).body.resolvedAt).toBe(new Date(NOW).toISOString());
  const refused = await h.call("POST", "/api/link/operations/op-done/resolve");
  expect({ status: refused.status, code: code(refused) }).toEqual({ status: 409, code: "operation_not_resolvable" });
  expect(h.journal().operations.find(op => op.operationId === "op-done")!.resolvedAt).toBeUndefined();
});

test("resolving an unknown id on a Home that never journalled answers 404 and creates no journal", async () => {
  const journalPath = join(root, "never.json");
  const config = { port: 10100, hostname: "127.0.0.1", runtimeRole: "standalone", providers: {}, apiKeys: [] } as unknown as OcxConfig;
  const url = new URL("http://127.0.0.1:10100/api/link/operations/typo-id/resolve");
  const ctx = { req: new Request(url, { method: "POST" }), url, config, deps: { now: () => NOW, linkOperationsPath: () => journalPath }, version: "2.99.0",
    principal: "admin-token", trustedLoopbackIngress: true, guiSessionIssuance: null, sessionControl: { isCurrent: () => false, isPaired: () => false, revokeCurrent: () => false } } as unknown as ManagementContext;
  const response = await handleLinkRoutes(ctx, { pendingHosts: new Map() } as unknown as LinkRouteState);
  expect(response!.status).toBe(404);
  // Its existence alone would put every plain apply and revoke on the lock path (journalInUse).
  expect(existsSync(journalPath)).toBe(false);
});

test("a resolve that changes nothing does not rewrite the journal", async () => {
  const h = harness();
  const path = join(root, "operations.json");
  const before = readFileSync(path, "utf8");
  // Every write replaces the file atomically (a new inode); an unchanged inode means nothing was written.
  const inode = statSync(path).ino;
  // Checked after each call: two replacements in a row can hand the first inode number back.
  expect((await h.call("POST", "/api/link/operations/op-done/resolve")).status).toBe(409);
  expect(statSync(path).ino).toBe(inode);
  expect((await h.call("POST", "/api/link/operations/nope/resolve")).status).toBe(404);
  expect(statSync(path).ino).toBe(inode);
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("a session without link authority is refused", async () => {
  const h = harness("gui-session");
  expect((await h.call("GET", "/api/link/operations")).status).toBe(403);
  expect((await h.call("POST", "/api/link/operations/op-residual/resolve")).status).toBe(403);
});

test("resolving a revoke reloads the tunnels, so a link its unknown cleanup suspended reconnects; resolving an enrollment does not", async () => {
  const reloads: string[] = [];
  const h = harness("admin-token", reloads);
  const at = new Date(NOW - 1000).toISOString();
  const revoke: LinkOperation = { operationId: "op-revoke", kind: "revoke", alias: "pen-r", linkId: "lnk_00000000000000bb", digest: "b".repeat(64), createdAt: at, updatedAt: at,
    state: "unknown", finishedAt: at, effects: [{ effect: "remote_cleanup", phase: "intent", at }] };
  writeOperationsJournal(h.journalPath, { version: 1, operations: [entry("op-residual", "residual"), revoke] });
  expect((await h.call("POST", "/api/link/operations/op-residual/resolve")).status).toBe(200);
  expect(reloads).toEqual([]);
  expect((await h.call("POST", "/api/link/operations/op-revoke/resolve")).status).toBe(200);
  expect(reloads).toEqual(["/api/link/operations/op-revoke/resolve"]);
});
