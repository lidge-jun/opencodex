import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateRemoteInstance,
  createRemotePairingCode,
  disconnectRemoteDevice,
  getRemoteStatus,
  setRemotePassword,
  startRemoteLink,
} from "../src/remote/client";

const CONTROL = "http://127.0.0.1:19991";
let temporaryHome = "";
let previousHome: string | undefined;

beforeEach(() => {
  temporaryHome = mkdtempSync(join(tmpdir(), "ocx-remote-client-"));
  previousHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = temporaryHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(temporaryHome, { recursive: true, force: true });
});

describe("local Remote device authorization", () => {
  test("links a device without exposing polling or device secrets in the management DTO", async () => {
    let pollCount = 0;
    let passwordUpdated = false;
    let instanceActivated = false;
    let deviceRevoked = false;
    let e2eeEnvelope: Record<string, unknown> | null = null;
    const deviceToken = `ocxr_device_${"d".repeat(43)}`;
    const relayToken = `ocxr_agent_${"r".repeat(43)}`;
    const pollSecret = `ocxr_device_${"p".repeat(43)}`;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/device-links" && init?.method === "POST") {
        return Response.json({
          id: "11111111-1111-4111-8111-111111111111",
          pollSecret,
          userCode: "ABCD2345",
          authorizeUrl: `${CONTROL}/connect/11111111-1111-4111-8111-111111111111`,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        }, { status: 201 });
      }
      if (url.pathname === "/api/v1/device-links/11111111-1111-4111-8111-111111111111" && init?.method === "GET") {
        pollCount += 1;
        return pollCount === 1
          ? Response.json({ status: "pending" })
          : Response.json({
            status: "approved",
            deviceId: "22222222-2222-4222-8222-222222222222",
            deviceToken,
            relayToken,
            relayUrl: "wss://relay.opencodexpages.me/_ocxr/agent",
            user: { name: "Octo User", email: "octo@example.test", githubNumericId: "12345" },
          });
      }
      if (url.pathname.endsWith("/ack") && init?.method === "POST") return Response.json({ ok: true });
      if (url.pathname === "/api/v1/remote/profile" && init?.method === "GET") {
        expect(init?.headers).toMatchObject({ authorization: `Bearer ${deviceToken}` });
        return Response.json({ profile: {
          passwordSet: passwordUpdated,
          canActivate: true,
          e2ee: e2eeEnvelope,
          devices: [],
          instance: instanceActivated ? {
            id: "33333333-3333-4333-8333-333333333333",
            name: "Test PC",
            slug: "test-pc",
            status: "awaiting_agent",
            publicUrl: "https://test-pc.opencodexpages.me",
          } : null,
        } });
      }
      if (url.pathname === "/api/v1/remote/e2ee-profile" && init?.method === "PUT") {
        expect(init?.headers).toMatchObject({ authorization: `Bearer ${deviceToken}` });
        const body = JSON.parse(String(init.body)) as { authSecret: string; envelope: Record<string, unknown> };
        expect(body.authSecret).toHaveLength(43);
        e2eeEnvelope = body.envelope;
        passwordUpdated = true;
        return Response.json({ profile: {
          passwordSet: true,
          canActivate: true,
          e2ee: e2eeEnvelope,
          devices: [],
          instance: null,
        } });
      }
      if (url.pathname === "/api/v1/remote/activate" && init?.method === "POST") {
        instanceActivated = true;
        return Response.json({ profile: {
          passwordSet: true,
          canActivate: true,
          e2ee: e2eeEnvelope,
          devices: [],
          instance: {
            id: "33333333-3333-4333-8333-333333333333",
            name: "Test PC",
            slug: "test-pc",
            status: "pending",
            publicUrl: "https://test-pc.opencodexpages.me",
          },
        } }, { status: 202 });
      }
      if (url.pathname === "/api/v1/remote/pairing-code" && init?.method === "POST") {
        return Response.json({ code: "ABCD2345EFGH", expiresAt: new Date(Date.now() + 600_000).toISOString() }, { status: 201 });
      }
      if (url.pathname === "/api/v1/devices/current" && init?.method === "DELETE") {
        deviceRevoked = true;
        return Response.json({ ok: true });
      }
      return Response.json({ error: "unexpected request" }, { status: 500 });
    };

    const started = await startRemoteLink({ fetchImpl, controlPlaneUrl: CONTROL, deviceName: "Test PC", devicePlatform: "linux-x64" });
    expect(started).toMatchObject({ state: "pending", userCode: "ABCD2345", serviceReachable: true });
    expect(JSON.stringify(started)).not.toContain(pollSecret);
    expect(readFileSync(join(temporaryHome, "remote.json"), "utf8")).toContain(pollSecret);

    expect(await getRemoteStatus({ fetchImpl })).toMatchObject({ state: "pending" });
    const connected = await getRemoteStatus({ fetchImpl });
    expect(connected).toMatchObject({
      state: "connected",
      account: { name: "Octo User", githubNumericId: "12345" },
      passwordSet: false,
    });
    expect(JSON.stringify(connected)).not.toContain(deviceToken);
    expect(JSON.stringify(connected)).not.toContain(relayToken);

    expect(await setRemotePassword("a-strong-remote-password", { fetchImpl })).toMatchObject({
      state: "connected",
      passwordSet: true,
    });
    expect(passwordUpdated).toBe(true);
    expect(e2eeEnvelope).not.toBeNull();
    expect(await activateRemoteInstance("Test PC", "test-pc", { fetchImpl })).toMatchObject({
      state: "connected",
      instance: { slug: "test-pc", status: "pending" },
    });
    expect(await createRemotePairingCode({ fetchImpl })).toMatchObject({ code: "ABCD2345EFGH" });
    expect(await disconnectRemoteDevice({ fetchImpl })).toMatchObject({ state: "signed_out" });
    expect(deviceRevoked).toBe(true);
  });

  test("rejects an authorization URL on a different origin", async () => {
    const fetchImpl: typeof fetch = async () => Response.json({
      id: "11111111-1111-4111-8111-111111111111",
      pollSecret: `ocxr_device_${"p".repeat(43)}`,
      userCode: "ABCD2345",
      authorizeUrl: "https://attacker.example/connect/request",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }, { status: 201 });
    await expect(startRemoteLink({ fetchImpl, controlPlaneUrl: CONTROL })).rejects.toThrow("authorization origin mismatch");
  });
});
