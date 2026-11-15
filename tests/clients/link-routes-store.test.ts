import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { effectiveLinkRoutes, LinkStoreError, MAX_LINK_ROUTES, parseLinkStore, type LinkStore } from "../../src/link/store";
import { fixturePath } from "../helpers/repo-root";

/** A store as an origin/dev Home writes it: no routes field. */
function oneRouteStore(): LinkStore {
  return {
    version: 1,
    listenerPort: 20100,
    links: [{
      id: "lnk_0123456789abcdef",
      alias: "pen-alpha",
      direction: "hub-initiated",
      hostKeyFingerprint: "SHA256:ABCDEFGHIJKLMNOP",
      tunnelPort: 10100,
      apiKeyId: "data-key-id",
      createdAt: "2026-09-25T00:00:00.000Z",
    }],
  };
}

function withRoutes(routes: unknown, mutate: (link: Record<string, unknown>) => void = () => {}): string {
  const store = oneRouteStore() as unknown as { links: Record<string, unknown>[] };
  store.links[0]!.routes = routes;
  mutate(store.links[0]!);
  return JSON.stringify(store);
}

/**
 * The record keys an origin/dev reader accepts (RECORD_KEYS in src/link/store.ts before routes existed).
 * A Home downgraded to such a release must still read every one-route link a newer Home writes.
 */
const OLD_READER_RECORD_KEYS = ["id", "alias", "direction", "hostKeyFingerprint", "tunnelPort", "apiKeyId", "createdAt", "remotePlatform", "childKind"];

test("a multi-route record parses and keeps its order, direct routes first", () => {
  const store = parseLinkStore(withRoutes(["alpha-lan", "alpha-tailnet", "pen-alpha"]));
  expect(store.links[0]!.routes).toEqual(["alpha-lan", "alpha-tailnet", "pen-alpha"]);
  expect(effectiveLinkRoutes(store.links[0]!)).toEqual(["alpha-lan", "alpha-tailnet", "pen-alpha"]);
});

test("a one-route link has no routes field and its effective route is the alias", () => {
  const store = parseLinkStore(JSON.stringify(oneRouteStore()));
  expect("routes" in store.links[0]!).toBe(false);
  expect(effectiveLinkRoutes(store.links[0]!)).toEqual(["pen-alpha"]);
});

test("routes equal to the alias alone normalize to the old one-route record", () => {
  const store = parseLinkStore(withRoutes(["pen-alpha"]));
  expect("routes" in store.links[0]!).toBe(false);
  expect(JSON.stringify(store, null, 2)).toBe(JSON.stringify(oneRouteStore(), null, 2));
});

test("a one-route store keeps the exact bytes and keys an origin/dev reader accepts", () => {
  const expected = readFileSync(fixturePath("link", "links-one-route.json"), "utf8");
  const store = parseLinkStore(expected);
  expect(JSON.stringify(store, null, 2) + "\n").toBe(expected);
  for (const link of store.links) {
    for (const key of Object.keys(link)) expect(OLD_READER_RECORD_KEYS).toContain(key);
  }
});

test.each([
  ["a route list without the alias", ["alpha-lan"]],
  ["a route ssh would read as an option", ["-oProxyCommand=sh", "pen-alpha"]],
  ["a route with whitespace", ["alpha lan", "pen-alpha"]],
  ["a duplicate route", ["alpha-lan", "alpha-lan", "pen-alpha"]],
  ["an empty list", []],
  ["a non-string route", [7, "pen-alpha"]],
  ["more routes than the limit", [...Array.from({ length: MAX_LINK_ROUTES }, (_, i) => "r" + i), "pen-alpha"]],
  ["routes that are not a list", "pen-alpha"],
] as const)("%s is refused", (_label, routes) => {
  expect(() => parseLinkStore(withRoutes(routes))).toThrow(new LinkStoreError("links[0].routes is invalid"));
});

test("routes on a Child-initiated link are refused: the Home never opens SSH to it", () => {
  const text = withRoutes(["alpha-lan", "pen-alpha"], link => {
    link.direction = "client-initiated";
    link.hostKeyFingerprint = null;
  });
  expect(() => parseLinkStore(text)).toThrow(new LinkStoreError("links[0].routes is invalid"));
});

test("the limit admits exactly MAX_LINK_ROUTES routes", () => {
  const routes = [...Array.from({ length: MAX_LINK_ROUTES - 1 }, (_, i) => "r" + i), "pen-alpha"];
  expect(parseLinkStore(withRoutes(routes)).links[0]!.routes).toEqual(routes);
});
