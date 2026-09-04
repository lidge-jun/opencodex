import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  REMOTE_WORKSPACE_DYNAMIC_TOOLS,
  REMOTE_WORKSPACE_MAX_TOOL_RESULT_BYTES,
  REMOTE_WORKSPACE_TOOL_NAMESPACE,
  EncryptedRemoteWorkspaceExecutorEndpoint,
  EncryptedRemoteWorkspaceTransport,
  RemoteControlClientHandshake,
  RemoteWorkspaceCoordinator,
  RemoteWorkspaceExecutor,
  acceptRemoteControlClientHello,
  generateRemoteControlIdentityKeyPair,
  remoteWorkspaceThreadStartParams,
  type AppServerDynamicToolRequest,
  type RemoteWorkspaceCommandRunner,
  type RemoteWorkspaceExecutionRequest,
  type RemoteWorkspaceToolResult,
  type RemoteWorkspaceTransport,
} from "../src/remote-control";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const roots: string[] = [];

const localTestCommandRunner: RemoteWorkspaceCommandRunner = {
  async run(request) {
    const child = Bun.spawn(request.command, {
      cwd: request.cwd,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", HOME: request.cwd },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, request.timeoutMs);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (timedOut) throw new Error("local test command timed out");
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > request.maxOutputBytes) {
        throw new Error("local test command output limit exceeded");
      }
      return { stdout, stderr, exitCode };
    } finally {
      clearTimeout(timer);
    }
  },
};

