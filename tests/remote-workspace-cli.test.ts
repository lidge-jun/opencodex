import { describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { runRemoteWorkspaceCommand } from "../src/cli/remote-workspace";
import {
  generateRemoteControlIdentityKeyPair,
  type RemoteWorkspaceDeviceState,
  type RemoteWorkspaceDeviceStateStore,
} from "../src/remote-control";

class MemoryStore implements RemoteWorkspaceDeviceStateStore {
  constructor(public state: RemoteWorkspaceDeviceState | null = null) {}
  load() { return this.state ? structuredClone(this.state) : null; }
  save(state: RemoteWorkspaceDeviceState) { this.state = structuredClone(state); }
}

function state(): RemoteWorkspaceDeviceState {
  return {
    version: 1,
    hubUrl: "https://hub.example.test",
    agentUrl: "wss://hub.example.test/remote-workspace/agent",
    deviceId: randomUUID(),
    deviceName: "Computer 2",
    devicePlatform: "linux-x64",
    capabilities: ["workspace.read", "workspace.write", "workspace.exec"],
    deviceToken: `ocxrw_${"A".repeat(43)}`,
    deviceIdentity: generateRemoteControlIdentityKeyPair(),
    hubPublicKey: generateRemoteControlIdentityKeyPair().publicKey,
    roots: [{ id: randomUUID(), label: "Project", path: "/work/project" }],
    toolchainRoots: [],
  };
}

describe("ocx remote-workspace", () => {
  test("reads the one-time pairing code from stdin and never requires it in argv", async () => {
    const store = new MemoryStore();
    const expected = state();
    let received: Record<string, unknown> | null = null;
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await runRemoteWorkspaceCommand([
        "pair",
        "https://hub.example.test",
        "--root", "/work/project",
        "--root", "/work/other",
        "--executor-helper", "/opt/opencodex/remote-workspace-helper",
        "--name", "Computer 2",
        "--pairing-code-stdin",
        "--json",
      ], {
        store,
        stdinImpl: Readable.from(["ABCD-EFGH-JKLM\n"]),
        pair: async options => {
          received = options as unknown as Record<string, unknown>;
          return expected;
        },
      });
      expect(code).toBe(0);
      expect(received).toMatchObject({
        hubUrl: "https://hub.example.test",
        pairingCode: "ABCD-EFGH-JKLM",
        name: "Computer 2",
        roots: [{ path: "/work/project" }, { path: "/work/other" }],
        nativeHelperPath: "/opt/opencodex/remote-workspace-helper",
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain(expected.deviceToken);
      expect(JSON.stringify(log.mock.calls)).not.toContain(expected.deviceIdentity.privateKey);
    } finally {
      log.mockRestore();
    }
  });

  test("status reports local executor identity without secret material", async () => {
    const saved = state();
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await runRemoteWorkspaceCommand(["status", "--json"], { store: new MemoryStore(saved) })).toBe(0);
      const output = JSON.stringify(log.mock.calls);
      expect(output).toContain("Computer 2");
      expect(output).toContain("/work/project");
      expect(output).not.toContain(saved.deviceToken);
      expect(output).not.toContain(saved.deviceIdentity.privateKey);
    } finally {
      log.mockRestore();
    }
  });

  test("agent hands the paired state to the reconnecting runner", async () => {
    const saved = state();
    const controller = new AbortController();
    let received: RemoteWorkspaceDeviceState | null = null;
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await runRemoteWorkspaceCommand(["agent"], {
        store: new MemoryStore(saved),
        signal: controller.signal,
        runAgent: async options => { received = options.state; },
      });
      expect(code).toBe(0);
      expect(received?.deviceId).toBe(saved.deviceId);
    } finally {
      log.mockRestore();
    }
  });
});
