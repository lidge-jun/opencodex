import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RemoteWorkspaceExecutor,
  RemoteWorkspaceExecutorAgentConnection,
  RemoteWorkspaceHubAgentConnection,
  RemoteControlClientHandshake,
  generateRemoteControlIdentityKeyPair,
  parseRemoteWorkspaceAgentMessage,
  parseRemoteWorkspaceHubMessage,
  REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION,
  serializeRemoteWorkspaceAgentMessage,
  serializeRemoteWorkspaceHubMessage,
  type RemoteWorkspaceControlSocket,
  type RemoteWorkspaceCommandRunner,
} from "../src/remote-control";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

function fixture(commandRunner?: RemoteWorkspaceCommandRunner) {
  const root = mkdtempSync(join(tmpdir(), "ocx-remote-agent-wire-"));
  roots.push(root);
  const workspace = join(root, "computer-2");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "marker.txt"), "computer-2-only");
  const deviceId = randomUUID();
  const hubIdentity = generateRemoteControlIdentityKeyPair();
  const deviceIdentity = generateRemoteControlIdentityKeyPair();
  const executor = new RemoteWorkspaceExecutor({
    deviceId,
    roots: [{ id: "workspace", path: workspace }],
    commandRunner,
  });
  let hub: RemoteWorkspaceHubAgentConnection;
  let agent: RemoteWorkspaceExecutorAgentConnection;
  const hubSocket: RemoteWorkspaceControlSocket = {
    send(value) { void agent.receive(value); },
    close: () => agent.close(),
  };
  const agentSocket: RemoteWorkspaceControlSocket = {
    send: value => hub.receive(value),
    close: () => hub.close(),
  };
  hub = new RemoteWorkspaceHubAgentConnection({
    deviceId,
    devicePublicKey: deviceIdentity.publicKey,
    hubIdentity,
    capabilities: commandRunner
      ? ["workspace.read", "workspace.write", "workspace.exec"]
      : ["workspace.read", "workspace.write"],
    socket: hubSocket,
    sessionOpenTimeoutMs: 1_000,
  });
  agent = new RemoteWorkspaceExecutorAgentConnection({
    deviceId,
    deviceIdentity,
    hubPublicKey: hubIdentity.publicKey,
    executor,
    capabilities: commandRunner
      ? ["workspace.read", "workspace.write", "workspace.exec"]
      : ["workspace.read", "workspace.write"],
    socket: agentSocket,
  });
  hub.receive(serializeRemoteWorkspaceAgentMessage({
    version: REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION,
    type: "presence",
    capabilities: commandRunner
      ? ["workspace.read", "workspace.write", "workspace.exec"]
      : ["workspace.read", "workspace.write"],
  }));
  return { hub, agent, workspace, deviceId };
}

