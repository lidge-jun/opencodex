import { describe, expect, test } from "bun:test";
import { projectClientLinkChild } from "../../src/client/link-status";
import type { ClientLinkState } from "../../src/client/link-state";
import type { ClientLinkSupervisorStatus } from "../../src/client/link-tunnel";
import type { TunnelState } from "../../src/link/tunnel-state";

const sidecar: ClientLinkState = {
  linkId: "lnk_0123456789abcdef",
  alias: "home-mac",
  hubHostKeyFingerprint: `SHA256:${"a".repeat(43)}`,
  peerListenerPort: 45678,
  tunnelPort: 23456,
};
const NOW = Date.parse("2026-09-26T12:00:00.000Z");
const SINCE = Date.parse("2026-09-26T11:59:00.000Z");

function tunnel(state: TunnelState): ClientLinkSupervisorStatus {
  return { kind: "tunnel", linkId: sidecar.linkId, state, pid: 4242 };
}

describe("a Child's own link status", () => {
  test("is the K16 document with the Child role and no Home-side listener or links", () => {
    const status = projectClientLinkChild(sidecar, tunnel({ kind: "connected", since: SINCE }), NOW);
    expect(Object.keys(status).sort()).toEqual(["child", "links", "listener", "role"]);
    expect(status).toEqual({
      role: "child",
      listener: { state: "off", port: null },
      links: [],
      child: { alias: "home-mac", state: "connected", since: new Date(SINCE).toISOString(), reason: null },
    });
  });

  test.each([
    { state: { kind: "connecting", since: SINCE } as TunnelState, wire: "connecting", since: SINCE, reason: null },
    { state: { kind: "connected", since: SINCE } as TunnelState, wire: "connected", since: SINCE, reason: null },
    { state: { kind: "reconnecting", since: SINCE, attempt: 2, retryAt: NOW + 1_000, inFlight: false } as TunnelState, wire: "reconnecting", since: SINCE, reason: null },
    { state: { kind: "failed", since: SINCE, reason: "auth" } as TunnelState, wire: "failed", since: SINCE, reason: "auth" },
    { state: { kind: "idle" } as TunnelState, wire: "idle", since: NOW, reason: null },
  ])("maps a $wire tunnel with an ISO since and a reason only when failed", ({ state, wire, since, reason }) => {
    expect(projectClientLinkChild(sidecar, tunnel(state), NOW).child).toEqual({
      alias: "home-mac", state: wire, since: new Date(since).toISOString(), reason,
    } as never);
  });

  test("reports a stopped supervisor as idle and an unreadable sidecar as failed", () => {
    expect(projectClientLinkChild(sidecar, { kind: "stopped" }, NOW).child).toEqual({
      alias: "home-mac", state: "idle", since: new Date(NOW).toISOString(), reason: null,
    });
    const invalid = { alias: "unknown", state: "failed", since: new Date(NOW).toISOString(), reason: "sidecar_invalid" };
    expect(projectClientLinkChild("invalid", { kind: "stopped" }, NOW).child).toEqual(invalid as never);
    expect(projectClientLinkChild(sidecar, { kind: "failed", reason: "sidecar_invalid" }, NOW).child)
      .toEqual({ ...invalid, alias: "home-mac" } as never);
  });

  test("reports what the keyed probe found as the reason, whatever the tunnel state", () => {
    const connected: ClientLinkSupervisorStatus = { ...tunnel({ kind: "connected", since: SINCE }), probe: "unauthorized" };
    expect(projectClientLinkChild(sidecar, connected, NOW).child).toMatchObject({ state: "connected", reason: "unauthorized" });
    const retrying: ClientLinkSupervisorStatus = {
      ...tunnel({ kind: "failed", since: SINCE, reason: "timeout", retryAt: NOW + 60_000, inFlight: true }),
      probe: "home_unreachable",
    };
    expect(projectClientLinkChild(sidecar, retrying, NOW).child).toEqual({
      alias: "home-mac", state: "failed", since: new Date(SINCE).toISOString(), reason: "home_unreachable",
    });
  });

  test("a Home-initiated Child without a sidecar reports no child row", () => {
    expect(projectClientLinkChild(null, { kind: "stopped" }, NOW).child).toBeNull();
  });
});
