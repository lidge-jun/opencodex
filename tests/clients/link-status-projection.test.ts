import { expect, test } from "bun:test";
import { projectLinkStatus } from "../../src/link/status-projection";
import type { LinkStore } from "../../src/link/store";
import type { CompensationStore } from "../../src/link/compensation";

const store: LinkStore = {
  version: 1,
  listenerPort: 19001,
  links: [{
    id: "lnk_0123456789abcdef",
    alias: "home.example",
    direction: "hub-initiated",
    hostKeyFingerprint: "SHA256:abcdefghijklmnop",
    tunnelPort: 19002,
    apiKeyId: "key-1",
    createdAt: "2026-09-25T00:00:00.000Z",
  }],
};

test("projects tunnel state and listener status into K16", () => {
  const dto = projectLinkStatus(store, [{
    linkId: store.links[0]!.id,
    direction: "hub-initiated",
    state: { kind: "connected", since: Date.parse("2026-09-25T00:01:00.000Z") },
    pid: 123,
  }], { state: "listening", port: 19001 }, { runtimeRole: "hub" });
  expect(dto).toEqual({
    role: "home",
    listener: { state: "listening", port: 19001 },
    links: [{
      id: "lnk_0123456789abcdef",
      alias: "home.example",
      direction: "hub-initiated",
      state: "connected",
      since: "2026-09-25T00:01:00.000Z",
      reason: null,
      tunnelPort: 19002,
    }],
    child: null,
  });
});

test("runtime role client projects to child without leaking internal fields", () => {
  const dto = projectLinkStatus(store, [], { state: "off", port: null }, { runtimeRole: "client" });
  expect(dto.role).toBe("child");
  expect(dto.child).toEqual({ alias: "home.example", state: "idle", since: store.links[0]!.createdAt, reason: null });
  expect(Object.keys(dto)).toEqual(["role", "listener", "links", "child"]);
});

test("an unverified orphan is exposed as a failed stale tunnel", () => {
  const dto = projectLinkStatus(store, [{
    linkId: store.links[0]!.id,
    direction: "hub-initiated",
    state: { kind: "idle" },
    pid: null,
    orphan: "orphan-unverified",
  }], { state: "failed", port: null }, { runtimeRole: "standalone" });
  expect(dto.links[0]).toMatchObject({ state: "failed", reason: "stale tunnel may hold the port" });
});

test("projects a persisted compensation failure across supervisor restarts", () => {
  const compensation: CompensationStore = {
    version: 1,
    entries: { [store.links[0]!.id]: { reason: "compensation_failed", since: "2026-09-25T00:02:00.000Z" } },
  };
  const dto = projectLinkStatus(store, [], { state: "listening", port: 19001 }, { runtimeRole: "hub" }, compensation);
  expect(dto.links[0]).toMatchObject({ state: "failed", since: "2026-09-25T00:02:00.000Z", reason: "compensation_failed" });
});

test("a client caller's invalid-sidecar child overrides the record, and only in the client role", () => {
  const empty: CompensationStore = { version: 1, entries: {} };
  const invalid = { alias: "unknown", state: "failed" as const, since: "2026-09-25T00:00:00.000Z", reason: "sidecar_invalid" };
  const client = projectLinkStatus(store, [], { state: "off", port: null }, { runtimeRole: "client" }, empty, invalid);
  expect(client.role).toBe("child");
  expect(client.child).toEqual(invalid);
  const hub = projectLinkStatus(store, [], { state: "listening", port: 19001 }, { runtimeRole: "hub" }, empty, invalid);
  expect(hub.child).toBeNull();
});

test.each(["connected", "reconnecting", "failed"] as const)("an empty-store Home-initiated Child projects %s from its client status", state => {
  const clientChild = { alias: "Home", state, since: "2026-09-25T00:01:00.000Z", reason: state === "failed" ? "sidecar_invalid" : null };
  const dto = projectLinkStatus({ ...store, links: [] }, [], { state: "off", port: null }, {
    runtimeRole: "client",
    client: { transport: "link", serverUrl: "http://127.0.0.1:19002", connectedAt: store.links[0]!.createdAt,
      link: { linkId: store.links[0]!.id, tunnelPort: 19002 } },
  }, { version: 1, entries: {} }, clientChild);
  expect(dto).toEqual({
    role: "child", listener: { state: "off", port: null },
    links: [{ id: store.links[0]!.id, direction: "hub-initiated", tunnelPort: 19002, ...clientChild }],
    child: clientChild,
  });
});

test("an empty-store link config identifies a Child without claiming a live tunnel", () => {
  const config = { runtimeRole: "client" as const,
    client: { transport: "link" as const, serverUrl: "http://127.0.0.1:19002", connectedAt: store.links[0]!.createdAt,
      link: { linkId: store.links[0]!.id, tunnelPort: 19002 } } };
  const dto = projectLinkStatus({ ...store, links: [] }, [], { state: "off", port: null }, config, { version: 1, entries: {} });
  expect(dto.child).toEqual({ alias: "http://127.0.0.1:19002", state: "idle", since: store.links[0]!.createdAt, reason: null });
  expect(dto.links[0]).toMatchObject({ direction: "hub-initiated", tunnelPort: 19002, state: "idle" });
  expect(projectLinkStatus({ ...store, links: [] }, [], { state: "off", port: null }, {
    ...config, runtimeRole: "standalone",
  }, { version: 1, entries: {} }).role).toBe("standalone");
});
