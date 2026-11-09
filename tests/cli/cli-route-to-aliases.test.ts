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
      return Response.json(response ?? { schema: "ocx.route-to/1", devices: [{ id: "home", clients: ["hermes", "codex", "aside"].map(client => ({ client, intent: "on", source: "default", applied: "current" })) }] });
    }) as typeof fetch,
  } };
}

test.each(["on", "off"])("native %s stays a Home-only decision through the native route", async action => {
  const f = fixture({ ok: true, clientId: "claude-desktop", changed: true, state: action === "on" ? "current" : "absent", desiredEnabled: action === "on", message: "ok" });
  expect(await handleIntegrationCommand(["native", "claude-desktop", action, "--json"], f.deps)).toBe(0);
  // The native route records a Home override and runs Desktop's own first-party transition.
  expect(f.calls).toEqual([{ path: "/api/native-integrations/claude-desktop", body: { enabled: action === "on" } }]);
});

test("native on a Child is refused with the Home device command", async () => {
  const f = fixture();
  const deps = { ...f.deps, readChildContext: () => ({ connection: {} as never, linkId: "lnk_0123456789abcdef", homePhrase: "the Home" }) };
  expect(await handleIntegrationCommand(["native", "codex", "off"], deps)).toBe(5);
  expect(f.calls).toEqual([]);
  expect(err.mock.calls.flat().join("\n")).toContain("ocx route to codex off --device lnk_0123456789abcdef");
});

// Like the dashboard toggle, a plain toggle is this Home's own decision; ocx route to changes the Children's default.
test.each(["enable", "disable"])("plain client %s is a Home-only decision", async action => {
  const f = fixture({ ok: true, clientId: "pi", state: "current", changed: true });
  expect(await handleClientIntegrationCommand([action, "--client", "pi", "--json"], { ...f.deps, readChildContext: () => null } as never)).toBe(0);
  expect(f.calls).toEqual([{ path: "/api/client-integrations/pi", body: { enabled: action === "enable" } }]);
  expect(err.mock.calls.flat().join("\n")).toContain("linked Children keep their route defaults (ocx route to <client> on|off changes those)");
});

test("plain client enable on a Child is refused with the Home command", async () => {
  const f = fixture();
  const deps = { ...f.deps, readChildContext: () => ({ connection: {} as never, linkId: "lnk_0123456789abcdef", homePhrase: "the Home" }) };
  expect(await handleClientIntegrationCommand(["enable", "--client", "pi"], deps as never)).toBe(5);
  expect(f.calls).toEqual([]);
  expect(err.mock.calls.flat().join("\n")).toContain("ocx route to pi on --device lnk_0123456789abcdef");
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


test("explicit profile model naming keeps its legacy scoped path", async () => {
  const f = fixture();
  expect(await handleClientIntegrationCommand(["enable", "--client", "aside", "--profile", "2", "--model-names=alias"], f.deps)).toBe(2);
  expect(f.calls).toEqual([]);
});

test("plain model naming is a Home-only decision too", async () => {
  const f = fixture({ ok: true, clientId: "hermes", state: "current", changed: true });
  expect(await handleClientIntegrationCommand(["enable", "--client=hermes", "--model-names=alias", "--overwrite-conflict", "--json"], { ...f.deps, readChildContext: () => null } as never)).toBe(0);
  expect(f.calls).toEqual([{ path: "/api/client-integrations/hermes", body: { enabled: true, modelNames: "alias", overwriteConflict: true } }]);
});
