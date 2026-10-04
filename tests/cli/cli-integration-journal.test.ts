import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { handleClientIntegrationCommand } from "../../src/cli/integrations";
import { handleIntegrationJournalRemove } from "../../src/cli/integration-journal";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../src/integrations/store";
import { applyIntegration, disableIntegration } from "../../src/integrations/writer";
import { handleManagementAPI } from "../../src/server/management-api";
import { setIntegrationMutationFlightTestHooks, setIntegrationPathTestHooks } from "../../src/server/management/integration-routes";
import type { OcxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { createTempHome, type TempHome } from "../helpers/temp-home";

let home: TempHome, output: ReturnType<typeof spyOn>, errors: ReturnType<typeof spyOn>, network: ReturnType<typeof spyOn>;
let token: string | undefined;
const actualFetch = globalThis.fetch;
beforeEach(() => {
  home = createTempHome("ocx-cli-journal-");
  token = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  output = spyOn(console, "log").mockImplementation(() => {});
  errors = spyOn(console, "error").mockImplementation(() => {});
  network = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network forbidden"); });
});
afterEach(() => {
  setIntegrationMutationFlightTestHooks(null); setIntegrationPathTestHooks(null);
  expect(network).not.toHaveBeenCalled(); network.mockRestore(); output.mockRestore(); errors.mockRestore();
  if (token === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN; else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = token;
  home.remove();
});
const json = () => JSON.parse(output.mock.calls.flat().join("\n"));
const channels = () => [...output.mock.calls.flat(), ...errors.mock.calls.flat()].join("\n");
function fixture(body: unknown = { ok: true, opId: "op-1", clientId: "hermes", snapshotRemoved: true }, status = 200) {
  const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
  const deps: RuntimeApiDeps = { baseUrl: "http://127.0.0.1:15001", fetchImpl: async (url, init) => {
    calls.push({ url: new URL(String(url)), init });
    return Response.json(body, { status });
  } };
  return { deps, calls };
}
const baseArgs = ["--op", "op-1", "--yes", "--json"];

describe("journal removal grammar and output", () => {
  test.each([
    [], ["--op", "op-1"], ["--yes"], ["--op", " ", "--yes"], ["--op", "op\n1", "--yes"],
    [...baseArgs, "--yes"], [...baseArgs, "--json"], [...baseArgs, "--op", "other"],
    [...baseArgs, "--client", "hermes"], [...baseArgs, "--profile", "1"],
    [...baseArgs, "--client", "aside", "--profile", "-1"], [...baseArgs, "--client", "aside", "--profile", "01"],
    [...baseArgs, "--client", "aside", "--profile", "9007199254740992"], [...baseArgs, "--client", "aside", "--client", "aside"],
    [...baseArgs, "--unknown", "private-canary"],
  ].map(args => ({ args })))("rejects malformed invocation without I/O: $args", async ({ args }) => {
    const f = fixture();
    expect(await handleIntegrationJournalRemove(args, f.deps)).toBe(2);
    expect(f.calls).toHaveLength(0); expect(output).not.toHaveBeenCalled();
    expect(channels()).not.toContain("private-canary");
  });
  test.each([
    { args: [], path: "/api/client-integrations/journal", identity: { clientId: "hermes" } },
    { args: ["--client", "aside"], path: "/api/client-integrations/aside/profiles/journal", identity: { clientId: "aside", profileId: 2 } },
    { args: ["--client", "aside", "--profile", "2"], path: "/api/client-integrations/aside/profiles/2/journal", identity: { clientId: "aside", profileId: 2 } },
  ])("sends a bodyless scoped DELETE: $path", async ({ args, path, identity }) => {
    const opId = "op/&?=2";
    const receipt = { ok: true, opId, ...identity, snapshotRemoved: true };
    const f = fixture({ ...receipt, private: "private-canary" });
    expect(await handleClientIntegrationCommand(["history", "remove", "--op", opId, "--yes", "--json", ...args], f.deps)).toBe(0);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url.pathname).toBe(path);
    expect([...f.calls[0]!.url.searchParams]).toEqual([["opId", opId]]);
    expect(f.calls[0]!.init).toMatchObject({ method: "DELETE", redirect: "error" });
    expect(f.calls[0]!.init?.body).toBeUndefined(); expect(json()).toEqual(receipt);
  });
  test.each([{}, null, { ok: true }, { ok: true, opId: "other", clientId: "hermes", snapshotRemoved: true },
    { ok: true, opId: "op-1", clientId: "unknown", snapshotRemoved: true },
    { ok: true, opId: "op-1", clientId: "hermes", profileId: 1, snapshotRemoved: true },
    { ok: true, opId: "op-1", clientId: "aside", profileId: "1", snapshotRemoved: true },
  ])("rejects malformed or mismatched receipts", async body => {
    const f = fixture(body);
    expect(await handleIntegrationJournalRemove(baseArgs, f.deps)).toBe(1); expect(output).not.toHaveBeenCalled();
  });
  test("a profile receipt must match the selected scope", async () => {
    const f = fixture({ ok: true, opId: "op-1", clientId: "aside", profileId: 3, snapshotRemoved: true });
    expect(await handleIntegrationJournalRemove([...baseArgs, "--client", "aside", "--profile", "2"], f.deps)).toBe(1);
    expect(output).not.toHaveBeenCalled();
  });
  test.each([true, false])("committed retirement with incomplete cleanup stays visible (JSON %s)", async wantsJson => {
    const f = fixture({ ok: true, opId: "op-1", clientId: "hermes", snapshotRemoved: false });
    expect(await handleClientIntegrationCommand([wantsJson ? "history" : "journal", "remove", "--op", "op-1", "--yes", ...(wantsJson ? ["--json"] : [])], f.deps)).toBe(1);
    expect(f.calls).toHaveLength(1);
    if (wantsJson) expect(json().snapshotRemoved).toBe(false);
    else { expect(channels()).toContain("already retired"); expect(channels()).toContain("incomplete"); }
  });
  test.each([[404, 4], [409, 5], [500, 1]])("safe errors retain status exit %s", async (status, exit) => {
    const f = fixture({ error: "private-canary", hint: "private-canary" }, status);
    expect(await handleIntegrationJournalRemove(baseArgs, f.deps)).toBe(exit);
    expect(output).not.toHaveBeenCalled(); expect(channels()).not.toContain("private-canary");
  });
  test("redirect refusal makes no second request", async () => {
    let second = 0;
    const sink = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { second++; return Response.json({}); } });
    const source = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.redirect(`http://127.0.0.1:${sink.port}/sink`, 307) });
    try {
      expect(await handleIntegrationJournalRemove(baseArgs, { baseUrl: `http://127.0.0.1:${source.port}`, fetchImpl: actualFetch })).toBe(1);
      expect(second).toBe(0); expect(output).not.toHaveBeenCalled();
    } finally { await source.stop(true); await sink.stop(true); }
  });
});

