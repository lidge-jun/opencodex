import { describe, expect, test } from "bun:test";
import { isAllowedManagementOrigin } from "../src/server/auth-cors";
import type { OcxConfig } from "../src/types";

// Smoke: route module exports stay importable; full e2e covered elsewhere once landed with auth harness.
describe("GET /api/catalog route (#709)", () => {
  test("model-routes module loads", async () => {
    const mod = await import("../src/server/management/model-routes");
    expect(typeof mod.handleModelRoutes).toBe("function");
  });
});
