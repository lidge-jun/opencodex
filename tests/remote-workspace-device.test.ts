import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RemoteWorkspaceHub,
  connectRemoteWorkspaceAgent,
  generateRemoteControlIdentityKeyPair,
  pairRemoteWorkspaceDevice,
  parseRemoteWorkspaceDeviceState,
  type RemoteWorkspaceDeviceState,
  type RemoteWorkspaceDeviceStateStore,
  type RemoteWorkspaceHubState,
  type RemoteWorkspaceHubStateStore,
} from "../src/remote-control";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

class HubStore implements RemoteWorkspaceHubStateStore {
  state: RemoteWorkspaceHubState | null = null;
  load() { return this.state ? structuredClone(this.state) : null; }
  save(state: RemoteWorkspaceHubState) { this.state = structuredClone(state); }
}

class DeviceStore implements RemoteWorkspaceDeviceStateStore {
  state: RemoteWorkspaceDeviceState | null = null;
  load() { return this.state ? structuredClone(this.state) : null; }
  save(state: RemoteWorkspaceDeviceState) { this.state = structuredClone(state); }
}

describe("remote workspace device enrollment", () => {
  test("pairs through one HTTPS request while keeping the real root path on Computer 2", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-remote-device-"));
    roots.push(root);
    const workspace = join(root, "private-project");
    const toolchain = join(root, "private-toolchain");
    const nativeHelper = join(root, "private-native-helper");
    mkdirSync(workspace);
    mkdirSync(toolchain);
    writeFileSync(nativeHelper, "test helper", { mode: 0o700 });
    chmodSync(nativeHelper, 0o700);
    const hubStore = new HubStore();
    const hub = new RemoteWorkspaceHub(hubStore);
    const grant = hub.createPairingGrant();
    const deviceStore = new DeviceStore();
    let requestBody = "";
    const state = await pairRemoteWorkspaceDevice({
      hubUrl: "https://hub.example.test",
      pairingCode: grant.code,
      name: "Computer 2",
      devicePlatform: "linux-x64",
      roots: [{ path: workspace, label: "Main project" }],
      toolchainRoots: [toolchain],
      nativeHelperPath: nativeHelper,
      store: deviceStore,
      fetchImpl: async (input, init) => {
        expect(String(input)).toBe("https://hub.example.test/remote-workspace/pair");
        requestBody = String(init?.body);
        const paired = hub.pairDevice(JSON.parse(requestBody));
        return Response.json(paired, { status: 201 });
      },
    });
    expect(requestBody).not.toContain(workspace);
    expect(requestBody).not.toContain(toolchain);
    expect(requestBody).not.toContain(nativeHelper);
    expect(requestBody).not.toContain(state.deviceIdentity.privateKey);
    expect(state).toMatchObject({
      hubUrl: "https://hub.example.test",
      agentUrl: "wss://hub.example.test/remote-workspace/agent",
      deviceName: "Computer 2",
      devicePlatform: "linux-x64",
      roots: [{ label: "Main project", path: realpathSync(workspace) }],
      toolchainRoots: [realpathSync(toolchain)],
    });
    expect(state.nativeHelper?.path).toBe(realpathSync(nativeHelper));
    expect(state.nativeHelper?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(deviceStore.state).toEqual(state);
    expect(hub.authenticateDeviceToken(state.deviceToken)?.id).toBe(state.deviceId);
    expect(JSON.stringify(hubStore.state)).not.toContain(state.deviceToken);
    expect(JSON.stringify(hubStore.state)).not.toContain(workspace);
  });

  test("requires HTTPS except for explicit loopback development", async () => {
    expect(() => parseRemoteWorkspaceDeviceState({ version: 1, hubUrl: "http://example.test" }))
      .toThrow("must use HTTPS");
    const root = mkdtempSync(join(tmpdir(), "ocx-remote-device-local-"));
    roots.push(root);
    const store = new DeviceStore();
    await expect(pairRemoteWorkspaceDevice({
      hubUrl: "http://127.0.0.1:7075",
      pairingCode: "AAAA-BBBB-CCCC",
      roots: [{ path: root }],
      store,
      fetchImpl: async () => Response.json({ error: "invalid or expired" }, { status: 401 }),
    })).rejects.toThrow("invalid or expired");
    expect(store.state).toBeNull();
  });

  test("cancels a chunked Hub response before it can grow beyond the pairing limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-remote-device-bounded-response-"));
    roots.push(root);
    const store = new DeviceStore();
    let cancelled = false;
    await expect(pairRemoteWorkspaceDevice({
      hubUrl: "https://hub.example.test",
      pairingCode: "ABCD-EFGH-JKLM",
      roots: [{ path: root }],
      store,
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(64 * 1024));
          controller.enqueue(new Uint8Array([1]));
        },
        cancel() { cancelled = true; },
      }), { status: 200 }),
    })).rejects.toThrow("response is too large");
    expect(cancelled).toBe(true);
    expect(store.state).toBeNull();
  });

  test("stops cleanly even when the platform WebSocket rejects close while connecting", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-remote-device-stop-"));
    roots.push(root);
    const state: RemoteWorkspaceDeviceState = {
      version: 1,
      hubUrl: "https://hub.example.test",
      agentUrl: "wss://hub.example.test/remote-workspace/agent",
      deviceId: randomUUID(),
      deviceName: "Computer 2",
      devicePlatform: "darwin-arm64",
      capabilities: ["workspace.read", "workspace.write"],
      deviceToken: `ocxrw_${"A".repeat(43)}`,
      deviceIdentity: generateRemoteControlIdentityKeyPair(),
      hubPublicKey: generateRemoteControlIdentityKeyPair().publicKey,
      roots: [{ id: randomUUID(), label: "Project", path: root }],
      toolchainRoots: [],
    };
    const handle = connectRemoteWorkspaceAgent({
      state,
      commandRunner: null,
      webSocketFactory: () => ({
        readyState: 0,
        send() {},
        close() { throw new Error("CONNECTING close is not supported"); },
        addEventListener() {},
      }),
    });
    handle.stop();
    await expect(handle.connected).rejects.toThrow("stopped");
    await handle.closed;
  });
});
