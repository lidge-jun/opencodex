import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gatewayErrorStatus } from "../src/errors";

const CONTRACT_PATH = join(import.meta.dir, "../../../docs/superpowers/specs/replit-gateway-contract-v1.json");

describe("replit gateway contract v1", () => {
  test("documents experimental pending-canary publication status", () => {
    const contract = JSON.parse(readFileSync(CONTRACT_PATH, "utf8")) as {
      status: string;
      statusNote?: string;
    };
    expect(contract.status).toBe("experimental-pending-canary");
    expect(contract.statusNote).toMatch(/AI_INTEGRATIONS/i);
  });

  test("lists unsupported_content_encoding with HTTP 415 in errorCategories", () => {
    const contract = JSON.parse(readFileSync(CONTRACT_PATH, "utf8")) as {
      errorCategories: string[];
    };
    expect(contract.errorCategories).toContain("unsupported_content_encoding");
    expect(gatewayErrorStatus("unsupported_content_encoding")).toBe(415);
  });

  test("records gateway key format and override bounds", () => {
    const contract = JSON.parse(readFileSync(CONTRACT_PATH, "utf8")) as {
      transport: { clientAuth: { format: { minLength: number; maxLength: number } } };
      configOverrideBounds: Record<string, { min: number; max: number }>;
      replitIntegrationsEnv: { verification: string; requiredNames: string[] };
    };
    expect(contract.transport.clientAuth.format.minLength).toBe(32);
    expect(contract.transport.clientAuth.format.maxLength).toBe(512);
    expect(contract.configOverrideBounds.REPLIT_GATEWAY_MAX_CONCURRENT).toEqual({ min: 1, max: 100 });
    expect(contract.replitIntegrationsEnv.verification).toBe("unverified-observed-convention");
    expect(contract.replitIntegrationsEnv.requiredNames).toHaveLength(4);
  });
});
