import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleClientIntegrationCommand as command } from "../../src/cli/integrations";
import { handleIntegrationPreviewCommand as leaf } from "../../src/cli/integration-preview";
import { decodeIntegrationPlan, FILE_INTEGRATION_CLIENTS } from "../../src/cli/integration-plan-dto";
import { parseIntegrationMutationPlan as guiDecode } from "../../gui/src/pages/integrations/integration-api";
import { MANAGED_PATH_TEMPLATES } from "../../src/integrations/mutation-plan";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../src/integrations/store";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { handleManagementAPI } from "../../src/server/management-api";
import { loadExportModels, resetExportSnapshotForTests } from "../../src/server/management/model-rows";
import { setIntegrationMutationFlightTestHooks, setIntegrationPathTestHooks } from "../../src/server/management/integration-routes";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import type { OcxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { repoPath } from "../helpers/repo-root";

let home: TempHome;
let out: ReturnType<typeof spyOn>, err: ReturnType<typeof spyOn>, network: ReturnType<typeof spyOn>;
const nativeFetch = globalThis.fetch;
const token = `p8:${"b".repeat(32)}`;
const plan = { version: 1, clientId: "pi", operation: "apply", state: "absent", foreignEdit: "none", changes: [], fingerprint: token, canApply: true, willChange: false };
test.each([
  { client: "pi", args: [`--plan-fingerprint=${token}`], body: { enabled: true, operation: "apply", planFingerprint: token } },
  { client: "droid", args: ["--reasoning-default=provider/model=high"], body: { enabled: true, droidReasoningDefaults: { "provider/model": "high" } } },
])("public client dispatcher accepts inline new-option syntax for $client", async ({ client, args, body }) => {
  const f = fixture({ ok: true, clientId: client, state: "current", changed: true });
  expect(await command(["enable", "--client", client, ...args, "--json"], f.deps)).toBe(0);
  expect(f.calls).toEqual([{ path: `/api/client-integrations/${client}`, method: "PUT", body }]);
});
beforeEach(() => {
  home = createTempHome("ocx-cli-integration-preview-");
  out = spyOn(console, "log").mockImplementation(() => {});
  err = spyOn(console, "error").mockImplementation(() => {});
  network = spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Network denied"); });
});
afterEach(() => { network.mockRestore(); out.mockRestore(); err.mockRestore(); home.remove(); });
function fixture(response: unknown = plan, status = 200) {
  const calls: Array<{ path: string; body: unknown; method?: string }> = [];
  let probes = 0;
  const deps: RuntimeApiDeps = {
    findLiveProxy: async () => { probes++; return { port: 10100, hostname: "127.0.0.1", pid: 1, source: "runtime" }; },
    fetchImpl: (async (input, init) => {
      expect(init?.redirect).toBe("error");
      calls.push({ path: new URL(String(input)).pathname, method: init?.method, body: JSON.parse(String(init?.body)) });
      return Response.json(response, { status });
    }) as typeof fetch,
  };
  return { calls, deps, probes: () => probes };
}
function result() { expect(out.mock.calls.length).toBe(1); return JSON.parse(out.mock.calls[0]![0]); }
function clearOutput() { out.mockClear(); err.mockClear(); }
const previewArgs = ["preview", "--client", "pi", "--operation", "apply"];

describe("preview wire and failure contracts", () => {
  test("one closed JSON plan, no-op and refused unbound inspection", async () => {
    const f = fixture(); expect(await command([...previewArgs, "--json"], f.deps)).toBe(0);
    expect(result()).toEqual(plan);
    expect(f.calls).toEqual([{ path: "/api/client-integrations/preview", method: "POST", body: { clientId: "pi", operation: "apply" } }]);
    clearOutput(); expect(await command(previewArgs, f.deps)).toBe(0);
    expect(JSON.stringify(out.mock.calls)).toContain("no changes needed");
    clearOutput();
    const refusal = fixture({ ...plan, canApply: false, refusalReason: "unsafe", fingerprint: "p7:unbound" });
    expect(await command(previewArgs, refusal.deps)).toBe(0);
    expect(JSON.stringify(out.mock.calls)).toContain("refused (unsafe)");
  });
  test.each([
    ["restore", "--op", "operation-one", "--preview"],
    ["restore", "--op-id", "operation-one", "--preview", "--client", "aside", "--profile", "2", "--confirm-drift"],
  ])("restore preview exact scope %j", async (...args) => {
    const aside = args.includes("aside");
    const f = fixture({ ...plan, operation: "restore", ...(aside ? { clientId: "aside", profileId: 2 } : {}) });
    expect(await command([...args, "--json"], f.deps)).toBe(0);
    expect(f.calls).toEqual([{ path: aside ? "/api/client-integrations/aside/profiles/2/preview" : "/api/client-integrations/restore/preview", method: "POST", body: aside ? { opId: "operation-one", confirmDrift: true, operation: "restore" } : { opId: "operation-one", confirmDrift: false } }]);
  });
  test.each(["enable", "disable", "restore"])("bound %s preserves the top-level primitive pair and original defaults", async action => {
    const f = fixture({ ok: true, clientId: "pi", state: "current", changed: false });
    const args = action === "restore" ? [action, "--op", "op-one"] : [action, "--client", "pi"];
    expect(await command([...args, "--plan-fingerprint", token, "--json"], f.deps)).toBe(0);
    expect(f.calls).toEqual([{ path: action === "restore" ? "/api/client-integrations/restore" : "/api/client-integrations/pi", method: action === "restore" ? "POST" : "PUT", body: { ...(action === "restore" ? { opId: "op-one", confirmDrift: false } : { enabled: action === "enable" }), operation: action === "enable" ? "apply" : action, planFingerprint: token } }]);
  });
  test("stale error never prints replacement plan or retries", async () => {
    const f = fixture({ code: "integration_preview_stale", message: "PRIVATE", plan: { ...plan, fingerprint: "PRIVATE" }, snapshotPath: "PRIVATE" }, 409);
    expect(await command(["enable", "--client", "pi", "--plan-fingerprint", token, "--json"], f.deps)).toBe(5);
    expect(out.mock.calls).toEqual([]); expect(f.calls).toHaveLength(1);
    expect(JSON.stringify(err.mock.calls)).toContain("explicit preview"); expect(JSON.stringify(err.mock.calls)).not.toContain("PRIVATE");
  });
  test("known recovery fields survive without server messages or secrets", async () => {
    const f = fixture({ error: "PRIVATE", message: "PRIVATE", hint: "PRIVATE", residual: true, snapshotPath: "/Users/example/token-PRIVATE/backup.json" }, 500);
    expect(await command(["enable", "--client", "pi", "--plan-fingerprint", token], f.deps)).toBe(1);
    const text = JSON.stringify(err.mock.calls);
    expect(text).toContain("recovery did not finish"); expect(text).toContain("Backup (redacted path)");
    expect(text).not.toContain("PRIVATE"); expect(text).not.toContain("/Users/example/"); expect(out.mock.calls).toEqual([]);
  });
  test.each([400, 401, 404, 409, 503])("status %i uses fixed errors and empty stdout", async status => {
    const f = fixture({ error: "PRIVATE" }, status);
    expect(await command([...previewArgs, "--json"], f.deps)).toBe(status === 404 ? 4 : status === 409 ? 5 : 1);
    expect(out.mock.calls).toEqual([]); expect(JSON.stringify(err.mock.calls)).not.toContain("PRIVATE");
  });
  test("recognized drift refusal gives a concrete recovery command without echoing prose", async () => {
    const f = fixture({ reason: "drift_requires_confirm", error: "PRIVATE", message: "PRIVATE" }, 409);
    expect(await command(["restore", "--op", "op-one", "--plan-fingerprint", token, "--json"], f.deps)).toBe(5);
    expect(out.mock.calls).toEqual([]); expect(JSON.stringify(err.mock.calls)).toContain("restore --preview --confirm-drift");
    expect(JSON.stringify(err.mock.calls)).not.toContain("PRIVATE");
  });
  test.each([
    null, {}, { ok: true, clientId: "pi", state: "current" },
    { ok: true, clientId: "pi", state: "other", changed: true },
    { ok: true, clientId: "pi", state: "current", changed: true, residual: "yes" },
    { ok: true, clientId: "pi", state: "current", changed: true, snapshotPath: { token: "PRIVATE" } },
    { ok: true, clientId: "droid", state: "current", changed: true },
  ])("malformed mutation receipts do not claim success %#", async body => {
    const f = fixture(body);
    expect(await command(["enable", "--client", "pi", "--plan-fingerprint", token, "--json"], f.deps)).toBe(1);
    expect(out.mock.calls).toEqual([]); expect(JSON.stringify(err.mock.calls)).not.toContain("PRIVATE");
  });
  test("generic restore cannot claim an Aside profile outcome", async () => {
    const f = fixture({ ok: true, clientId: "aside", profileId: 0, state: "current", changed: true });
    expect(await command(["restore", "--op", "op-one", "--plan-fingerprint", token, "--json"], f.deps)).toBe(1);
    expect(out.mock.calls).toEqual([]);
  });
  test("redirect refuses before a second HTTP request", async () => {
    let hits = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { hits++; return new Response(null, { status: 307, headers: { location: new URL("/unexpected", req.url).href } }); } });
    try {
      expect(await command(previewArgs, { baseUrl: `http://127.0.0.1:${server.port}`, fetchImpl: nativeFetch })).toBe(1);
      expect(hits).toBe(1); expect(out.mock.calls).toEqual([]);
    } finally { await server.stop(true); }
  });
});

