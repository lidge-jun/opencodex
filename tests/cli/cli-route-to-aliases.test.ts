import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { handleClientIntegrationCommand } from "../../src/cli/integrations";
import { handleIntegrationCommand } from "../../src/cli/inspect";
import { createTempHome, type TempHome } from "../helpers/temp-home";

let home: TempHome;
let out: ReturnType<typeof spyOn>, err: ReturnType<typeof spyOn>;
beforeEach(() => {
  home = createTempHome("ocx-route-to-alias-");
  out = spyOn(console, "log").mockImplementation(() => {});
  err = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { out.mockRestore(); err.mockRestore(); home.remove(); });

function fixture(response?: unknown) {
  const calls: Array<{ path: string; body: unknown }> = [];
  return { calls, deps: {
    baseUrl: "http://route-to.invalid",
    fetchImpl: (async (url, init) => {
      calls.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) });
      return Response.json(response ?? { schema: "ocx.route-to/1", devices: [{ id: "home", clients: [{ client: "hermes", intent: "on", source: "default", applied: "current" }] }] });
    }) as typeof fetch,
  } };
}

test.each(["on", "off"])("native %s aliases Home route intent", async action => {
  const f = fixture();
  expect(await handleIntegrationCommand(["native", "codex", action, "--json"], f.deps)).toBe(0);
  expect(f.calls).toEqual([{ path: "/api/route-to", body: { client: "codex", action } }]);
});

test.each(["enable", "disable"])("plain client %s aliases Home route intent", async action => {
  const f = fixture();
  expect(await handleClientIntegrationCommand([action, "--client", "aside", "--json"], f.deps)).toBe(0);
  expect(f.calls).toEqual([{ path: "/api/route-to", body: { client: "aside", action: action === "enable" ? "on" : "off" } }]);
});

test("profile-scoped actions preserve local profile addressing", async () => {
  const f = fixture();
  expect(await handleClientIntegrationCommand(["enable", "--client", "aside", "--profile", "2", "--json"], f.deps)).toBe(0);
  expect(f.calls).toEqual([{ path: "/api/client-integrations/aside/profiles/2", body: { enabled: true } }]);
});

test.each([
  { client: "pi", flags: ["--plan-fingerprint", `p9:${"a".repeat(32)}`], extra: { operation: "apply", planFingerprint: `p9:${"a".repeat(32)}` } },
  { client: "droid", flags: ["--reasoning-default", "provider/model=high"], extra: { droidReasoningDefaults: { "provider/model": "high" } } },
  { client: "droid", flags: ["--clear-reasoning-defaults"], extra: { droidReasoningDefaults: {} } },
])("policy/bound operations preserve legacy contracts: $client $flags", async ({ client, flags, extra }) => {
  const f = fixture({ ok: true, clientId: client, state: "current", changed: true });
  expect(await handleClientIntegrationCommand(["enable", "--client", client, ...flags, "--json"], f.deps)).toBe(0);
  expect(f.calls).toEqual([{ path: `/api/client-integrations/${client}`, body: { enabled: true, ...extra } }]);
});

test("plain model naming becomes durable Home intent", async () => {
  const f = fixture();
  expect(await handleClientIntegrationCommand(["enable", "--client=hermes", "--model-names=alias", "--overwrite-conflict", "--json"], f.deps)).toBe(0);
  expect(f.calls).toEqual([{ path: "/api/route-to", body: { client: "hermes", action: "on", modelNames: "alias", overwriteConflict: true } }]);
});

test("explicit profile model naming keeps its legacy scoped path", async () => {
  const f = fixture();
  expect(await handleClientIntegrationCommand(["enable", "--client", "aside", "--profile", "2", "--model-names=alias"], f.deps)).toBe(2);
  expect(f.calls).toEqual([]);
});
