import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { handleClientIntegrationCommand as command } from "../../src/cli/integrations";
import { handleIntegrationPreviewCommand as leaf } from "../../src/cli/integration-preview";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";

let home: TempHome;
let out: ReturnType<typeof spyOn>, err: ReturnType<typeof spyOn>, network: ReturnType<typeof spyOn>;
const fingerprint = `p9:${"a".repeat(32)}`;
beforeEach(() => {
  home = createTempHome("ocx-cli-droid-");
  out = spyOn(console, "log").mockImplementation(() => {});
  err = spyOn(console, "error").mockImplementation(() => {});
  network = spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Network denied"); });
});
afterEach(() => { network.mockRestore(); out.mockRestore(); err.mockRestore(); home.remove(); });
function fixture() {
  const calls: Array<{ path: string; method?: string; body: unknown }> = [];
  let discoveries = 0;
  const deps: RuntimeApiDeps = {
    findLiveProxy: async () => { discoveries++; return { port: 10100, hostname: "127.0.0.1", pid: 1, source: "runtime" }; },
    fetchImpl: (async (input, init) => {
      expect(init?.redirect).toBe("error");
      calls.push({ path: new URL(String(input)).pathname, method: init?.method, body: JSON.parse(String(init?.body)) });
      if (String(input).endsWith("/preview")) return Response.json({ version: 1, clientId: "droid", operation: "apply", state: "absent", foreignEdit: "none", changes: [], fingerprint, canApply: true, willChange: false });
      return Response.json({ ok: true, clientId: "droid", state: "current", changed: true, message: "UNTRUSTED", token: "UNTRUSTED" });
    }) as typeof fetch,
  };
  return { calls, deps, discoveries: () => discoveries };
}

test.each([
  [[], { enabled: true }],
  [["--clear-reasoning-defaults"], { enabled: true, droidReasoningDefaults: {} }],
  [["--reasoning-default", "Org/Model=V2=HIGH", "--reasoning-default=Org/Other=low"], { enabled: true, droidReasoningDefaults: { "Org/Model=V2": "HIGH", "Org/Other": "low" } }],
  [["--overwrite-conflict", "--plan-fingerprint", fingerprint, "--reasoning-default", "a/m1=high"], { enabled: true, overwriteConflict: true, operation: "overwrite", planFingerprint: fingerprint, droidReasoningDefaults: { "a/m1": "high" } }],
] as const)("Droid wire preserves omitted/clear/replacement intent %j", async (options, expected) => {
  const f = fixture();
  expect(await (options.length ? command : leaf)(["enable", "--client", "droid", ...options, "--json"], f.deps)).toBe(0);
  expect(f.calls).toEqual([{ path: "/api/client-integrations/droid", method: "PUT", body: expected }]);
  expect(f.discoveries()).toBe(1);
  expect(JSON.parse(out.mock.calls[0]![0])).toEqual({ ok: true, clientId: "droid", state: "current", operation: options.some(option => option === "--overwrite-conflict") ? "overwrite" : "apply", changed: true });
  expect(JSON.stringify([out.mock.calls, err.mock.calls])).not.toContain("UNTRUSTED");
});

test("preview sends independent expected Droid map", async () => {
  const f = fixture();
  expect(await command(["preview", "--client", "droid", "--operation", "apply", "--reasoning-default", "a/m1=high", "--json"], f.deps)).toBe(0);
  expect(f.calls).toEqual([{ path: "/api/client-integrations/preview", method: "POST", body: { clientId: "droid", operation: "apply", droidReasoningDefaults: { "a/m1": "high" } } }]);
});

const invalid = [
  ["enable", "--client", "pi", "--clear-reasoning-defaults"],
  ["disable", "--client", "droid", "--reasoning-default", "a/m=low"],
  ["preview", "--client", "droid", "--operation", "disable", "--clear-reasoning-defaults"],
  ["restore", "--op", "id", "--reasoning-default", "a/m=low"],
  ...["", "=low", "a/m=", "   =low", "a/m=   ", "a/m"].map(value => ["enable", "--client", "droid", "--reasoning-default", value]),
  ["enable", "--client", "droid", "--reasoning-default", "a/m=low", "--reasoning-default=a/m=high"],
  ["enable", "--client", "droid", "--clear-reasoning-defaults", "--reasoning-default", "a/m=low"],
  ["enable", "--client", "droid", "--clear-reasoning-defaults", "--clear-reasoning-defaults"],
];
test.each(invalid)("invalid Droid arguments never discover or write %j", async (...args) => {
  const f = fixture(); expect(await command(args, f.deps)).toBe(2);
  expect(f.discoveries()).toBe(0); expect(f.calls).toEqual([]); expect(out.mock.calls).toEqual([]);
});
