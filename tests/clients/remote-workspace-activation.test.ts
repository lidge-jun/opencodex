import { afterEach, expect, test } from "bun:test";
import { remoteWorkspaceEnabled } from "../../src/remote-control/workspace-activation";
import { handleManagementAPI } from "../../src/server/management-api";
import type { ManagementApiDeps } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";

const prior = process.env.OCX_REMOTE_WORKSPACE_ENABLED;
afterEach(() => {
  if (prior === undefined) delete process.env.OCX_REMOTE_WORKSPACE_ENABLED;
  else process.env.OCX_REMOTE_WORKSPACE_ENABLED = prior;
});
const config = { port: 10100, runtimeRole: "hub", defaultProvider: "none", providers: {} } as OcxConfig;

test("workspace activation requires both Hub role and exact explicit opt-in", () => {
  expect(remoteWorkspaceEnabled(config, "1")).toBe(true);
  for (const value of ["", "0", "true", "yes"]) expect(remoteWorkspaceEnabled(config, value)).toBe(false);
  expect(remoteWorkspaceEnabled({ runtimeRole: "standalone" }, "1")).toBe(false);
});

test("disabled management status and mutations never resolve optional services", async () => {
  delete process.env.OCX_REMOTE_WORKSPACE_ENABLED;
  const deps: ManagementApiDeps = {
    get remoteWorkspaceHub() { throw new Error("must not resolve hub"); },
    get remoteWorkspaceSessions() { throw new Error("must not resolve sessions"); },
  };
  const url = new URL("http://127.0.0.1:10100/api/remote-workspace");
  const status = await handleManagementAPI(new Request(url, { headers: { host: url.host } }), url, config, deps, "gui-session");
  expect(status?.status).toBe(200);
  expect(await status?.json()).toMatchObject({ available: false, devices: [], sessions: [] });
  const mutationUrl = new URL(`${url}/pairing`);
  const mutation = await handleManagementAPI(new Request(mutationUrl, { method: "POST", headers: { host: mutationUrl.host } }), mutationUrl, config, deps, "gui-session");
  expect(mutation?.status).toBe(404);
});

test("an admin token cannot initialize a consent-bearing workspace mutation", async () => {
  process.env.OCX_REMOTE_WORKSPACE_ENABLED = "1";
  const deps: ManagementApiDeps = {
    get remoteWorkspaceHub() { throw new Error("must not resolve hub"); },
    get remoteWorkspaceSessions() { throw new Error("must not resolve sessions"); },
  };
  const url = new URL("http://127.0.0.1:10100/api/remote-workspace/pairing");
  const result = await handleManagementAPI(new Request(url, { method: "POST", headers: { host: url.host } }), url, config, deps, "admin-token");
  expect(result?.status).toBe(403);
  expect(await result?.json()).toEqual({ error: "A dashboard session is required for Remote Workspace changes." });
});
