import { afterEach, beforeEach, expect, test } from "bun:test";
import { CloudflareApi } from "../src/cloudflare";
import type { PlatformConfig } from "../src/config";

const originalFetch = globalThis.fetch;
let requests: Array<{ body?: BodyInit | null; headers: Headers; method: string; url: string }>;

function config(overrides: Partial<PlatformConfig> = {}): PlatformConfig {
  return {
    CLOUDFLARE_ACCOUNT_ID: "account-id",
    CLOUDFLARE_ZONE_ID: "zone-id",
    CLOUDFLARE_API_BASE_URL: "https://api.cloudflare.test/client/v4",
    cloudflareApiToken: "test-credential",
    ...overrides,
  } as PlatformConfig;
}

beforeEach(() => {
  requests = [];
  globalThis.fetch = (async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    requests.push({ body: init.body, headers: new Headers(init.headers), method, url });
    const result = url.endsWith("/token")
      ? "tunnel-token"
      : { id: "resource-id", token: "created-token" };
    return Response.json({ success: true, errors: [], result });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("Cloudflare Global API Key uses email/key headers without a bearer token", async () => {
  const api = new CloudflareApi(config({ cloudflareAuthEmail: "admin@example.test" }));
  expect(await api.createTunnel("phase0")).toEqual({ id: "resource-id", token: "created-token" });

  const request = requests[0];
  expect(request.headers.get("x-auth-email")).toBe("admin@example.test");
  expect(request.headers.get("x-auth-key")).toBe("test-credential");
  expect(request.headers.get("authorization")).toBeNull();
});

test("Cloudflare scoped token keeps bearer authentication", async () => {
  const api = new CloudflareApi(config());
  await api.createPrivateHostnameRoute("tunnel-id", "private.ocxr.internal");

  const request = requests[0];
  expect(request.headers.get("authorization")).toBe("Bearer test-credential");
  expect(request.headers.get("x-auth-email")).toBeNull();
  expect(request.headers.get("x-auth-key")).toBeNull();
});

test("Tunnel token retrieval uses the current GET endpoint", async () => {
  const api = new CloudflareApi(config());
  expect(await api.getTunnelToken("tunnel-id")).toBe("tunnel-token");
  expect(requests[0].method).toBe("GET");
  expect(requests[0].url).toEndWith("/accounts/account-id/cfd_tunnel/tunnel-id/token");
});

test("Tunnel shutdown centrally removes every live connector before deletion", async () => {
  const api = new CloudflareApi(config());
  await api.cleanupTunnelConnections("tunnel-id");
  await api.deleteTunnel("tunnel-id");

  expect(requests[0].method).toBe("DELETE");
  expect(requests[0].url).toEndWith("/accounts/account-id/cfd_tunnel/tunnel-id/connections");
  expect(requests[1].method).toBe("DELETE");
  expect(requests[1].url).toEndWith("/accounts/account-id/cfd_tunnel/tunnel-id");
});

test("private hostname provisioning uses DNS-only A and narrow CIDR routes", async () => {
  const api = new CloudflareApi(config());
  expect(await api.createPrivateDnsRecord("random.private.example.test", "10.200.1.9")).toBe("resource-id");
  expect(await api.createCidrActivationRoute("tunnel-id", "10.200.1.9")).toBe("resource-id");

  expect(requests[0].url).toEndWith("/zones/zone-id/dns_records");
  expect(requests[0].method).toBe("POST");
  expect(JSON.parse(String(requests[0].body))).toMatchObject({
    type: "A",
    name: "random.private.example.test",
    content: "10.200.1.9",
    proxied: false,
  });
  expect(requests[1].url).toEndWith("/accounts/account-id/teamnet/routes");
  expect(requests[1].method).toBe("POST");
  expect(JSON.parse(String(requests[1].body))).toMatchObject({
    network: "10.200.1.9/32",
    tunnel_id: "tunnel-id",
  });
});
