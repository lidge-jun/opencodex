import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import {
  hasValidApiAuth,
  isRequestApiAuthRequired,
  requireResponsesApiAuth,
} from "../src/server/auth-cors";
import {
  CLOUDFLARE_TUNNEL_ORIGIN_HOST,
  isCloudflareTunnelRequest,
} from "../src/server/cloudflare-tunnel";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";

const previousHome = process.env.OPENCODEX_HOME;
const previousPublicUrl = process.env.OPENCODEX_CLOUDFLARE_PUBLIC_URL;
const tempDirs: string[] = [];

function tunnelConfig(): OcxConfig {
  return {
    port: 10100,
    hostname: "127.0.0.1",
    defaultProvider: "test",
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "https://api.example.test/v1",
        apiKey: "provider-secret",
        liveModels: false,
        models: ["test-model"],
      },
    },
    apiKeys: [{ id: "public", name: "public", key: "ocx_public_secret", createdAt: "2026-01-01T00:00:00.000Z" }],
  };
}

function tunnelRequest(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://${CLOUDFLARE_TUNNEL_ORIGIN_HOST}${path}`, { headers });
}

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousPublicUrl === undefined) delete process.env.OPENCODEX_CLOUDFLARE_PUBLIC_URL;
  else process.env.OPENCODEX_CLOUDFLARE_PUBLIC_URL = previousPublicUrl;
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("Cloudflare tunnel security boundary", () => {
  test("tunnel marker forces admission auth while ordinary loopback remains local", () => {
    const config = tunnelConfig();
    const local = new Request("http://127.0.0.1:10100/v1/responses");
    const publicRequest = tunnelRequest("/v1/responses");

    expect(isRequestApiAuthRequired(local, config)).toBe(false);
    expect(hasValidApiAuth(local, config)).toBe(true);
    expect(isRequestApiAuthRequired(publicRequest, config)).toBe(true);
    expect(hasValidApiAuth(publicRequest, config)).toBe(false);
    expect(hasValidApiAuth(tunnelRequest("/v1/responses", {
      "x-opencodex-api-key": "ocx_public_secret",
    }), config)).toBe(true);
  });

  test("recognizes edge headers and canonical dotted hostnames as public ingress", () => {
    const config = tunnelConfig();
    const edgeMarked = new Request("http://127.0.0.1:10100/v1/responses", {
      headers: { "cf-ray": "test-ray" },
    });
    expect(isCloudflareTunnelRequest(edgeMarked)).toBe(true);
    expect(isRequestApiAuthRequired(edgeMarked, config)).toBe(true);

    process.env.OPENCODEX_CLOUDFLARE_PUBLIC_URL = "https://ocx.example.com";
    const dottedHost = new Request("http://127.0.0.1:10100/v1/responses", {
      headers: { Host: "ocx.example.com." },
    });
    expect(isCloudflareTunnelRequest(dottedHost)).toBe(true);
    expect(hasValidApiAuth(dottedHost, config)).toBe(false);
  });

  test("Responses keeps its dedicated admission header so caller bearer credentials remain separate", () => {
    const config = tunnelConfig();
    expect(requireResponsesApiAuth(tunnelRequest("/v1/responses", {
      authorization: "Bearer ocx_public_secret",
    }), config)?.status).toBe(401);
    expect(requireResponsesApiAuth(tunnelRequest("/v1/responses", {
      authorization: "Bearer caller-upstream-token",
      "x-opencodex-api-key": "ocx_public_secret",
    }), config)).toBeNull();
  });

  test("public ingress rejects management and GUI routes before they reach local handlers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencodex-cloudflare-security-"));
    tempDirs.push(dir);
    process.env.OPENCODEX_HOME = dir;
    const config = tunnelConfig();
    config.port = 0;
    saveConfig(config);
    const server = startServer(0);

    try {
      for (const path of ["/", "/api/config", "/api/stop", "/healthz"]) {
        const response = await fetch(new URL(path, server.url), {
          method: path === "/api/stop" ? "POST" : "GET",
          headers: { Host: CLOUDFLARE_TUNNEL_ORIGIN_HOST },
        });
        expect(response.status).toBe(404);
      }

      const unauthorized = await fetch(new URL("/v1/models", server.url), {
        headers: { Host: CLOUDFLARE_TUNNEL_ORIGIN_HOST },
      });
      expect(unauthorized.status).toBe(401);

      const hiddenByEdgeMarker = await fetch(new URL("/api/config", server.url), {
        headers: { "cf-ray": "test-ray" },
      });
      expect(hiddenByEdgeMarker.status).toBe(404);

      const authorized = await fetch(new URL("/v1/models", server.url), {
        headers: {
          Host: CLOUDFLARE_TUNNEL_ORIGIN_HOST,
          "x-opencodex-api-key": "ocx_public_secret",
        },
      });
      expect(authorized.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });
});