const invalidArgs = [
  [...previewArgs, "--plan-fingerprint", token], [...previewArgs, "--json", "--json"],
  ["enable", "--client", "pi", "--plan-fingerprint", "p1:unbound"],
  ["enable", "--client", "pi", "--plan-fingerprint", `p1:${"A".repeat(32)}`],
  ["preview", "--client", "aside", "--operation", "apply"],
  ["preview", "--client", "aside", "--profile", "01", "--operation", "apply"],
  ["preview", "--client", "pi", "--profile", "0", "--operation", "apply"],
  ["restore", "--op", "one", "--op-id", "two", "--preview"],
  ["restore", "--op", "one", "--client", "pi", "--preview"],
  ["restore", "--op", "one", "--preview", "--plan-fingerprint", token],
  ["disable", "--client", "pi", "--overwrite-conflict"],
  [...previewArgs, "--client", "droid"], [...previewArgs, "--unknown=PRIVATE"],
];
test.each(invalidArgs)("bad inputs have zero discovery/request %j", async (...args) => {
  const f = fixture(); expect(await leaf(args, f.deps)).toBe(2);
  expect(f.probes()).toBe(0); expect(f.calls).toEqual([]); expect(out.mock.calls).toEqual([]);
  expect(JSON.stringify(err.mock.calls)).not.toContain("PRIVATE");
});