afterEach(() => {
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ocx-remote-workspace-"));
  roots.push(root);
  const main = join(root, "main");
  const executorRoot = join(root, "executor");
  mkdirSync(join(main, "project"), { recursive: true });
  mkdirSync(join(executorRoot, "project"), { recursive: true });
  writeFileSync(join(main, "project", "marker.txt"), "main-only");
  writeFileSync(join(executorRoot, "project", "marker.txt"), "executor-before");
  const deviceId = `device-${randomUUID()}`;
  const executor = new RemoteWorkspaceExecutor({
    deviceId,
    roots: [{ id: "project-root", path: executorRoot }],
    commandRunner: localTestCommandRunner,
  });
  let online = true;
  let invokeCount = 0;
  const transport: RemoteWorkspaceTransport = {
    isOnline: candidate => online && candidate === deviceId,
    async invoke(request: RemoteWorkspaceExecutionRequest): Promise<RemoteWorkspaceToolResult> {
      invokeCount += 1;
      return await executor.invoke(request);
    },
  };
  const coordinator = new RemoteWorkspaceCoordinator(transport);
  const threadId = `thread-${randomUUID()}`;
  coordinator.register({
    sessionId: `session-${randomUUID()}`,
    threadId,
    executorDeviceId: deviceId,
    executorName: "Computer 2",
    rootId: "project-root",
    capabilities: ["workspace.read", "workspace.write", "workspace.exec"],
    tools: ["list_directory", "read_file", "write_file", "exec"],
  });
  const request = (tool: string, args: unknown, id: number = 1): AppServerDynamicToolRequest => ({
    method: "item/tool/call",
    id,
    params: {
      threadId,
      turnId: `turn-${randomUUID()}`,
      callId: `call-${randomUUID()}`,
      namespace: REMOTE_WORKSPACE_TOOL_NAMESPACE,
      tool,
      arguments: args,
    },
  });
  return {
    root,
    main,
    executorRoot,
    executor,
    coordinator,
    request,
    setOnline(value: boolean) { online = value; },
    invokeCount: () => invokeCount,
  };
}

function responseValue(response: Awaited<ReturnType<RemoteWorkspaceCoordinator["handle"]>>): RemoteWorkspaceToolResult {
  return JSON.parse(response.result.contentItems[0]!.text) as RemoteWorkspaceToolResult;
}

describe("remote workspace coordinator and executor", () => {
  test("publishes only the namespaced client-executed tools and isolates the coordinator cwd", () => {
    expect(REMOTE_WORKSPACE_DYNAMIC_TOOLS).toHaveLength(1);
    expect(REMOTE_WORKSPACE_DYNAMIC_TOOLS[0].name).toBe(REMOTE_WORKSPACE_TOOL_NAMESPACE);
    expect(REMOTE_WORKSPACE_DYNAMIC_TOOLS[0].tools.map(tool => tool.name)).toEqual([
      "list_directory", "read_file", "write_file", "exec",
    ]);
    const coordinatorIsolation = resolve("isolated-coordinator-session");
    const params = remoteWorkspaceThreadStartParams({
      executorName: "Computer 2",
      coordinatorIsolationPath: coordinatorIsolation,
      tools: ["list_directory", "read_file", "write_file", "exec"],
    });
    expect(params).toMatchObject({
      cwd: coordinatorIsolation,
      runtimeWorkspaceRoots: [coordinatorIsolation],
      approvalPolicy: "never",
      serviceName: "opencodex_remote_workspace",
    });
    expect(String(params.developerInstructions)).toContain("never fall back locally");
  });

  test("rejects write and exec calls that are outside the session access grant", async () => {
    let invoked = false;
    const coordinator = new RemoteWorkspaceCoordinator({
      isOnline: () => true,
      async invoke() { invoked = true; return { ok: true }; },
    });
    coordinator.register({
      sessionId: "session-read-only",
      threadId: "thread-read-only",
      executorDeviceId: "device-2",
      executorName: "Computer 2",
      rootId: "root-2",
      capabilities: ["workspace.read"],
      tools: ["list_directory", "read_file"],
    });
    const result = await coordinator.handle({
      method: "item/tool/call",
      id: "request-1",
      params: {
        threadId: "thread-read-only",
        turnId: "turn-1",
        callId: "call-1",
        namespace: "ocx_remote_workspace",
        tool: "exec",
        arguments: { command: ["true"] },
      },
    });
    expect(responseValue(result).error).toContain("not supported");
    expect(invoked).toBe(false);
  });

  test("writes and executes only inside Computer 2 while the same Computer 1 path stays unchanged", async () => {
    const state = fixture();
    const write = await state.coordinator.handle(state.request("write_file", {
      path: "project/marker.txt",
      content: "executor-after",
      expectedSha256: sha256("executor-before"),
    }));
    expect(write.result.success).toBe(true);
    expect(responseValue(write).ok).toBe(true);
    expect(readFileSync(join(state.executorRoot, "project", "marker.txt"), "utf8")).toBe("executor-after");
    expect(readFileSync(join(state.main, "project", "marker.txt"), "utf8")).toBe("main-only");

    const command = process.platform === "win32"
      ? ["powershell.exe", "-NoProfile", "-Command", "Write-Output -NoNewline 'executor-process:'; (Get-Location).Path"]
      : ["/bin/sh", "-lc", "printf 'executor-process:'; pwd"];
    const exec = await state.coordinator.handle(state.request("exec", {
      command,
      cwd: "project",
      timeoutMs: 5_000,
    }, 2));
    const result = responseValue(exec);
    expect(exec.result.success).toBe(true);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.value)).toContain("executor-process:");
    expect(JSON.stringify(result.value)).toContain(join(state.executorRoot, "project"));
    expect(JSON.stringify(result.value)).not.toContain(state.main);
  });

  test("lists and reads bounded workspace data through the selected root", async () => {
    const state = fixture();
    const list = responseValue(await state.coordinator.handle(state.request("list_directory", { path: "project" })));
    expect(list).toMatchObject({ ok: true, value: { path: "project" } });
    expect(JSON.stringify(list.value)).toContain("marker.txt");

    const read = responseValue(await state.coordinator.handle(state.request("read_file", {
      path: "project/marker.txt",
      maxBytes: 1024,
    })));
    expect(read).toMatchObject({ ok: true, value: { content: "executor-before", bytes: 15 } });
    expect((read.value as { sha256: string }).sha256).toBe(sha256("executor-before"));
  });

  test("does not read an unbounded existing file while checking a write precondition", async () => {
    const state = fixture();
    writeFileSync(
      join(state.executorRoot, "project", "oversized.txt"),
      Buffer.alloc(REMOTE_WORKSPACE_MAX_TOOL_RESULT_BYTES + 1),
    );
    const write = responseValue(await state.coordinator.handle(state.request("write_file", {
      path: "project/oversized.txt",
      content: "replacement",
      expectedSha256: "0".repeat(64),
    })));
    expect(write.ok).toBe(false);
    expect(write.error).toContain("read limit");
  });

  test("rejects traversal and symlink escapes on the executor", async () => {
    const state = fixture();
    const traversal = responseValue(await state.coordinator.handle(state.request("read_file", {
      path: "../main/project/marker.txt",
    })));
    expect(traversal.ok).toBe(false);
    expect(traversal.error).toContain("escapes");

    symlinkSync(
      join(state.main, "project"),
      join(state.executorRoot, "outside-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const symlink = responseValue(await state.coordinator.handle(state.request("read_file", {
      path: "outside-link/marker.txt",
    })));
    expect(symlink.ok).toBe(false);
    expect(symlink.error).toContain("symlink");
    expect(readFileSync(join(state.main, "project", "marker.txt"), "utf8")).toBe("main-only");
  });

  test("rejects hardlink aliases for both file reads and writes", async () => {
    const state = fixture();
    const outside = join(state.main, "project", "marker.txt");
    linkSync(outside, join(state.executorRoot, "project", "outside-alias.txt"));
    const read = responseValue(await state.coordinator.handle(state.request("read_file", {
      path: "project/outside-alias.txt",
    })));
    expect(read.ok).toBe(false);
    expect(read.error).toContain("hard-linked");

    const write = responseValue(await state.coordinator.handle(state.request("write_file", {
      path: "project/outside-alias.txt",
      content: "escaped",
      expectedSha256: sha256("main-only"),
    })));
    expect(write.ok).toBe(false);
    expect(write.error).toContain("hard-linked");
    expect(readFileSync(outside, "utf8")).toBe("main-only");
  });

  test("rejects a workspace root replaced after local approval", async () => {
    const state = fixture();
    renameSync(state.executorRoot, `${state.executorRoot}-approved`);
    mkdirSync(join(state.executorRoot, "project"), { recursive: true });
    writeFileSync(join(state.executorRoot, "project", "marker.txt"), "replacement-root");
    const result = responseValue(await state.coordinator.handle(state.request("read_file", {
      path: "project/marker.txt",
    })));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("root identity changed");
  });

  test("fails closed while the selected executor is offline and never invokes another path", async () => {
    const state = fixture();
    state.setOnline(false);
    const response = await state.coordinator.handle(state.request("exec", {
      command: ["/bin/true"],
    }));
    expect(response.result.success).toBe(false);
    expect(responseValue(response).error).toContain("local fallback is disabled");
    expect(state.invokeCount()).toBe(0);
  });

  test("keeps command execution disabled by default until an OS sandbox is supplied", async () => {
    const state = fixture();
    const locked = new RemoteWorkspaceExecutor({
      deviceId: "locked-device",
      roots: [{ id: "project-root", path: state.executorRoot }],
    });
    const result = await locked.invoke({
      requestId: randomUUID(),
      sessionId: randomUUID(),
      executorDeviceId: "locked-device",
      rootId: "project-root",
      tool: "exec",
      arguments: { command: ["/bin/true"] },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("OS sandbox");
  });

  test("rejects unbound threads and non-remote namespaces before transport", async () => {
    const state = fixture();
    const unbound = state.request("read_file", { path: "project/marker.txt" });
    (unbound.params as Record<string, unknown>).threadId = `other-${randomUUID()}`;
    expect(responseValue(await state.coordinator.handle(unbound)).error).toContain("not bound");

    const wrongNamespace = state.request("read_file", { path: "project/marker.txt" });
    (wrongNamespace.params as Record<string, unknown>).namespace = "local_workspace";
    expect(responseValue(await state.coordinator.handle(wrongNamespace)).error).toContain("identity");
    expect(state.invokeCount()).toBe(0);
  });

  test("carries coordinator requests and executor results over the authenticated E2EE channel", async () => {
    const state = fixture();
    const account = generateRemoteControlIdentityKeyPair();
    const device = generateRemoteControlIdentityKeyPair();
    const cryptoDeviceId = randomUUID();
    const cryptoSessionId = randomUUID();
    const clientHandshake = RemoteControlClientHandshake.create({
      sessionId: cryptoSessionId,
      deviceId: cryptoDeviceId,
      commandProfile: "codex",
      capabilities: ["workspace.read", "workspace.write", "workspace.exec"],
      accountPrivateKey: account.privateKey,
    });
    const accepted = acceptRemoteControlClientHello(clientHandshake.hello, {
      expectedSessionId: cryptoSessionId,
      expectedDeviceId: cryptoDeviceId,
      accountPublicKey: account.publicKey,
      devicePrivateKey: device.privateKey,
      allowedCapabilities: ["workspace.read", "workspace.write", "workspace.exec"],
    });
    const clientCipher = clientHandshake.complete(accepted.hello, device.publicKey);

    let client: EncryptedRemoteWorkspaceTransport;
    let endpoint: EncryptedRemoteWorkspaceExecutorEndpoint;
    client = new EncryptedRemoteWorkspaceTransport({
      executorDeviceId: `device-${cryptoDeviceId}`,
      cipher: clientCipher,
      sendCiphertext: value => endpoint.receiveCiphertext(value),
      timeoutMs: 5_000,
    });
    const encryptedExecutor = new RemoteWorkspaceExecutor({
      deviceId: `device-${cryptoDeviceId}`,
      roots: [{ id: "project-root", path: state.executorRoot }],
    });
    endpoint = new EncryptedRemoteWorkspaceExecutorEndpoint({
      executorDeviceId: `device-${cryptoDeviceId}`,
      cipher: accepted.cipher,
      executor: encryptedExecutor,
      sendCiphertext: value => client.receiveCiphertext(value),
    });

    const result = await client.invoke({
      requestId: randomUUID(),
      sessionId: cryptoSessionId,
      executorDeviceId: `device-${cryptoDeviceId}`,
      rootId: "project-root",
      tool: "read_file",
      arguments: { path: "project/marker.txt" },
    });
    expect(result).toMatchObject({ ok: true, value: { content: "executor-before" } });
    expect(JSON.stringify(result)).not.toContain(state.main);
    client.close();
  });

  test("fragments large writes and reads without raising the relay frame memory limit", async () => {
    const state = fixture();
    const account = generateRemoteControlIdentityKeyPair();
    const device = generateRemoteControlIdentityKeyPair();
    const cryptoDeviceId = randomUUID();
    const cryptoSessionId = randomUUID();
    const clientHandshake = RemoteControlClientHandshake.create({
      sessionId: cryptoSessionId,
      deviceId: cryptoDeviceId,
      commandProfile: "codex",
      capabilities: ["workspace.read", "workspace.write"],
      accountPrivateKey: account.privateKey,
    });
    const accepted = acceptRemoteControlClientHello(clientHandshake.hello, {
      expectedSessionId: cryptoSessionId,
      expectedDeviceId: cryptoDeviceId,
      accountPublicKey: account.publicKey,
      devicePrivateKey: device.privateKey,
      allowedCapabilities: ["workspace.read", "workspace.write"],
    });
    const clientCipher = clientHandshake.complete(accepted.hello, device.publicKey);
    const content = "remote-fragment\n".repeat(10_000);

    let client: EncryptedRemoteWorkspaceTransport;
    let endpoint: EncryptedRemoteWorkspaceExecutorEndpoint;
    client = new EncryptedRemoteWorkspaceTransport({
      executorDeviceId: `device-${cryptoDeviceId}`,
      cipher: clientCipher,
      sendCiphertext: value => endpoint.receiveCiphertext(value),
      timeoutMs: 5_000,
    });
    endpoint = new EncryptedRemoteWorkspaceExecutorEndpoint({
      executorDeviceId: `device-${cryptoDeviceId}`,
      cipher: accepted.cipher,
      executor: new RemoteWorkspaceExecutor({
        deviceId: `device-${cryptoDeviceId}`,
        roots: [{ id: "project-root", path: state.executorRoot }],
      }),
      sendCiphertext: value => client.receiveCiphertext(value),
    });

    const write = await client.invoke({
      requestId: randomUUID(),
      sessionId: cryptoSessionId,
      executorDeviceId: `device-${cryptoDeviceId}`,
      rootId: "project-root",
      tool: "write_file",
      arguments: { path: "project/large.txt", content, expectedSha256: null },
    });
    expect(write).toMatchObject({ ok: true, value: { bytes: Buffer.byteLength(content) } });
    const read = await client.invoke({
      requestId: randomUUID(),
      sessionId: cryptoSessionId,
      executorDeviceId: `device-${cryptoDeviceId}`,
      rootId: "project-root",
      tool: "read_file",
      arguments: { path: "project/large.txt", maxBytes: REMOTE_WORKSPACE_MAX_TOOL_RESULT_BYTES },
    });
    expect(read).toMatchObject({ ok: true, value: { content } });
    client.close();
    endpoint.close();
  });
});
