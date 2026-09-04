import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExportModel } from "../../src/clients/config-export";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../src/integrations/store";
import { handleManagementAPI } from "../../src/server/management-api";
import {
  setIntegrationMutationFlightTestHooks,
  setIntegrationPathTestHooks,
} from "../../src/server/management/integration-routes";
import type { OcxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * DELETE /api/client-integrations/journal -- the branches of
 * devlog/_plan/260904_priority65_closeout/060 §7 (1-6).
 *
 * Every row here is produced by the REAL writer against a real temp HOME and a
 * real temp store, matching management-integration-routes.test.ts. A fixture
 * that hand-wrote journal lines would let the newest-row rule pass against a
 * shape the writer never actually produces.
 */
let base = "";
let home = "";
let storeRoot = "";
let store: IntegrationStateStore;

const routeEnv = {} as NodeJS.ProcessEnv;

/** Shaped like a real key, assembled at runtime so no literal secret is committed. */
const REAL_LOOKING_KEY = ["ocx", "live", "9f3c7a2b41d84e6fa05c8e17b3d92764"].join("_");

const MODELS_FIXTURE: ExportModel[] = [
  { namespaced: "a/m1", provider: "a", id: "m1", contextWindow: 128_000 },
];

function baseConfig(): OcxConfig {
  return {
    port: 10100,
    hostname: "127.0.0.1",
    defaultProvider: "a",
    apiKeys: [{ id: "key-1", name: "default", key: REAL_LOOKING_KEY, createdAt: new Date(0).toISOString() }],
    providers: {
      a: {
        adapter: "openai-chat",
        baseUrl: "https://a.example/v1",
        apiKey: REAL_LOOKING_KEY,
        liveModels: false,
        models: [MODELS_FIXTURE[0]!.id],
        modelContextWindows: { m1: 128_000 },
        modelReasoningEfforts: { m1: ["minimal", "low", "high"] },
      },
    },
  } as unknown as OcxConfig;
}

let config: OcxConfig;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ocx-journal-delete-"));
  home = join(base, "home");
  storeRoot = join(base, "store", "integrations");
  mkdirSync(home, { recursive: true });
  store = createIntegrationStateStore(storeRoot);
  config = baseConfig();
  setIntegrationMutationFlightTestHooks({ store });
  setIntegrationPathTestHooks({ env: routeEnv, home });
});

afterEach(() => {
  setIntegrationMutationFlightTestHooks(null);
  setIntegrationPathTestHooks(null);
  removeTreeWithRetry(base);
});

function installHermes(): string {
  const spec = INTEGRATION_CLIENTS.hermes;
  mkdirSync(spec.detectDir(routeEnv, home), { recursive: true });
  return spec.configPath(routeEnv, home);
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL("http://127.0.0.1:10100" + path);
  const response = await handleManagementAPI(
    new Request(url, { ...init, headers: { Host: url.host, ...(init.headers ?? {}) } }),
    url,
    config,
    { saveConfigPreservingClaudeCode: () => {}, createManagementConvergeCodex: catalogConvergenceFactory() },
  );
  expect(response).not.toBeNull();
  return response!;
}

