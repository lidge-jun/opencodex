import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { handleExportCommand } from "../../src/cli/export-command";
import { handleClientIntegrationCommand } from "../../src/cli/integrations";
import type { OcxConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";

let home: TempHome;
let out: ReturnType<typeof spyOn>;
let err: ReturnType<typeof spyOn>;
beforeEach(() => {
  home = createTempHome("ocx-cli-model-names-");
  out = spyOn(console, "log").mockImplementation(() => {});
  err = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { out.mockRestore(); err.mockRestore(); home.remove(); });
const token = `p7:${"a".repeat(32)}`;
function fixture(client: string, preview = false) {
  const document = client === "hermes" ? { providers: { opencodex: { models: { "AC/AC-model-x": {} } } } }
    : { provider: { opencodex: { models: { "AC/AC-model-x": {} } } } };
  const text = "providers:\n  opencodex:\n    models:\n      AC/AC-model-x: {}\n";
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  let probes = 0;
  let configReads = 0;
  const deps = {
    findLiveProxy: async () => { probes++; return { port: 10100, hostname: "127.0.0.1", pid: 1, source: "runtime" as const }; },
    configImpl: () => { configReads++; return { port: 10100, hostname: "127.0.0.1", providers: {}, preferModelAliasIds: true } as OcxConfig; },
    fetchImpl: (async (input, init) => {
      const url = new URL(String(input));
      calls.push({ path: url.pathname + url.search, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      return Response.json(url.pathname === "/api/client-config"
        ? { client, format: client === "hermes" ? "yaml" : "json", config: document, text }
        : url.pathname === "/api/models" ? [{ namespaced: "acme/vendor-model-x", provider: "acme", id: "vendor/model-x", disabled: false }]
        : preview ? { version: 1, clientId: client, operation: JSON.parse(String(init?.body)).operation, state: "absent", foreignEdit: "none", changes: [], fingerprint: token, canApply: true, willChange: false }
          : { ok: true, clientId: client, state: "current", changed: true });
    }) as typeof fetch,
  };
  return { deps, calls, document, text, probes: () => probes, configReads: () => configReads };
}

test.each(["hermes", "commandcode"])("export forwards %s mode to passive API and prints only JSON document", async client => {
  const f = fixture(client); const before = readdirSync(home.root, { recursive: true });
  expect(await handleExportCommand(["--client", client, "--model-names=alias", "--json"], f.deps)).toBe(0);
  expect(f.calls).toEqual([{ path: `/api/client-config?client=${client}&preview=1&modelNames=alias`, method: "GET" }]);
  expect(JSON.parse(out.mock.calls[0]![0])).toEqual(f.document);
  expect(readdirSync(home.root, { recursive: true })).toEqual(before);
  expect(f.configReads()).toBe(0);
});
test("native text and explicit --out retain artifact semantics", async () => {
  const f = fixture("hermes"); const path = home.path("export.yaml");
  expect(await handleExportCommand(["--client", "hermes", "--model-names", "routed", "--out", path], f.deps)).toBe(0);
  expect(readFileSync(path, "utf8")).toBe(f.text);
  expect(out.mock.calls.slice(0, 4).map(call => call[0]).join("\n") + "\n").toBe(f.text);
});
test.each(["hermes", "commandcode"])("omitted %s export mode keeps the existing models query", async client => {
  const f = fixture(client);
  expect(await handleExportCommand(["--client", client, "--json"], f.deps)).toBe(0);
  expect(f.calls).toEqual([{ path: "/api/models", method: "GET" }]);
  expect(f.configReads()).toBe(1);
  expect(JSON.stringify(JSON.parse(out.mock.calls[0]![0]))).toContain("acme/vendor-model-x");
});
for (const client of ["hermes", "commandcode"]) for (const mode of ["alias", "routed"]) {
  test(`${client} enable ${mode} forwards explicit intent with and without binding`, async () => {
    for (const bound of [false, true]) {
      const f = fixture(client);
      expect(await handleClientIntegrationCommand(["enable", "--client", client, "--model-names", mode, ...(bound ? ["--plan-fingerprint", token] : []), "--json"], f.deps)).toBe(0);
      expect(f.calls).toEqual([{ path: `/api/client-integrations/${client}`, method: "PUT", body: { enabled: true, modelNames: mode, ...(bound ? { operation: "apply", planFingerprint: token } : {}) } }]);
    }
  });
  test(`${client} preview ${mode} forwards modelNames`, async () => {
    const f = fixture(client, true);
    expect(await handleClientIntegrationCommand(["preview", "--client", client, "--operation", "apply", `--model-names=${mode}`, "--json"], f.deps)).toBe(0);
    expect(f.calls[0]).toEqual({ path: "/api/client-integrations/preview", method: "POST", body: { clientId: client, operation: "apply", modelNames: mode } });
  });
}
test("ordinary enable omission does not insert a mode", async () => {
  const f = fixture("hermes");
  expect(await handleClientIntegrationCommand(["enable", "--client", "hermes", "--json"], f.deps)).toBe(0);
  expect(f.calls[0]?.body).toEqual({ enabled: true });
});
test("overwrite enable and preview carry the selected mode", async () => {
  const f = fixture("hermes");
  expect(await handleClientIntegrationCommand(["enable", "--client", "hermes", "--overwrite-conflict", "--model-names=alias", "--plan-fingerprint", token, "--json"], f.deps)).toBe(0);
  expect(f.calls[0]?.body).toEqual({ enabled: true, overwriteConflict: true, modelNames: "alias", operation: "overwrite", planFingerprint: token });
  const p = fixture("commandcode", true);
  expect(await handleClientIntegrationCommand(["preview", "--client", "commandcode", "--operation", "overwrite", "--model-names=routed", "--json"], p.deps)).toBe(0);
  expect(p.calls[0]?.body).toEqual({ clientId: "commandcode", operation: "overwrite", modelNames: "routed" });
});
test.each([
  ["--model-names", "raw"], ["--model-names"], ["--model-names="],
  ["--model-names", "alias", "--model-names=routed"],
])("export malformed option rejected before API: %j", async (...flags) => {
  const f = fixture("hermes");
  expect(await handleExportCommand(["--client", "hermes", ...flags], f.deps)).toBe(2);
  expect(f.probes()).toBe(0); expect(f.calls).toEqual([]);
});
test.each(["alias", "routed"])("unsupported export rejects explicit %s before API", async mode => {
  const f = fixture("pi");
  expect(await handleExportCommand(["--client", "pi", "--model-names", mode], f.deps)).toBe(2);
  expect(f.probes()).toBe(0); expect(f.calls).toEqual([]);
});
test.each([
  ["enable", "--client", "hermes", "--model-names", "raw"],
  ["enable", "--client", "hermes", "--model-names"],
  ["enable", "--client", "hermes", "--model-names=alias", "--model-names=routed"],
  ["enable", "--client", "pi", "--model-names", "routed"],
  ["disable", "--client", "hermes", "--model-names", "alias"],
  ["preview", "--client", "hermes", "--operation", "disable", "--model-names", "alias"],
  ["restore", "--op", "one", "--model-names", "alias"],
  ["status", "--client", "hermes", "--model-names", "alias"],
  ["history", "--client", "hermes", "--model-names", "alias"],
])("integration rejects invalid mode/client/action before API: %j", async (...args) => {
  const f = fixture("hermes");
  expect(await handleClientIntegrationCommand(args, f.deps)).toBe(2);
  expect(f.probes()).toBe(0); expect(f.calls).toEqual([]);
});
