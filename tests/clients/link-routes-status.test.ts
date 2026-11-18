import { expect, test } from "bun:test";
import { attachLinkRoutes, projectLinkStatus } from "../../src/link/status-projection";
import type { LinkTunnelStatus } from "../../src/link/supervisor";
import type { LinkRecord, LinkStore } from "../../src/link/store";
import { validateStatus } from "../../src/cli/link";

const ONE: LinkRecord = {
  id: "lnk_0123456789abcdef", alias: "pen-one", direction: "hub-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnop",
  tunnelPort: 19002, apiKeyId: "key-one", createdAt: "2026-11-01T00:00:00.000Z",
};
const MULTI: LinkRecord = { ...ONE, id: "lnk_fedcba9876543210", alias: "pen-two", apiKeyId: "key-two", tunnelPort: 19003, routes: ["two-lan", "pen-two"] };
const store: LinkStore = { version: 1, listenerPort: 19001, links: [ONE, MULTI] };

const supervisorStates: LinkTunnelStatus[] = [
  { linkId: ONE.id, direction: "hub-initiated", state: { kind: "connected", since: 1_000 }, pid: 11 },
  {
    linkId: MULTI.id, direction: "hub-initiated", state: { kind: "connected", since: 2_000 }, pid: 12,
    routes: {
      routes: [
        { name: "two-lan", eligibleAt: null, lastOutcome: null },
        { name: "pen-two", eligibleAt: 9_000, lastOutcome: { class: "transient", at: 1_500 } },
      ],
      route: { name: "two-lan", index: 0, since: 2_000 },
      blocked: null,
    },
  },
];

const project = () => projectLinkStatus(store, supervisorStates, { state: "listening", port: 19001 }, { runtimeRole: "hub" }, { version: 1, entries: {} });

test("the default status document has no route fields, for one-route and multi-route links alike", () => {
  const dto = project();
  for (const link of dto.links) {
    expect("routes" in link).toBe(false);
    expect("route" in link).toBe(false);
    expect("routeBlocked" in link).toBe(false);
  }
});

test("?routes=1 adds the route in use and since when, only on links with several routes", () => {
  const dto = attachLinkRoutes(project(), supervisorStates);
  const [one, multi] = dto.links;
  expect("routes" in one!).toBe(false);
  expect(multi!.route).toEqual({ name: "two-lan", index: 0, since: new Date(2_000).toISOString() });
  expect(multi!.routes).toEqual([
    { name: "two-lan", eligibleAt: null, lastOutcome: null },
    { name: "pen-two", eligibleAt: new Date(9_000).toISOString(), lastOutcome: { class: "transient", at: new Date(1_500).toISOString() } },
  ]);
  expect(multi!.routeBlocked).toBeNull();
});

test("an unsupported ssh client reads as a failed multi-route link with that reason, in the default document too", () => {
  const blocked: LinkTunnelStatus[] = [supervisorStates[0]!, {
    linkId: MULTI.id, direction: "hub-initiated", state: { kind: "reconnecting", since: 2_000, attempt: 1, retryAt: 602_000, inFlight: false }, pid: null,
    routes: { routes: [{ name: "two-lan", eligibleAt: null, lastOutcome: null }, { name: "pen-two", eligibleAt: null, lastOutcome: null }], route: null, blocked: "ssh_client_unsupported" },
  }];
  const dto = projectLinkStatus(store, blocked, { state: "listening", port: 19001 }, { runtimeRole: "hub" }, { version: 1, entries: {} });
  expect(dto.links[1]).toMatchObject({ state: "failed", reason: "ssh_client_unsupported" });
  expect(dto.links[0]).toMatchObject({ state: "connected", reason: null });
});

test("the CLI decoder accepts route fields and still rejects malformed ones", () => {
  const document = JSON.parse(JSON.stringify(attachLinkRoutes(project(), supervisorStates)));
  const decoded = validateStatus(document);
  expect(decoded.links[1]!.route?.name).toBe("two-lan");
  expect(decoded.links[0]!.route).toBeUndefined();
  const bad = JSON.parse(JSON.stringify(document));
  bad.links[1].route = { name: "two-lan", index: "0", since: "x" };
  expect(() => validateStatus(bad)).toThrow();
  const unknownClass = JSON.parse(JSON.stringify(document));
  unknownClass.links[1].routes[1].lastOutcome.class = "guess";
  expect(() => validateStatus(unknownClass)).toThrow();
  const extra = JSON.parse(JSON.stringify(document));
  extra.links[1].routes[0].kind = "direct";
  expect(() => validateStatus(extra)).toThrow();
});


test("a row with the route fields, the traffic block and the transport block decodes with all three", () => {
  const document = JSON.parse(JSON.stringify(attachLinkRoutes(project(), supervisorStates)));
  const traffic = { since: "2026-11-12T00:00:00.000Z", epoch: "0123456789abcdef", generation: 3, requests: 1, incomplete: 0, toHomeBytes: 5, fromHomeBytes: 6,
    toHomeSource: "relayed", toHomeUncounted: 0, untrackedRequests: 0 };
  const ws = { open: 1, upgrades: 2, refused: { cap: 1 }, closes: { idle: 1 }, holds: 0 };
  document.links[1].traffic = traffic;
  document.links[1].ws = ws;
  const decoded = validateStatus(document);
  expect(decoded.links[1]!.route?.name).toBe("two-lan");
  expect(decoded.links[1]!.traffic).toEqual(traffic);
  expect(decoded.links[1]!.ws).toEqual(ws);
});
