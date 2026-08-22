import { describe, expect, test } from "bun:test";
import type { OcxConfig } from "../src/types";
import { handleManagementAPI } from "../src/server/management-api";
import { ManagementRequest } from "./helpers/management-auth";

const config = { providers: {} } as OcxConfig;

async function apiGet(path: string): Promise<Response> {
  const req = new ManagementRequest(`http://127.0.0.1${path}`, { method: "GET" });
  const response = await handleManagementAPI(req, new URL(req.url), config);
  expect(response).not.toBeNull();
  return response!;
}

describe("Compatibility Lab management read filter validation", () => {
  test("rejects invalid excluded values instead of silently dropping the filter", async () => {
    const response = await apiGet("/api/lab/events?excluded=maybe");
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { code: string } };
    expect(body.error.code).toBe("invalid_excluded");
  });

  test("rejects unsupported artifact classes instead of querying with arbitrary values", async () => {
    const response = await apiGet("/api/lab/artifacts?artifactClass=not-real");
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { code: string } };
    expect(body.error.code).toBe("invalid_artifact_class");
  });
});