const invalidPlans = [
  { ...plan, extra: "PRIVATE" }, { ...plan, version: 2 }, { ...plan, clientId: "unknown" },
  { ...plan, fingerprint: "p1:unbound" }, { ...plan, canApply: false }, { ...plan, refusalReason: "unsafe" },
  { ...plan, willChange: true }, { ...plan, profileId: 1 }, { ...plan, foreignEdit: "other" },
  ...["/Users/example/PRIVATE", "models.PRIVATE", "$secret"].map(path => ({ ...plan, willChange: true, changes: [{ kind: "add", path }] })),
  { ...plan, willChange: true, changes: [{ kind: "add", path: "providers.opencodex", value: "PRIVATE" }] },
  { ...plan, willChange: true, changes: [{ kind: "write", path: "providers.opencodex" }] },
  { ...plan, willChange: true, changes: [{ kind: "add", path: "providers.opencodex" }, { kind: "add", path: "providers.opencodex" }] },
  { ...plan, willChange: true, changes: [{ kind: "journal", path: "$journal" }, { kind: "add", path: "providers.opencodex" }] },
  { ...plan, willChange: true, changes: Array.from({ length: 257 }, () => ({ kind: "add", path: "providers.opencodex" })) },
];
test.each(invalidPlans)("both decoders reject malformed plan %#", async value => {
  expect(() => decodeIntegrationPlan(value)).toThrow(); expect(() => guiDecode(value)).toThrow();
  const f = fixture(value); expect(await command([...previewArgs, "--json"], f.deps)).toBe(1);
  expect(out.mock.calls).toEqual([]); expect(JSON.stringify(err.mock.calls)).not.toContain("PRIVATE");
});
test("CLI refuses coercible non-string enum fields at the JSON boundary", () => {
  expect(() => decodeIntegrationPlan({ ...plan, state: ["current"] })).toThrow();
  expect(() => decodeIntegrationPlan({ ...plan, canApply: false, refusalReason: ["unsafe"] })).toThrow();
});
test.each([{ ...plan, clientId: "droid" }, { ...plan, operation: "disable" }, { ...plan, clientId: "aside", profileId: 2 }])("valid but mismatched target/action fails %#", async value => {
  const f = fixture(value); expect(await command([...previewArgs, "--json"], f.deps)).toBe(1); expect(out.mock.calls).toEqual([]);
});