function put(clientId: string, enabled: boolean): Promise<Response> {
  return api("/api/client-integrations/" + clientId, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

interface JournalRow {
  opId: string;
  clientId: string;
  kind: string;
  at: string;
  configPath: string;
  snapshot: "none" | "stored" | "expired";
  undoable: boolean;
  deletable: boolean;
}

async function journal(query = ""): Promise<JournalRow[]> {
  const response = await api("/api/client-integrations/journal" + query);
  expect(response.status).toBe(200);
  return (await response.json() as { operations: JournalRow[] }).operations;
}

function del(query: string): Promise<Response> {
  return api("/api/client-integrations/journal" + query, { method: "DELETE" });
}

function byId(opId: string): string {
  return "?opId=" + encodeURIComponent(opId);
}

/** Two hermes operations, returned oldest first. */
async function twoOperations(): Promise<[JournalRow, JournalRow]> {
  installHermes();
  expect((await put("hermes", true)).status).toBe(200);
  expect((await put("hermes", false)).status).toBe(200);
  const rows = await journal("?client=hermes");
  expect(rows).toHaveLength(2);
  return [rows[1]!, rows[0]!];
}

describe("the journal row carries a server-computed deletable flag", () => {
  test("the newest row per client is not deletable and older rows are", async () => {
    const [older, newest] = await twoOperations();
    expect(newest.deletable).toBe(false);
    expect(older.deletable).toBe(true);
  });

  test("the row shape gains exactly one field and no others", async () => {
    await twoOperations();
    const text = await (await api("/api/client-integrations/journal")).text();
    for (const row of JSON.parse(text).operations as Record<string, unknown>[]) {
      expect(Object.keys(row).sort()).toEqual([
        "at", "clientId", "configPath", "deletable", "kind", "opId", "snapshot", "undoable",
      ]);
    }
    // The snapshots on disk really do hold the serializable secret, so "no key
    // in the response" is a claim about the serializer, not an empty fixture.
    expect(text).not.toContain(REAL_LOOKING_KEY);
  });

  test("deletable is decided per client, not across the whole list", async () => {
    /*
     * The newest row overall belongs to ONE client. Computing the rule against
     * the whole list would strip every other client of its undo entry point.
     */
    mkdirSync(INTEGRATION_CLIENTS.hermes.detectDir(routeEnv, home), { recursive: true });
    mkdirSync(INTEGRATION_CLIENTS.dsh.detectDir(routeEnv, home), { recursive: true });
    expect((await put("dsh", true)).status).toBe(200);
    expect((await put("hermes", true)).status).toBe(200);

    const rows = await journal();
    const protectedClients = rows.filter(row => !row.deletable).map(row => row.clientId).sort();
    expect(protectedClients).toEqual(["dsh", "hermes"]);
  });
});

describe("DELETE /api/client-integrations/journal", () => {
  test("retires an older row and hides it from every read", async () => {
    const [older] = await twoOperations();

    const response = await del(byId(older.opId));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      opId: older.opId,
      clientId: "hermes",
      snapshotRemoved: true,
    });

    // Gone from the global route, the per-client filter, and the store.
    expect((await journal()).map(row => row.opId)).not.toContain(older.opId);
    expect((await journal("?client=hermes")).map(row => row.opId)).not.toContain(older.opId);
    expect(store.findOperation(older.opId)).toBeNull();
  });

  test("the log is appended to, never rewritten, and the record names a principal", async () => {
    const [older] = await twoOperations();
    const logPath = join(storeRoot, "journal.jsonl");
    const before = readFileSync(logPath, "utf8");

    expect((await del(byId(older.opId))).status).toBe(200);

    const after = readFileSync(logPath, "utf8");
    // Every prior byte survives in order, including the deleted row own line.
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain(JSON.stringify(older.opId));

    const tombstone = JSON.parse(after.trim().split("\n").at(-1)!) as Record<string, unknown>;
    expect(tombstone.tombstone).toBe(older.opId);
    expect(typeof tombstone.at).toBe("string");
    // A principal name, never a token, a session id, or a filesystem path.
    expect(tombstone.by).toBe("admin-token");
    expect(after).not.toContain(REAL_LOOKING_KEY);
    expect(String(tombstone.by)).not.toContain("/");
  });

  test("a missing or blank opId is a 400 with an exact envelope", async () => {
    await twoOperations();
    const response = await del("");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "opId must be a non-empty string",
      code: "invalid_op_id",
    });
    expect((await del("?opId=%20%20")).status).toBe(400);
  });

  test("an unknown opId is a 404, and a repeated delete is idempotent", async () => {
    const [older] = await twoOperations();

    const unknown = await del("?opId=op-does-not-exist");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: "integration operation not found",
      code: "integration_operation_not_found",
      opId: "op-does-not-exist",
    });

    expect((await del(byId(older.opId))).status).toBe(200);
    // The tombstone hides the row from findOperation, so a double-click lands
    // on the same 404 rather than deleting something else.
    expect((await del(byId(older.opId))).status).toBe(404);
    expect(store.listOperations("hermes")).toHaveLength(1);
  });

  test("the newest row is refused with 409 and nothing is written", async () => {
    const [, newest] = await twoOperations();
    const logPath = join(storeRoot, "journal.jsonl");
    const before = readFileSync(logPath, "utf8");

    const response = await del(byId(newest.opId));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "the newest operation for a client cannot be deleted",
      code: "integration_journal_newest_protected",
      clientId: "hermes",
      opId: newest.opId,
    });

    // The rule is enforced BEFORE the append: the refusal wrote nothing at all.
    expect(readFileSync(logPath, "utf8")).toBe(before);
    expect(store.findOperation(newest.opId)).not.toBeNull();
    expect((await journal("?client=hermes")).map(row => row.opId)).toContain(newest.opId);
  });

  test("newest is re-read at write time rather than trusted from the list", async () => {
    /*
     * A dialog can sit open while another operation lands. The formerly-newest
     * row stops being newest and becomes deletable, which only holds because
     * the handler re-reads immediately before the write instead of relying on
     * the flag the client was rendered with.
     */
    const [, newest] = await twoOperations();
    expect((await del(byId(newest.opId))).status).toBe(409);

    expect((await put("hermes", true)).status).toBe(200);
    expect((await del(byId(newest.opId))).status).toBe(200);
    expect(store.findOperation(newest.opId)).toBeNull();
  });

  test("a row whose snapshot bytes are already gone is expired AND deletable", async () => {
    /*
     * This pairing is the reason the feature exists: such a row could not be
     * restored and could not be removed, so it sat in the list forever with no
     * action on it at all.
     */
    const configPath = installHermes();
    writeFileSync(configPath, "providers:\n  mine:\n    api: http://keep\n");
    expect((await put("hermes", true)).status).toBe(200);
    expect((await put("hermes", false)).status).toBe(200);

    const older = (await journal("?client=hermes"))[1]!;
    const resolved = store.readSnapshot(store.findOperation(older.opId)!);
    expect(resolved.kind).toBe("stored");
    if (resolved.kind === "stored") rmSync(resolved.path, { force: true });

    const expiredRow = (await journal("?client=hermes")).find(row => row.opId === older.opId)!;
    expect(expiredRow.snapshot).toBe("expired");
    expect(expiredRow.undoable).toBe(false);
    expect(expiredRow.deletable).toBe(true);

    expect((await del(byId(older.opId))).status).toBe(200);
    expect(store.findOperation(older.opId)).toBeNull();
  });

  test("a prune failure still retires the row and discloses the leftover", async () => {
    const [older] = await twoOperations();
    const snapshotDir = join(storeRoot, "snapshots", "hermes");
    expect(existsSync(snapshotDir)).toBe(true);

    chmodSync(snapshotDir, 0o000);
    let refused = false;
    try {
      // Running as root defeats the permission bit; only assert the contract
      // when the failure genuinely occurred.
      refused = !store.pruneSnapshots("hermes").ok;
      if (refused) {
        const response = await del(byId(older.opId));
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ ok: true, snapshotRemoved: false });
        // The tombstone is committed first, so a failed cleanup can never take
        // the recorded deletion down with it.
        expect(store.findOperation(older.opId)).toBeNull();
        // The leftover is recorded for a retry while it is still stranded.
        expect(store.readMaintenance().pruneFailures.hermes).toBeDefined();
      }
    } finally {
      chmodSync(snapshotDir, 0o700);
    }
    if (refused) {
      /*
       * Reading the state retries pending prunes, so once the directory is
       * readable again the leftover is collected and the marker clears. That
       * is the disclosure working, not the absence of one: the row stays
       * retired either way.
       */
      const state = await (await api("/api/client-integrations/hermes")).json() as { retentionDegraded: boolean };
      expect(state.retentionDegraded).toBe(false);
      expect(store.readMaintenance().pruneFailures.hermes).toBeUndefined();
      expect(store.findOperation(older.opId)).toBeNull();
    }
  });

  test("an unsupported method on the journal path still falls through", async () => {
    // Accepting DELETE must not turn the path into a catch-all: PATCH keeps
    // travelling the dispatch chain exactly as it did before.
    const url = new URL("http://127.0.0.1:10100/api/client-integrations/journal");
    const response = await handleManagementAPI(
      new Request(url, { method: "PATCH", headers: { Host: url.host } }),
      url,
      config,
      { saveConfigPreservingClaudeCode: () => {}, createManagementConvergeCodex: catalogConvergenceFactory() },
    );
    expect(response).toBeNull();
  });
});
