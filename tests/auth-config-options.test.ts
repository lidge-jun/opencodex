import { describe, expect, test } from "bun:test";
import { isAllowedManagementOrigin } from "../src/server/auth-cors";
import { requireManagementAuth } from "../src/server/management-auth";
import { validateConfigCandidate } from "../src/config";
import type { OcxConfig } from "../src/types";

function config(partial: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    hostname: "0.0.0.0",
    providers: {},
    ...partial,
  } as OcxConfig;
}

const readyState = {
  available: true as const,
  token: "secret-admin-token",
  source: "environment" as const,
  sessions: new Map(),
  pairingGrants: new Map(),
};

describe("managementAuthDisabled: opt-in admin-token bypass", () => {
  test("loopback bind + flag on bypasses admin-token check", () => {
    const req = new Request("http://127.0.0.1:10100/api/settings", {
      method: "GET",
      headers: { Host: "127.0.0.1:10100" },
    });
    // No admin token header at all. Without the flag, this returns 401.
    expect(
      requireManagementAuth(req, readyState, config({
        hostname: "127.0.0.1",
        managementAuthDisabled: true,
      })),
    ).toBeNull();
  });

  test("non-loopback bind + flag on still rejects (no bypass)", () => {
    const req = new Request("http://0.0.0.0:10100/api/settings", {
      method: "GET",
      headers: { Host: "proxy.example.com" },
    });
    const result = requireManagementAuth(req, readyState, config({
      hostname: "0.0.0.0",
      managementAuthDisabled: true,
    }));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  test("loopback bind + flag off still requires admin token", () => {
    const req = new Request("http://127.0.0.1:10100/api/settings", {
      method: "GET",
      headers: { Host: "127.0.0.1:10100" },
    });
    const result = requireManagementAuth(req, readyState, config({
      hostname: "127.0.0.1",
      // managementAuthDisabled unset
    }));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  test("correct admin token always works regardless of the flag", () => {
    const req = new Request("http://0.0.0.0:10100/api/settings", {
      method: "GET",
      headers: {
        Host: "proxy.example.com",
        "x-opencodex-api-key": "secret-admin-token",
      },
    });
    expect(
      requireManagementAuth(req, readyState, config({
        hostname: "0.0.0.0",
        managementAuthDisabled: true,
      })),
    ).toBeNull();
  });
});

describe("isAllowedManagementOrigin: localhost accepted when managementAuthDisabled", () => {
  test("localhost origin accepted when flag on and process is loopback", () => {
    const req = new Request("http://127.0.0.1:10100/api/v2", {
      method: "PUT",
      headers: {
        Host: "127.0.0.1:10100",
        Origin: "http://localhost:10100",
      },
    });
    expect(
      isAllowedManagementOrigin(req, config({
        hostname: "127.0.0.1",
        managementAuthDisabled: true,
      })),
    ).toBe(true);
  });

  test("loopback IPv4 origin accepted when flag on", () => {
    const req = new Request("http://127.0.0.1:10100/api/v2", {
      method: "PUT",
      headers: {
        Host: "127.0.0.1:10100",
        Origin: "http://127.0.0.1:10100",
      },
    });
    expect(
      isAllowedManagementOrigin(req, config({
        hostname: "127.0.0.1",
        managementAuthDisabled: true,
      })),
    ).toBe(true);
  });

  test("non-loopback origin still 403 when flag on (loopback-only bypass)", () => {
    const req = new Request("http://127.0.0.1:10100/api/v2", {
      method: "PUT",
      headers: {
        Host: "127.0.0.1:10100",
        Origin: "https://attacker.example.com",
      },
    });
    expect(
      isAllowedManagementOrigin(req, config({
        hostname: "127.0.0.1",
        managementAuthDisabled: true,
      })),
    ).toBe(false);
  });
});

describe("disableOriginCheck: explicit opt-in bypasses all origin gates", () => {
  test("any origin accepted when disableOriginCheck is on", () => {
    const req = new Request("http://0.0.0.0:10100/api/v2", {
      method: "PUT",
      headers: {
        Host: "proxy.example.com",
        Origin: "https://external-reverse-proxy.example.com",
      },
    });
    expect(
      isAllowedManagementOrigin(req, config({
        hostname: "0.0.0.0",
        disableOriginCheck: true,
      })),
    ).toBe(true);
  });

  test("without the flag, a remote Origin not listed in corsAllowOrigins is rejected", () => {
    const req = new Request("http://0.0.0.0:10100/api/v2", {
      method: "PUT",
      headers: {
        Host: "proxy.example.com",
        Origin: "https://external-reverse-proxy.example.com",
      },
    });
    expect(
      isAllowedManagementOrigin(req, config({
        hostname: "0.0.0.0",
        // disableOriginCheck unset, corsAllowOrigins unset
      })),
    ).toBe(false);
  });

  test("with corsAllowOrigins, a listed remote Origin is allowed", () => {
    const req = new Request("http://0.0.0.0:10100/api/v2", {
      method: "PUT",
      headers: {
        Host: "proxy.example.com",
        Origin: "https://external-reverse-proxy.example.com",
      },
    });
    expect(
      isAllowedManagementOrigin(req, config({
        hostname: "0.0.0.0",
        corsAllowOrigins: ["https://external-reverse-proxy.example.com"],
      })),
    ).toBe(true);
  });
});

function minimalConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providers: { openai: { adapter: "openai", baseUrl: "https://api.openai.com" } },
    defaultProvider: "openai",
    ...extra,
  };
}

describe("config zod schema: new fields persist", () => {
  test("managementAuthDisabled is parsed when present", () => {
    const result = validateConfigCandidate(minimalConfig({ managementAuthDisabled: true }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.managementAuthDisabled).toBe(true);
  });

  test("disableOriginCheck is parsed when present", () => {
    const result = validateConfigCandidate(minimalConfig({ disableOriginCheck: true }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.disableOriginCheck).toBe(true);
  });

  test("corsAllowOrigins is parsed when present", () => {
    const result = validateConfigCandidate(minimalConfig({
      corsAllowOrigins: ["https://proxy.example.com", "chrome-extension://abcd1234"],
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.corsAllowOrigins).toEqual([
      "https://proxy.example.com",
      "chrome-extension://abcd1234",
    ]);
  });

  test("all three fields are optional and default to undefined/false", () => {
    const result = validateConfigCandidate(minimalConfig());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.managementAuthDisabled).toBeFalsy();
    expect(result.config.disableOriginCheck).toBeFalsy();
    expect(result.config.corsAllowOrigins).toBeUndefined();
  });
});