test("closed decoder agrees with canonical template vocabulary and has no runtime imports", () => {
  expect([...FILE_INTEGRATION_CLIENTS].sort()).toEqual(Object.keys(INTEGRATION_CLIENTS).sort());
  for (const clientId of FILE_INTEGRATION_CLIENTS) for (const template of MANAGED_PATH_TEMPLATES[clientId]) {
    const value = { ...plan, clientId, willChange: true, changes: [{ kind: "add", path: template.join(".") }] };
    expect(decodeIntegrationPlan(value)).toEqual(guiDecode(value));
  }
  const source = readFileSync(repoPath("src/cli/integration-plan-dto.ts"), "utf8");
  expect(new Bun.Transpiler({ loader: "ts" }).scanImports(source)).toEqual([]);
});

describe("real management binding and persistence", () => {
  let config: OcxConfig, store: IntegrationStateStore, droidPath: string;
  let calls: string[];
  let deps: RuntimeApiDeps;
  beforeEach(async () => {
    const syntheticHome = join(home.root, "clients");
    mkdirSync(syntheticHome, { recursive: true });
    store = createIntegrationStateStore(join(home.root, "integration-store"));
    config = { port: 10100, hostname: "127.0.0.1", defaultProvider: "a", providers: {
      a: { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", liveModels: false, models: ["m1"], modelReasoningEfforts: { m1: ["low", "high"] } },
    } } as OcxConfig;
    setIntegrationMutationFlightTestHooks({ store });
    setIntegrationPathTestHooks({ home: syntheticHome, env: {} });
    resetExportSnapshotForTests();
    await loadExportModels(config, [{ id: "m1", provider: "a", reasoningEfforts: ["low", "high"] }]);
    const droid = INTEGRATION_CLIENTS.droid;
    mkdirSync(droid.detectDir({}, syntheticHome), { recursive: true });
    droidPath = droid.configPath({}, syntheticHome); writeFileSync(droidPath, '{"customModels":[]}\n');
    mkdirSync(join(syntheticHome, ".aside"), { recursive: true });
    writeFileSync(join(syntheticHome, ".aside/accounts.json"), JSON.stringify({ currentAccountId: 0, accounts: [{ id: 0, name: "Zero" }, { id: 1, name: "One" }] }));
    for (const id of [0, 1]) { mkdirSync(join(syntheticHome, `.aside/u/${id}`), { recursive: true }); writeFileSync(join(syntheticHome, `.aside/u/${id}/models.json`), '{"providers":{}}'); }
    calls = [];
    deps = { baseUrl: "http://127.0.0.1:10100", fetchImpl: (async (input, init) => {
      expect(init?.redirect).toBe("error");
      const url = new URL(String(input)); calls.push(url.pathname);
      const response = await handleManagementAPI(new Request(url, { ...init, headers: { host: url.host, "content-type": "application/json" } }), url, config, { saveConfigPreservingClaudeCode: () => {}, createManagementConvergeCodex: catalogConvergenceFactory() });
      if (!response) throw new Error("fixture route missing"); return response;
    }) as typeof fetch };
  });
  afterEach(() => { resetExportSnapshotForTests(); setIntegrationMutationFlightTestHooks(null); setIntegrationPathTestHooks(null); });
  async function preview(client = "droid", more: string[] = []) {
    clearOutput(); expect(await command(["preview", "--client", client, "--operation", "apply", ...more, "--json"], deps)).toBe(0);
    const value = result(); expect(decodeIntegrationPlan(value)).toEqual(guiDecode(value)); clearOutput(); return value;
  }
  test("Droid map is bound, persisted, preserved when omitted, replaced then cleared", async () => {
    const p = await preview("droid", ["--reasoning-default", "a/m1=high"]);
    expect(await command(["enable", "--client", "droid", "--plan-fingerprint", p.fingerprint, "--reasoning-default", "a/m1=high", "--json"], deps)).toBe(0);
    expect(result()).toMatchObject({ ok: true, changed: true, operation: "apply", clientId: "droid" });
    const headers = () => JSON.parse(readFileSync(droidPath, "utf8")).customModels[0].extraHeaders;
    expect(headers()).toEqual({ "x-opencodex-droid-default-effort": "high" });
    clearOutput(); expect(await leaf(["enable", "--client", "droid", "--json"], deps)).toBe(0); expect(headers()).toEqual({ "x-opencodex-droid-default-effort": "high" });
    clearOutput(); expect(await command(["enable", "--client", "droid", "--reasoning-default", "a/m1=low", "--json"], deps)).toBe(0); expect(headers()).toEqual({ "x-opencodex-droid-default-effort": "low" });
    clearOutput(); expect(await command(["enable", "--client", "droid", "--clear-reasoning-defaults", "--json"], deps)).toBe(0); expect(headers()).toBeUndefined();
    expect(network.mock.calls).toEqual([]);
  });
  test.each(["file", "roster", "defaults", "omitted-defaults", "action"])("changed %s refuses with no mutation/retry", async change => {
    const p = await preview("droid", ["--reasoning-default", "a/m1=high"]);
    if (change === "file") writeFileSync(droidPath, '{"customModels":[],"theme":"changed"}\n');
    if (change === "roster") { config.providers.a!.models = ["m1", "m2"]; await loadExportModels(config, [{ id: "m1", provider: "a", reasoningEfforts: ["low", "high"] }, { id: "m2", provider: "a" }]); }
    const before = readFileSync(droidPath, "utf8"), count = calls.length;
    const flags = change === "action" || change === "omitted-defaults" ? [] : ["--reasoning-default", `a/m1=${change === "defaults" ? "low" : "high"}`];
    expect(await command([change === "action" ? "disable" : "enable", "--client", "droid", "--plan-fingerprint", p.fingerprint, ...flags, "--json"], deps)).toBe(5);
    expect(out.mock.calls).toEqual([]); expect(calls.length).toBe(count + 1); expect(readFileSync(droidPath, "utf8")).toBe(before); expect(store.listOperations("droid")).toEqual([]);
  });
  test("Aside fingerprint cannot select a different profile", async () => {
    const p = await preview("aside", ["--profile", "0"]);
    expect(await command(["enable", "--client", "aside", "--profile", "1", "--plan-fingerprint", p.fingerprint, "--json"], deps)).toBe(5);
    expect(out.mock.calls).toEqual([]); expect(store.listOperations("aside")).toEqual([]);
    expect(await command(["enable", "--client", "aside", "--profile", "0", "--plan-fingerprint", p.fingerprint, "--json"], deps)).toBe(0);
    expect(result()).toMatchObject({ ok: true, profileId: 0, changed: true });
  });
  test.each(["droid", "aside"])("%s restore preview and checked commit recover original bytes", async client => {
    const scope = client === "aside" ? ["--client", "aside", "--profile", "0"] : [];
    const path = client === "droid" ? droidPath : home.path("clients/.aside/u/0/models.json");
    const before = readFileSync(path, "utf8");
    const p = await preview(client, client === "aside" ? ["--profile", "0"] : []);
    expect(await command(["enable", "--client", client, ...(client === "aside" ? ["--profile", "0"] : []), "--plan-fingerprint", p.fingerprint, "--json"], deps)).toBe(0);
    const opId = result().opId;
    // Aside enable persists profile preferences, invalidating the previous roster identity.
    if (client === "aside") await loadExportModels(config, [{ id: "m1", provider: "a", reasoningEfforts: ["low", "high"] }]);
    clearOutput();
    expect(await command(["restore", "--op", opId, "--preview", ...scope, "--json"], deps)).toBe(0);
    const restore = result(); expect(restore).toMatchObject({ operation: "restore", canApply: true, willChange: true });
    expect(guiDecode(restore)).toEqual(decodeIntegrationPlan(restore));
    clearOutput();
    expect(await command(["restore", "--op", opId, ...scope, "--plan-fingerprint", restore.fingerprint, "--json"], deps)).toBe(0);
    expect(result()).toMatchObject({ ok: true, clientId: client, changed: true, operation: "restore" });
    expect(readFileSync(path, "utf8")).toBe(before);
  });
  test.each(["confirmDrift", "operation-id", "snapshot"])("changed restore %s cannot reuse its token", async change => {
    const p = await preview();
    expect(await command(["enable", "--client", "droid", "--plan-fingerprint", p.fingerprint, "--json"], deps)).toBe(0);
    const opId = result().opId;
    clearOutput();
    expect(await command(["restore", "--op", opId, "--preview", "--json"], deps)).toBe(0);
    const restore = result(); clearOutput();
    let selectedOp = opId;
    if (change === "operation-id") {
      expect(await leaf(["disable", "--client", "droid", "--json"], deps)).toBe(0);
      selectedOp = result().opId; clearOutput();
    }
    if (change === "snapshot") store.captureSnapshot("droid", opId, '{"customModels":[],"changed":true}');
    const before = readFileSync(droidPath, "utf8"), operations = store.listOperations("droid"), count = calls.length;
    expect(await command(["restore", "--op", selectedOp, "--plan-fingerprint", restore.fingerprint, ...(change === "confirmDrift" ? ["--confirm-drift"] : []), "--json"], deps)).toBe(5);
    expect(out.mock.calls).toEqual([]); expect(calls.length).toBe(count + 1);
    expect(readFileSync(droidPath, "utf8")).toBe(before); expect(store.listOperations("droid")).toEqual(operations);
  });
  test("passive cache unavailable never discovers models or creates journal", async () => {
    resetExportSnapshotForTests(); const before = readFileSync(droidPath, "utf8");
    expect(await command(["preview", "--client", "droid", "--operation", "apply", "--json"], deps)).toBe(5);
    expect(out.mock.calls).toEqual([]); expect(network.mock.calls).toEqual([]); expect(calls).toHaveLength(1);
    expect(readFileSync(droidPath, "utf8")).toBe(before); expect(store.listOperations("droid")).toEqual([]);
  });
});
