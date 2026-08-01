import { expect, test } from "bun:test";
import { CloudflareApi } from "../src/cloudflare";
import type { PlatformConfig } from "../src/config";

const enabled = process.env.CLOUDFLARE_LIVE_TESTS === "true";
const liveTest = enabled ? test : test.skip;

liveTest("Cloudflare creates and removes an isolated Tunnel hostname route", async () => {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const credential = process.env.CLOUDFLARE_API_TOKEN;
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  const privateDomain = process.env.CLOUDFLARE_LIVE_TEST_DOMAIN;
  if (!accountId || !credential || !zoneId || !privateDomain) {
    throw new Error("Cloudflare live-test account, credential, zone, and private domain are required");
  }

  const api = new CloudflareApi({
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_ZONE_ID: zoneId,
    CLOUDFLARE_API_BASE_URL: "https://api.cloudflare.com/client/v4",
    cloudflareApiToken: credential,
    cloudflareAuthEmail: process.env.CLOUDFLARE_AUTH_EMAIL,
  } as PlatformConfig);
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const tunnel = await api.createTunnel(`ocxr-phase0-api-${suffix}`);
  let routeId: string | null = null;
  let cidrRouteId: string | null = null;
  let dnsRecordId: string | null = null;
  try {
    expect(tunnel.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(tunnel.token.length).toBeGreaterThan(32);
    expect(await api.getTunnelToken(tunnel.id)).toBe(tunnel.token);

    const originIp = `10.223.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`;
    const hostname = `phase0-${suffix}.${privateDomain}`;
    dnsRecordId = await api.createPrivateDnsRecord(hostname, originIp);
    cidrRouteId = await api.createCidrActivationRoute(tunnel.id, originIp);
    routeId = await api.createPrivateHostnameRoute(tunnel.id, hostname);
    expect(dnsRecordId).toMatch(/^[0-9a-f]{32}$/);
    expect(cidrRouteId).toMatch(/^[0-9a-f-]{36}$/);
    expect(routeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await api.listActiveConnections(tunnel.id)).toBe(0);
  } finally {
    const cleanup = await Promise.allSettled([
      ...(routeId ? [api.disablePrivateHostnameRoute(routeId)] : []),
      ...(cidrRouteId ? [api.deleteCidrActivationRoute(cidrRouteId)] : []),
      ...(dnsRecordId ? [api.deletePrivateDnsRecord(dnsRecordId)] : []),
    ]);
    await api.cleanupTunnelConnections(tunnel.id);
    await api.deleteTunnel(tunnel.id);
    const failed = cleanup.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}, 30_000);
