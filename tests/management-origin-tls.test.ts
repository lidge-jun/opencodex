import { describe, expect, test } from "bun:test";
import { isAllowedManagementOrigin } from "../src/server/auth-cors";
import type { OcxConfig } from "../src/types";

function config(partial: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    hostname: "0.0.0.0",
    providers: {},
    ...partial,
  } as OcxConfig;
}

describe("management origin behind TLS termination (#760)", () => {
  test("allows https Origin when the process sees http with the same Host", () => {
    const req = new Request("http://127.0.0.1:10100/api/v2", {
      method: "PUT",
      headers: {
        Host: "proxy.example.com",
        Origin: "https://proxy.example.com",
      },
    });
    expect(isAllowedManagementOrigin(req, config())).toBe(true);
  });

  test("still rejects a different Origin host", () => {
    const req = new Request("http://127.0.0.1:10100/api/v2", {
      method: "PUT",
      headers: {
        Host: "proxy.example.com",
        Origin: "https://evil.example.com",
      },
    });
    expect(isAllowedManagementOrigin(req, config())).toBe(false);
  });

  test("still rejects same-scheme cross-port Origins", () => {
    const req = new Request("http://127.0.0.1:10100/api/config", {
      method: "GET",
      headers: {
        Host: "127.0.0.1:10100",
        Origin: "http://127.0.0.1:65534",
      },
    });
    expect(isAllowedManagementOrigin(req, config({ hostname: "127.0.0.1" }))).toBe(false);
  });

  test("honours corsAllowOrigins for an explicit external origin", () => {
    const req = new Request("http://127.0.0.1:10100/api/v2", {
      method: "PUT",
      headers: {
        Host: "internal.example.com",
        Origin: "https://dashboard.example.com",
      },
    });
    expect(isAllowedManagementOrigin(req, config({
      corsAllowOrigins: ["https://dashboard.example.com"],
    }))).toBe(true);
  });
});
