import { describe, expect, test } from "bun:test";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";
import { ManagementRequest } from "./helpers/management-auth";

const config = { port: 0, defaultProvider: "openai-apikey", providers: {} } as OcxConfig;

describe("CL-10 management public JSON boundary", () => {
  test("rejects duplicate decoded object keys before request object construction", async () => {
    const req = new ManagementRequest("http://127.0.0.1/api/lab/public/community/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"bundle":{},"\\u0062undle":{}}',
    });

    const response = await handleManagementAPI(req, new URL(req.url), config, {
      refreshCodexCatalog: async () => {},
    });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(400);
    expect(await response!.json()).toMatchObject({
      error: { code: "duplicate_json_key" },
    });
  });
});
