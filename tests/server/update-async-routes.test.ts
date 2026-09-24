import { describe, expect, test } from "bun:test";
import { handleManagementAPI } from "../../src/server/management-api";
import type { ManagementApiDeps } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";

const config = { port: 10100, defaultProvider: "openai", providers: {} } as OcxConfig;

async function call(method: string, path: string, body?: object, deps: ManagementApiDeps = {}) {
  const url = new URL(`http://127.0.0.1:10100${path}`);
  const request = new Request(url, {
    method,
    headers: { host: "127.0.0.1:10100", ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return handleManagementAPI(request, url, config, deps, "admin-token");
}

describe("asynchronous package update routes", () => {
  test("non-source check leaves the event loop responsive while lookup is pending", async () => {
    let lookupEntered!: () => void;
    const entered = new Promise<void>(resolve => { lookupEntered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let settled = false;
    const pending = call("GET", "/api/update/check?tag=latest", undefined, {
      checkPackageUpdate: async channel => {
        expect(channel).toBe("latest");
        lookupEntered();
        await gate;
        return {
          currentVersion: "2.7.43", latestVersion: "2.7.44", channel,
          installer: "npm", updateAvailable: true, canUpdate: true,
          command: "npm install -g @bitkyc08/opencodex@2.7.44", releaseNotesUrl: "https://example.test/releases",
        };
      },
    }).then(response => { settled = true; return response; });
    try {
      await entered;
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(settled).toBe(false);
    } finally {
      release();
    }
    const response = await pending;
    expect(response?.status).toBe(200);
    const body = await response!.json() as Record<string, unknown>;
    expect(body.installer).toBe("npm");
    expect(body.latestVersion).toBe("2.7.44");
  });

  test("source checkout check returns guidance without registry work", async () => {
    const response = await call("GET", "/api/update/check?tag=latest");
    expect(response?.status).toBe(200);
    const body = await response!.json() as Record<string, unknown>;
    expect(body.installer).toBe("source");
    expect(body.canUpdate).toBe(false);
  });

  test("source checkout run rejects a worker", async () => {
    const response = await call("POST", "/api/update/run", { tag: "latest", restart: false });
    expect(response?.status).toBe(409);
    const body = await response!.json() as Record<string, unknown>;
    expect(body.code).toBe("source_checkout");
  });
});
