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