function owner() {
  const store = createIntegrationStateStore(home.path("store"));
  const nativeHome = home.path("native"); mkdirSync(nativeHome, { recursive: true });
  const config = { port: 15001, hostname: "127.0.0.1", defaultProvider: "fixture", providers: {
    fixture: { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", models: ["one"], liveModels: false },
  } } as OcxConfig;
  setIntegrationPathTestHooks({ home: nativeHome, env: {} }); setIntegrationMutationFlightTestHooks({ store });
  const api = async (path: string, init: RequestInit = {}) => {
    const url = new URL(path, "http://127.0.0.1:15001");
    return (await handleManagementAPI(new Request(url, { ...init, headers: { Host: url.host, ...Object.fromEntries(new Headers(init.headers)) } }), url, config, {
      saveConfigPreservingClaudeCode: () => {}, createManagementConvergeCodex: catalogConvergenceFactory(),
    })) ?? new Response(null, { status: 404 });
  };
  const deps: RuntimeApiDeps = { baseUrl: "http://127.0.0.1:15001", fetchImpl: (input, init) => api(String(input), init) };
  return { store, nativeHome, config, api, deps };
}
async function hermesHistory(f: ReturnType<typeof owner>) {
  mkdirSync(INTEGRATION_CLIENTS.hermes.detectDir({}, f.nativeHome), { recursive: true });
  writeFileSync(INTEGRATION_CLIENTS.hermes.configPath({}, f.nativeHome), "providers:\n  personal:\n    base_url: http://keep.invalid\n");
  const input = { clientId: "hermes" as const, config: f.config, models: [{ namespaced: "fixture/one", provider: "fixture", id: "one", contextWindow: 128000 }], port: 15001, env: {}, home: f.nativeHome, store: f.store };
  expect((await applyIntegration(input)).ok).toBe(true); expect((await disableIntegration(input)).ok).toBe(true);
  return f.store.listOperations("hermes");
}
describe("CLI against the journal management owner", () => {
  test("newest and missing rows refuse; an older row retires once", async () => {
    const f = owner(); const rows = await hermesHistory(f);
    const run = (id: string) => handleIntegrationJournalRemove(["--op", id, "--yes", "--json"], f.deps);
    expect(await run(rows[0]!.opId)).toBe(5); expect(f.store.listOperations("hermes")).toHaveLength(2);
    expect(await run("missing")).toBe(4);
    expect(await run(rows[1]!.opId)).toBe(0); expect(json()).toMatchObject({ opId: rows[1]!.opId, snapshotRemoved: true });
    expect(f.store.findOperation(rows[1]!.opId)).toBeNull(); expect(await run(rows[1]!.opId)).toBe(4);
  });
  test("prune failure leaves a committed tombstone and surviving backup", async () => {
    const f = owner(); const rows = await hermesHistory(f); const older = rows[1]!;
    const snapshot = f.store.readSnapshot(older); expect(snapshot.kind).toBe("stored");
    const failed: IntegrationStateStore = { ...f.store, pruneSnapshots: () => ({ ok: false, error: "fixture prune failure" }) };
    setIntegrationMutationFlightTestHooks({ store: failed });
    expect(await handleIntegrationJournalRemove(["--op", older.opId, "--yes", "--json"], f.deps)).toBe(1);
    expect(json()).toMatchObject({ ok: true, opId: older.opId, snapshotRemoved: false });
    expect(f.store.findOperation(older.opId)).toBeNull();
    expect(readFileSync(home.path("store", "journal.jsonl"), "utf8")).toContain(`"tombstone":"${older.opId}"`);
    if (snapshot.kind === "stored") expect(existsSync(snapshot.path)).toBe(true);
    expect(f.store.readMaintenance().pruneFailures.hermes).toBeDefined();
  });
  test("Aside wrong-profile and newest refuse; selected older row retires", async () => {
    const f = owner(); mkdirSync(`${f.nativeHome}/.aside`, { recursive: true });
    writeFileSync(`${f.nativeHome}/.aside/accounts.json`, JSON.stringify({ currentAccountId: 1, accounts: [{ id: 1, name: "First" }, { id: 2, name: "Second" }] }));
    for (const id of [1, 2]) { mkdirSync(`${f.nativeHome}/.aside/u/${id}`, { recursive: true }); writeFileSync(`${f.nativeHome}/.aside/u/${id}/models.json`, '{"providers":{}}'); }
    for (const enabled of [true, false]) expect((await f.api("/api/client-integrations/aside/profiles/1", { method: "PUT", body: JSON.stringify({ enabled }), headers: { "content-type": "application/json" } })).status).toBe(200);
    const body = await (await f.api("/api/client-integrations/aside/profiles/1/journal")).json() as { operations: Array<{ opId: string }> };
    expect(body.operations).toHaveLength(2);
    const run = (id: string, profile: string) => handleIntegrationJournalRemove(["--op", id, "--yes", "--client", "aside", "--profile", profile, "--json"], f.deps);
    expect(await run(body.operations[1]!.opId, "2")).toBe(4);
    expect(await run(body.operations[0]!.opId, "1")).toBe(5);
    expect(await run(body.operations[1]!.opId, "1")).toBe(0);
    expect(json()).toMatchObject({ clientId: "aside", profileId: 1, snapshotRemoved: true });
  });
});