describe("remote workspace agent wire", () => {
  test("does not become online or accept session traffic before capability presence", async () => {
    const deviceId = randomUUID();
    const hubIdentity = generateRemoteControlIdentityKeyPair();
    const deviceIdentity = generateRemoteControlIdentityKeyPair();
    const hub = new RemoteWorkspaceHubAgentConnection({
      deviceId,
      devicePublicKey: deviceIdentity.publicKey,
      hubIdentity,
      socket: { send: () => {}, close: () => {} },
    });
    expect(hub.isOnline()).toBe(false);
    await expect(hub.openSession({ sessionId: randomUUID(), rootId: "workspace", profile: "codex" }))
      .rejects.toThrow("offline");
    hub.receive(serializeRemoteWorkspaceAgentMessage({
      version: REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION,
      type: "presence",
      capabilities: ["workspace.read", "workspace.write"],
    }));
    expect(hub.isOnline()).toBe(true);
    expect(() => hub.receive(serializeRemoteWorkspaceAgentMessage({
      version: REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION,
      type: "presence",
      capabilities: ["workspace.read", "workspace.write"],
    }))).toThrow("duplicate presence");
    hub.close();
  });

  test("cancels a session handshake immediately instead of waiting for its timeout", async () => {
    const deviceId = randomUUID();
    const hubIdentity = generateRemoteControlIdentityKeyPair();
    const deviceIdentity = generateRemoteControlIdentityKeyPair();
    const sent: string[] = [];
    const hub = new RemoteWorkspaceHubAgentConnection({
      deviceId,
      devicePublicKey: deviceIdentity.publicKey,
      hubIdentity,
      socket: { send: value => { sent.push(value); }, close: () => {} },
      sessionOpenTimeoutMs: 30_000,
    });
    hub.receive(serializeRemoteWorkspaceAgentMessage({
      version: REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION,
      type: "presence",
      capabilities: ["workspace.read", "workspace.write"],
    }));
    const sessionId = randomUUID();
    const opening = hub.openSession({ sessionId, rootId: "workspace", profile: "codex" });
    await hub.closeSession(sessionId, "cancelled by user");
    await expect(opening).rejects.toThrow("cancelled by user");
    expect(sent.map(message => parseRemoteWorkspaceHubMessage(message).type))
      .toEqual(["presence_ack", "session_open", "session_close"]);
    hub.close();
  });

  test("opens an authenticated encrypted session and executes on the OCX-only device", async () => {
    const state = fixture();
    const sessionId = randomUUID();
    const transport = await state.hub.openSession({
      sessionId,
      rootId: "workspace",
      profile: "codex",
    });
    const result = await transport.invoke({
      requestId: randomUUID(),
      sessionId,
      executorDeviceId: state.deviceId,
      rootId: "workspace",
      tool: "read_file",
      arguments: { path: "marker.txt" },
    });
    expect(result).toMatchObject({ ok: true, value: { content: "computer-2-only" } });
    await state.hub.closeSession(sessionId);
    expect(transport.isOnline(state.deviceId)).toBe(false);
  });

  test("discards an endpoint when sending session acceptance fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-remote-agent-accept-failure-"));
    roots.push(root);
    const deviceId = randomUUID();
    const sessionId = randomUUID();
    const hubIdentity = generateRemoteControlIdentityKeyPair();
    const deviceIdentity = generateRemoteControlIdentityKeyPair();
    const executor = new RemoteWorkspaceExecutor({
      deviceId,
      roots: [{ id: "workspace", path: root }],
    });
    const handshake = RemoteControlClientHandshake.create({
      sessionId,
      deviceId,
      commandProfile: "codex",
      capabilities: ["workspace.read", "workspace.write"],
      accountPrivateKey: hubIdentity.privateKey,
    });
    const sent: string[] = [];
    let failAcceptance = true;
    const agent = new RemoteWorkspaceExecutorAgentConnection({
      deviceId,
      deviceIdentity,
      hubPublicKey: hubIdentity.publicKey,
      executor,
      capabilities: ["workspace.read", "workspace.write"],
      socket: {
        send(value) {
          const message = parseRemoteWorkspaceAgentMessage(value);
          if (message.type === "session_accept" && failAcceptance) {
            failAcceptance = false;
            throw new Error("socket send failed");
          }
          sent.push(value);
        },
        close() {},
      },
    });
    const open = serializeRemoteWorkspaceHubMessage({
      version: REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION,
      type: "session_open",
      rootId: "workspace",
      clientHello: handshake.hello,
    });
    await agent.receive(open);
    await agent.receive(open);
    expect(sent.map(value => parseRemoteWorkspaceAgentMessage(value).type))
      .toEqual(["session_reject", "session_accept"]);
    agent.close();
  });

  test("fails pending and active work closed when the executor disconnects", async () => {
    const state = fixture();
    const sessionId = randomUUID();
    const transport = await state.hub.openSession({ sessionId, rootId: "workspace", profile: "pi" });
    state.hub.close("executor disconnected");
    expect(transport.isOnline(state.deviceId)).toBe(false);
    await expect(transport.invoke({
      requestId: randomUUID(),
      sessionId,
      executorDeviceId: state.deviceId,
      rootId: "workspace",
      tool: "read_file",
      arguments: { path: "marker.txt" },
    })).rejects.toThrow("offline");
  });

  test("session close aborts an active command on the executor", async () => {
    let started!: () => void;
    const active = new Promise<void>(resolve => { started = resolve; });
    let cancelled = false;
    const state = fixture({
      async run(request) {
        started();
        return await new Promise<never>((_resolve, reject) => {
          const abort = () => {
            cancelled = true;
            reject(new Error("cancelled"));
          };
          request.signal?.addEventListener("abort", abort, { once: true });
          if (request.signal?.aborted) abort();
        });
      },
    });
    const sessionId = randomUUID();
    const transport = await state.hub.openSession({ sessionId, rootId: "workspace", profile: "codex" });
    const invocation = transport.invoke({
      requestId: randomUUID(),
      sessionId,
      executorDeviceId: state.deviceId,
      rootId: "workspace",
      tool: "exec",
      arguments: { command: ["sleep", "60"] },
    });
    await active;
    await state.hub.closeSession(sessionId);
    await expect(invocation).rejects.toThrow("closed");
    await Bun.sleep(5);
    expect(cancelled).toBe(true);
  });

  test("bounds concurrent Hub requests while serializing operations on one executor", async () => {
    let started = 0;
    const state = fixture({
      async run(request) {
        started += 1;
        return await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(new Error("cancelled"));
          request.signal?.addEventListener("abort", abort, { once: true });
          if (request.signal?.aborted) abort();
        });
      },
    });
    const sessionId = randomUUID();
    const transport = await state.hub.openSession({ sessionId, rootId: "workspace", profile: "codex" });
    const pending = Array.from({ length: 8 }, () => transport.invoke({
      requestId: randomUUID(),
      sessionId,
      executorDeviceId: state.deviceId,
      rootId: "workspace",
      tool: "exec",
      arguments: { command: ["wait"] },
    }).catch(error => error));
    for (let count = 0; count < 100 && started < 1; count += 1) await Bun.sleep(1);
    expect(started).toBe(1);
    await expect(transport.invoke({
      requestId: randomUUID(),
      sessionId,
      executorDeviceId: state.deviceId,
      rootId: "workspace",
      tool: "exec",
      arguments: { command: ["overflow"] },
    })).rejects.toThrow("request limit");
    await state.hub.closeSession(sessionId);
    await Promise.all(pending);
  });

  test("rejects malformed, oversized, and non-workspace control messages", () => {
    expect(() => parseRemoteWorkspaceHubMessage("{}"))
      .toThrow("unsupported remote workspace agent protocol");
    expect(() => parseRemoteWorkspaceAgentMessage(JSON.stringify({
      version: 1,
      type: "heartbeat",
      nonce: "ok",
      extra: true,
    }))).toThrow("fields");
    expect(() => parseRemoteWorkspaceAgentMessage("x".repeat(100 * 1024)))
      .toThrow("length");
  });
});
