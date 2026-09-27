import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  EncryptedRemoteWorkspaceExecutorEndpoint,
  RemoteControlClientHandshake,
  acceptRemoteControlClientHello,
  frameRemoteWorkspaceRpcMessage,
  generateRemoteControlIdentityKeyPair,
  type RemoteWorkspaceExecutionRequest,
} from "../../src/remote-control";

function fixture() {
  const hub = generateRemoteControlIdentityKeyPair();
  const device = generateRemoteControlIdentityKeyPair();
  const sessionId = randomUUID();
  const deviceId = randomUUID();
  const handshake = RemoteControlClientHandshake.create({
    sessionId, deviceId, commandProfile: "codex", capabilities: ["workspace.read"],
    accountPrivateKey: hub.privateKey,
  });
  const accepted = acceptRemoteControlClientHello(handshake.hello, {
    expectedSessionId: sessionId, expectedDeviceId: deviceId,
    accountPublicKey: hub.publicKey, devicePrivateKey: device.privateKey,
    allowedCapabilities: ["workspace.read", "workspace.write"],
  });
  const client = handshake.complete(accepted.hello, device.publicKey);
  const invocations: RemoteWorkspaceExecutionRequest[] = [];
  const endpoint = new EncryptedRemoteWorkspaceExecutorEndpoint({
    executorDeviceId: deviceId, sessionId, rootId: "first-approved-root",
    capabilities: ["workspace.read"], cipher: accepted.cipher,
    executor: { async invoke(request) { invocations.push(request); return { ok: true }; } },
    sendCiphertext() {},
  });
  const request: RemoteWorkspaceExecutionRequest = {
    requestId: randomUUID(), sessionId, executorDeviceId: deviceId,
    rootId: "first-approved-root", tool: "read_file", arguments: { path: "marker" },
  };
  return {
    invocations,
    async send(overrides: Partial<RemoteWorkspaceExecutionRequest> = {}, grant = true, version = 2) {
      const message = new TextEncoder().encode(JSON.stringify({
        version, kind: version === 1 ? "request" : "prepare", timeoutMs: 5_000, request: { ...request, ...overrides },
      }));
      for (const frame of frameRemoteWorkspaceRpcMessage(message)) {
        await endpoint.receiveCiphertext(client.encrypt(frame));
      }
      if (grant) {
        const grantMessage = new TextEncoder().encode(JSON.stringify({
          version, kind: "grant", requestId: overrides.requestId ?? request.requestId,
        }));
        for (const frame of frameRemoteWorkspaceRpcMessage(grantMessage)) {
          await endpoint.receiveCiphertext(client.encrypt(frame));
        }
      }
    },
    close() { endpoint.close(); client.destroy(); },
  };
}

test("encrypted requests cannot leave their session grant before executor invocation", async () => {
  const mismatches: Partial<RemoteWorkspaceExecutionRequest>[] = [
    { sessionId: randomUUID() },
    { executorDeviceId: randomUUID() },
    { rootId: "second-approved-root" },
    { tool: "write_file", arguments: { path: "marker", content: "changed", expectedSha256: null } },
  ];
  for (const mismatch of mismatches) {
    const state = fixture();
    try {
      await expect(state.send(mismatch)).rejects.toThrow();
      expect(state.invocations).toEqual([]);
    } finally { state.close(); }
  }
});

test("an encrypted prepare cannot invoke without an execution grant", async () => {
  const state = fixture();
  try {
    await state.send({}, false);
    expect(state.invocations).toEqual([]);
  } finally { state.close(); }
});

test("legacy immediate-execution RPC requests fail closed", async () => {
  const state = fixture();
  try {
    await expect(state.send({}, false, 1)).rejects.toThrow("unsupported remote workspace RPC version");
    expect(state.invocations).toEqual([]);
  } finally { state.close(); }
});

test("a matching encrypted read reaches the selected executor once", async () => {
  const state = fixture();
  try {
    await state.send();
    expect(state.invocations).toHaveLength(1);
    expect(state.invocations[0]).toMatchObject({ rootId: "first-approved-root", tool: "read_file" });
  } finally { state.close(); }
});
