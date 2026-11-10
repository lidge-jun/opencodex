/**
 * #8470: a Remote Link Child whose tunnel was down (a sleeping laptop, a dropped -R forward) kept
 * printing "Connection: connected" from `ocx connect status`, because that command read only the
 * durable connection record. The running Child already knows better: its /readyz carries the link
 * verdict the relay preflight produced. These tests pin how the status command reads and reports it.
 */
import { describe, expect, test } from "bun:test";
import { probeLinkTunnelStatus } from "../../src/client/link-tunnel-status";
import { clientConnectionStatusLines, type ClientConnectionStatus } from "../../src/cli/connect";
import type { LiveProxy } from "../../src/server/proxy-liveness";

const LIVE: LiveProxy = { pid: 4242, port: 10100, hostname: "127.0.0.1", source: "runtime", role: "client" };

function readyz(status: number, body: Record<string, unknown>): typeof fetch {
  return (async () => Response.json({
    service: "opencodex", version: "2.100.0", role: "client", uptime: 12, pid: 4242, port: 10100, protocolVersion: 1, ...body,
  }, { status })) as unknown as typeof fetch;
}

describe("probeLinkTunnelStatus", () => {
  test("an unavailable link in /readyz reads as down with its fixed reason", async () => {
    const result = await probeLinkTunnelStatus({
      findLive: async () => LIVE,
      fetchImpl: readyz(503, { status: "pending", link: { state: "unavailable", reason: "home_unreachable" } }),
    });
    expect(result).toEqual({ state: "down", reason: "home_unreachable" });
  });

  test("an available link reads as up", async () => {
    const result = await probeLinkTunnelStatus({
      findLive: async () => LIVE,
      fetchImpl: readyz(200, { status: "ready", link: { state: "available" } }),
    });
    expect(result).toEqual({ state: "up" });
  });

  test("no running Child runtime, or a non-client listener, is unknown rather than up", async () => {
    expect(await probeLinkTunnelStatus({ findLive: async () => null }))
      .toEqual({ state: "unknown", reason: "runtime_not_running" });
    expect(await probeLinkTunnelStatus({ findLive: async () => ({ ...LIVE, role: undefined }) }))
      .toEqual({ state: "unknown", reason: "runtime_not_running" });
  });

  test("a reason outside the fixed vocabulary is never echoed", async () => {
    const result = await probeLinkTunnelStatus({
      findLive: async () => LIVE,
      fetchImpl: readyz(503, { status: "pending", link: { state: "unavailable", reason: "\u001b]52;forged" } }),
    });
    expect(result).toEqual({ state: "unknown", reason: "runtime_unreadable" });
  });

  test("a body from another process (pid mismatch) is not trusted", async () => {
    const result = await probeLinkTunnelStatus({
      findLive: async () => LIVE,
      fetchImpl: readyz(200, { pid: 1, status: "ready", link: { state: "available" } }),
    });
    expect(result).toEqual({ state: "unknown", reason: "runtime_unreadable" });
  });

  test("a preflight still running is asked again once its verdict can be cached", async () => {
    const bodies = [
      { status: 503, body: { status: "pending", link: { state: "unavailable", reason: "link_unverified" } } },
      { status: 503, body: { status: "pending", link: { state: "unavailable", reason: "home_unreachable" } } },
    ];
    const delays: number[] = [];
    let calls = 0;
    const fetchImpl = (async () => {
      const next = bodies[Math.min(calls++, bodies.length - 1)]!;
      return readyz(next.status, next.body)("http://x");
    }) as unknown as typeof fetch;
    const result = await probeLinkTunnelStatus({
      findLive: async () => LIVE,
      fetchImpl,
      delay: async ms => { delays.push(ms); },
    });
    expect(calls).toBe(2);
    expect(delays).toHaveLength(1);
    expect(result).toEqual({ state: "down", reason: "home_unreachable" });
  });

  test("a preflight that never settles is unknown, not down", async () => {
    const result = await probeLinkTunnelStatus({
      findLive: async () => LIVE,
      fetchImpl: readyz(503, { status: "pending", link: { state: "unavailable", reason: "link_unverified" } }),
      delay: async () => {},
    });
    expect(result).toEqual({ state: "unknown", reason: "link_unverified" });
  });
});

describe("connect status lines", () => {
  const base: ClientConnectionStatus = {
    state: "connected", serverUrl: "http://127.0.0.1:40123", managementUrl: "http://127.0.0.1:40123",
    managementTransport: "direct", transport: "link", protocolVersion: 1, apiKeyId: "k1",
    selectedClients: ["codex"], connectedAt: "2026-11-10T00:00:00.000Z", catalog: "present",
    token: "owned", rotation: "clean", readiness: "ready",
  };

  test("a link Child states its tunnel right after the local verdict", () => {
    const lines = clientConnectionStatusLines({ ...base, linkTunnel: { state: "down", reason: "home_unreachable" } });
    expect(lines[0]).toBe("Connection: connected");
    expect(lines[1]).toContain("Local Codex CLI: ready");
    expect(lines[2]).toBe("Link tunnel: down (home_unreachable)");
    expect(clientConnectionStatusLines({ ...base, linkTunnel: { state: "up" } })[2]).toBe("Link tunnel: up");
  });

  test("a hub client prints no tunnel line", () => {
    const lines = clientConnectionStatusLines({ ...base, transport: "hub" });
    expect(lines.some(line => line.startsWith("Link tunnel"))).toBe(false);
  });
});
