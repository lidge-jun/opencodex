import { describe, expect, test } from "bun:test";
import {
  CloudflareProvisionError,
  provisionCloudflareNamedTunnel,
} from "../src/server/cloudflare-provision";
import { CLOUDFLARE_TUNNEL_ORIGIN_HOST } from "../src/server/cloudflare-tunnel";

const accountId = "a".repeat(32);
const zoneId = "b".repeat(32);
const dnsRecordId = "c".repeat(32);
const tunnelId = "11111111-2222-4333-8444-555555555555";
const apiToken = `cf-api-${"s".repeat(40)}`;
const tunnelToken = `eyJ${"t".repeat(64)}`;
const apiBase = "https://api.cloudflare.com/client/v4";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function ok(result: unknown): Response {
  return Response.json({ success: true, result });
}

describe("Cloudflare Named Tunnel provisioning", () => {
  test("performs the four API steps with protected ingress and proxied tunnel DNS", async () => {
    const calls: FetchCall[] = [];
    const responses = [
      ok({ id: tunnelId }),
      ok({}),
      ok({ id: dnsRecordId }),
      ok(tunnelToken),
    ];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    }) as typeof fetch;

    const result = await provisionCloudflareNamedTunnel({
      apiToken,
      accountId,
      zoneId,
      hostname: "api.example.com",
      tunnelName: "opencodex-test",
    }, "http://127.0.0.1:10100", { fetchFn, timeoutMs: 1_000 });

    expect(result).toEqual({
      publicUrl: "https://api.example.com",
      tunnelToken,
      tunnelId,
      dnsRecordId,
    });
    expect(JSON.stringify(result)).not.toContain(apiToken);
    expect(calls.map(call => [call.init.method, call.url])).toEqual([
      ["POST", `${apiBase}/accounts/${accountId}/cfd_tunnel`],
      ["PUT", `${apiBase}/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`],
      ["POST", `${apiBase}/zones/${zoneId}/dns_records`],
      ["GET", `${apiBase}/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`],
    ]);
    for (const call of calls) {
      expect(new Headers(call.init.headers).get("Authorization")).toBe(`Bearer ${apiToken}`);
    }
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      name: "opencodex-test",
      config_src: "cloudflare",
    });
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      config: {
        ingress: [
          {
            hostname: "api.example.com",
            service: "http://127.0.0.1:10100",
            originRequest: { httpHostHeader: CLOUDFLARE_TUNNEL_ORIGIN_HOST },
          },
          { service: "http_status:404" },
        ],
      },
    });
    expect(JSON.parse(String(calls[2].init.body))).toEqual({
      type: "CNAME",
      proxied: true,
      name: "api.example.com",
      content: `${tunnelId}.cfargotunnel.com`,
    });
  });

  test("rolls back DNS and tunnel resources when the final token request fails", async () => {
    const calls: FetchCall[] = [];
    let requestIndex = 0;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      requestIndex += 1;
      if (requestIndex === 1) return ok({ id: tunnelId });
      if (requestIndex === 2) return ok({});
      if (requestIndex === 3) return ok({ id: dnsRecordId });
      if (requestIndex === 4) {
        return Response.json({ success: false, errors: [{ message: "token request denied" }] }, { status: 403 });
      }
      return ok({});
    }) as typeof fetch;

    await expect(provisionCloudflareNamedTunnel({
      apiToken,
      accountId,
      zoneId,
      hostname: "api.example.com",
      tunnelName: "opencodex-test",
    }, "http://127.0.0.1:10100", { fetchFn, timeoutMs: 1_000 }))
      .rejects.toEqual(new CloudflareProvisionError("token request denied"));

    expect(calls.slice(-2).map(call => [call.init.method, call.url])).toEqual([
      ["DELETE", `${apiBase}/zones/${zoneId}/dns_records/${dnsRecordId}`],
      ["DELETE", `${apiBase}/accounts/${accountId}/cfd_tunnel/${tunnelId}`],
    ]);
    for (const call of calls.slice(-2)) {
      expect(new Headers(call.init.headers).get("Authorization")).toBe(`Bearer ${apiToken}`);
    }
  });

  test("rejects invalid inputs before contacting Cloudflare", async () => {
    let requests = 0;
    const fetchFn = (async () => {
      requests += 1;
      return ok({});
    }) as typeof fetch;

    await expect(provisionCloudflareNamedTunnel({
      apiToken: "short",
      accountId,
      zoneId,
      hostname: "api.example.com",
    }, "http://127.0.0.1:10100", { fetchFn })).rejects.toBeInstanceOf(CloudflareProvisionError);
    await expect(provisionCloudflareNamedTunnel({
      apiToken,
      accountId: "not-an-account-id",
      zoneId,
      hostname: "api.example.com",
    }, "http://127.0.0.1:10100", { fetchFn })).rejects.toBeInstanceOf(CloudflareProvisionError);
    await expect(provisionCloudflareNamedTunnel({
      apiToken,
      accountId,
      zoneId,
      hostname: "http://127.0.0.1",
    }, "http://127.0.0.1:10100", { fetchFn })).rejects.toBeInstanceOf(CloudflareProvisionError);
    expect(requests).toBe(0);
  });

  test("redacts the API token even if an upstream error unexpectedly reflects it", async () => {
    const fetchFn = (async () => Response.json({
      success: false,
      errors: [{ message: `permission denied for ${apiToken}` }],
    }, { status: 403 })) as typeof fetch;

    let error: unknown;
    try {
      await provisionCloudflareNamedTunnel({
        apiToken,
        accountId,
        zoneId,
        hostname: "api.example.com",
        tunnelName: "opencodex-test",
      }, "http://127.0.0.1:10100", { fetchFn, timeoutMs: 1_000 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CloudflareProvisionError);
    expect(String((error as Error).message)).not.toContain(apiToken);
    expect(String((error as Error).message)).toContain("[redacted]");
  });
});
