import { describe, expect, test } from "bun:test";
import { EXPORT_CLIENT_IDS } from "../../src/clients/client-ids";
import { parseHomeRouteIntentDocument, projectHomeRouteIntent, ROUTE_CLIENT_IDS, routeIntentDigest } from "../../src/link/route-intent";

const config = {} as never;
describe("Home route intent contract", () => {
  test("all routable clients with builtin defaults; policy precedence is device > default > builtin", () => {
    const base = projectHomeRouteIntent(config, "test");
    expect(ROUTE_CLIENT_IDS).toEqual(["codex", "claude", "claude-desktop", "grok", ...EXPORT_CLIENT_IDS]);
    expect(base.clients.codex).toEqual({ enabled: true });
    expect(base.clients.claude).toEqual({ enabled: true });
    expect(base.clients.aside).toEqual({ enabled: false });
    const state = { version: 1 as const, defaults: { aside: { enabled: true, accounts: "all" as const } }, devices: { child: { aside: { enabled: true, accounts: ["user-b"] } } } };
    const home = projectHomeRouteIntent(config, "test", undefined, state);
    const child = projectHomeRouteIntent(config, "test", "child", state);
    expect(home.clients.aside).toEqual({ enabled: true, accounts: "all" });
    expect(home.sources.aside).toBe("default");
    expect(child.clients.aside).toEqual({ enabled: true, accounts: ["user-b"] });
    expect(child.sources.aside).toBe("device");
    expect(child.sources.codex).toBe("builtin");
  });
  test("strict parser rejects paths, ports, secrets, slots, unknown or missing clients and unsafe labels", () => {
    const doc = projectHomeRouteIntent(config, "test");
    expect(parseHomeRouteIntentDocument(doc)).toEqual(doc);
    for (const extra of [{ path: "/tmp/client" }, { apiKey: "secret" }, { port: 10100 }, { profileId: "u0" }]) {
      expect(parseHomeRouteIntentDocument({ ...doc, ...extra })).toBeNull();
      expect(parseHomeRouteIntentDocument({ ...doc, clients: { ...doc.clients, aside: { enabled: true, ...extra } } })).toBeNull();
    }
    for (const accounts of [["u/0"], ["../escape"], ["/tmp/path"], ["user", "user"], ["user\n"]]) {
      expect(parseHomeRouteIntentDocument({ ...doc, clients: { ...doc.clients, aside: { enabled: true, accounts } } })).toBeNull();
    }
    const { codex: _, ...missing } = doc.clients;
    expect(parseHomeRouteIntentDocument({ ...doc, clients: missing })).toBeNull();
    expect(parseHomeRouteIntentDocument({ ...doc, clients: { ...doc.clients, unknown: { enabled: true } } })).toBeNull();
    expect(parseHomeRouteIntentDocument({ ...doc, home: { name: "bad\nname", version: "test" } })).toBeNull();
    expect(parseHomeRouteIntentDocument({ ...doc, clients: { ...doc.clients, pi: { enabled: true, accounts: "all" } } })).toBeNull();
  });
  test("digest canonically covers policies and sources, ignores labels and account ordering", () => {
    const doc = projectHomeRouteIntent(config, "test");
    // Independently computed using Python hashlib/json over the documented wire order.
    expect(routeIntentDigest(doc)).toBe("afcea5dd5c7c45071fe8c1620c98985cd460475ebc986e8cefe3df9a4f2d2dd7");
    doc.clients.aside = { enabled: true, modelNames: "alias", accounts: ["user-b", "user-a"] };
    const reordered = { ...doc, home: { name: "renamed", version: "new" }, clients: Object.fromEntries(Object.entries(doc.clients).reverse()) };
    reordered.clients.aside = { accounts: ["user-a", "user-b"], modelNames: "alias", enabled: true };
    expect(routeIntentDigest(reordered as typeof doc)).toBe(routeIntentDigest(doc));
    expect(routeIntentDigest({ ...doc, sources: { ...doc.sources, aside: "device" } })).not.toBe(routeIntentDigest(doc));
    expect(routeIntentDigest({ ...doc, clients: { ...doc.clients, aside: { enabled: false } } })).not.toBe(routeIntentDigest(doc));
  });
});

test("device switch inherits unspecified Home account and model-name policy", () => {
  const state = { version: 1 as const, defaults: { aside: { enabled: true, accounts: "all" as const, modelNames: "alias" as const } }, devices: { child: { aside: { enabled: false } } } };
  expect(projectHomeRouteIntent(config, "test", "child", state).clients.aside).toEqual({ enabled: false, accounts: "all", modelNames: "alias" });
});
