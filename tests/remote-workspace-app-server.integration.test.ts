import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  REMOTE_WORKSPACE_TOOL_NAMESPACE,
  EncryptedRemoteWorkspaceExecutorEndpoint,
  EncryptedRemoteWorkspaceTransport,
  RemoteControlClientHandshake,
  RemoteWorkspaceCoordinator,
  RemoteWorkspaceExecutor,
  acceptRemoteControlClientHello,
  generateRemoteControlIdentityKeyPair,
  remoteWorkspaceThreadStartParams,
  startRemoteWorkspaceToolBridge,
  type RemoteWorkspaceTransport,
  type RemoteWorkspaceCommandRunner,
} from "../src/remote-control";
import { removeTreeWithRetry } from "./helpers/remove-tree";

interface JsonMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

interface CapturedResponsesRequest {
  input?: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
}

function sse(events: unknown[]): string {
  return events.map(event => {
    const type = (event as { type: string }).type;
    return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
  }).join("");
}

function completed(id: string): unknown {
  return {
    type: "response.completed",
    response: {
      id,
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
    },
  };
}

function responseCreated(id: string): unknown {
  return { type: "response.created", response: { id } };
}

class JsonLinePeer {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = "";

  constructor(
    stdout: ReadableStream<Uint8Array>,
    private readonly stdin: FileSink,
  ) {
    this.reader = stdout.getReader();
  }

  send(message: unknown): void {
    this.stdin.write(`${JSON.stringify(message)}\n`);
    this.stdin.flush();
  }

  async next(timeoutMs = 10_000): Promise<JsonMessage> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline >= 0) {
        const line = this.buffer.slice(0, newline).replace(/\r$/, "");
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        return JSON.parse(line) as JsonMessage;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("timed out waiting for Codex App Server JSON-RPC");
      const next = await Promise.race([
        this.reader.read(),
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error("timed out waiting for Codex App Server output")),
          remaining,
        )),
      ]);
      if (next.done) throw new Error("Codex App Server closed its output");
      this.buffer += new TextDecoder().decode(next.value, { stream: true });
    }
  }

  async waitFor(predicate: (message: JsonMessage) => boolean): Promise<JsonMessage> {
    for (let count = 0; count < 200; count += 1) {
      const message = await this.next();
      if (predicate(message)) return message;
    }
    throw new Error("Codex App Server did not emit the expected message");
  }
}

const codexBin = process.env.OCX_CODEX_BIN;
const appServerTest = codexBin ? test : test.skip;

const localIntegrationCommandRunner: RemoteWorkspaceCommandRunner = {
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
      if (timedOut) throw new Error("local integration command timed out");
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > request.maxOutputBytes) {
        throw new Error("local integration command output limit exceeded");
      }
      return { stdout, stderr, exitCode };
    } finally {
      clearTimeout(timer);
    }
  },
};

appServerTest("real Codex App Server delegates a dynamic workspace tool to Computer 2", async () => {
  if (!codexBin || !existsSync(codexBin)) throw new Error("OCX_CODEX_BIN must identify a real Codex executable");
  const root = mkdtempSync(join(tmpdir(), "ocx-remote-app-server-"));
  const mainHome = join(root, "main-home");
  const mainCodexHome = join(root, "main-codex");
  const mainOcxHome = join(root, "main-ocx");
  const sandboxBin = join(root, "sandbox-bin");
  const coordinatorIsolation = join(root, "coordinator-isolation");
  const executorRoot = join(root, "computer-2-workspace");
  const hubSecret = join(root, "hub-secret.txt");
  for (const path of [mainHome, mainCodexHome, mainOcxHome, coordinatorIsolation, executorRoot, sandboxBin]) {
    mkdirSync(path, { recursive: true });
  }
  linkSync(codexBin, join(sandboxBin, "codex-linux-sandbox"));
  writeFileSync(join(coordinatorIsolation, "integration-marker.txt"), "main-unchanged");
  writeFileSync(hubSecret, "HUB-SECRET-MUST-NOT-LEAK");

  const requestBodies: unknown[] = [];
  let responseIndex = 0;
  const modelServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/responses")) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      const requestBody = await request.json() as CapturedResponsesRequest;
      requestBodies.push(requestBody);
      responseIndex += 1;
      if (responseIndex === 1) {
        const hasCodeMode = JSON.stringify(requestBody.input).includes('"name":"functions"')
          && JSON.stringify(requestBody.input).includes('"name":"exec"');
        if (!hasCodeMode) {
          return new Response(sse([
            responseCreated("resp-remote-no-tool"),
            {
              type: "response.output_item.done",
              item: {
                type: "message",
                role: "assistant",
                id: "msg-no-remote-tool",
                content: [{ type: "output_text", text: "Remote tool unavailable" }],
              },
            },
            completed("resp-remote-no-tool"),
          ]), { headers: { "content-type": "text/event-stream" } });
        }
        return new Response(sse([
          responseCreated("resp-remote-1"),
          {
            type: "response.output_item.done",
            item: {
              type: "custom_tool_call",
              call_id: "remote-exec-call",
              namespace: "functions",
              name: "exec",
              input: [
                "const result = await tools.mcp__ocx_remote_workspace__exec({",
                "  command: ['/bin/sh', '-lc', \"printf 'computer-2' > integration-marker.txt; printf 'executor-cwd:'; pwd\"],",
                "  cwd: '.',",
                "  timeoutMs: 5000,",
                "});",
                "let localProbe;",
                `try { localProbe = await tools.exec_command({ cmd: ${JSON.stringify(`cat -- ${JSON.stringify(hubSecret)}`)} }); }`,
                "catch (error) { localProbe = String(error); }",
                "text(JSON.stringify({ result, localProbe }));",
              ].join("\n"),
            },
          },
          completed("resp-remote-1"),
        ]), { headers: { "content-type": "text/event-stream" } });
      }
      if (responseIndex === 2) {
        return new Response(sse([
          responseCreated("resp-remote-2"),
          {
            type: "response.output_item.done",
            item: {
              type: "message",
              role: "assistant",
              id: "msg-remote-done",
              content: [{ type: "output_text", text: "Remote workspace complete" }],
            },
          },
          completed("resp-remote-2"),
        ]), { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ error: "unexpected_request" }, { status: 500 });
    },
  });

  const config = [
    'model = "gpt-5.6-sol"',
    'model_provider = "ocx_remote_spike"',
    'approval_policy = "never"',
    '',
    '[model_providers.ocx_remote_spike]',
    'name = "OCX Remote Spike"',
    `base_url = "${new URL("/v1", modelServer.url).toString().replace(/\/$/, "")}"`,
    'env_key = "OCX_REMOTE_SPIKE_API_KEY"',
    'wire_api = "responses"',
    'supports_websockets = false',
    '',
  ].join("\n");
  writeFileSync(join(mainCodexHome, "config.toml"), config, { mode: 0o600 });

  const deviceId = randomUUID();
  const executor = new RemoteWorkspaceExecutor({
    deviceId,
    roots: [{ id: "selected-folder", path: executorRoot }],
    commandRunner: localIntegrationCommandRunner,
  });
  const accountIdentity = generateRemoteControlIdentityKeyPair();
  const deviceIdentity = generateRemoteControlIdentityKeyPair();
  const transportSessionId = randomUUID();
  const handshake = RemoteControlClientHandshake.create({
    sessionId: transportSessionId,
    deviceId,
    commandProfile: "codex",
    capabilities: ["workspace.read", "workspace.write", "workspace.exec"],
    accountPrivateKey: accountIdentity.privateKey,
  });
  const accepted = acceptRemoteControlClientHello(handshake.hello, {
    expectedSessionId: transportSessionId,
    expectedDeviceId: deviceId,
    accountPublicKey: accountIdentity.publicKey,
    devicePrivateKey: deviceIdentity.privateKey,
    allowedCapabilities: ["workspace.read", "workspace.write", "workspace.exec"],
  });
  let encryptedTransport: EncryptedRemoteWorkspaceTransport;
  let executorEndpoint: EncryptedRemoteWorkspaceExecutorEndpoint;
  encryptedTransport = new EncryptedRemoteWorkspaceTransport({
    executorDeviceId: deviceId,
    cipher: handshake.complete(accepted.hello, deviceIdentity.publicKey),
    sendCiphertext: value => executorEndpoint.receiveCiphertext(value),
    timeoutMs: 5_000,
  });
  executorEndpoint = new EncryptedRemoteWorkspaceExecutorEndpoint({
    executorDeviceId: deviceId,
    cipher: accepted.cipher,
    executor,
    sendCiphertext: value => encryptedTransport.receiveCiphertext(value),
  });
  const transport: RemoteWorkspaceTransport = encryptedTransport;
  const coordinator = new RemoteWorkspaceCoordinator(transport);
  const threadRef = { id: "" };
  const bridge = startRemoteWorkspaceToolBridge({
    coordinator,
    threadId: () => threadRef.id,
    tools: ["list_directory", "read_file", "write_file", "exec"],
  });
  const mcpTokenEnv = "OCX_REMOTE_WORKSPACE_MCP_TOKEN";
  const mcpPrefix = `mcp_servers.${REMOTE_WORKSPACE_TOOL_NAMESPACE}`;

  const appServer = Bun.spawn([
    codexBin,
    "-c", `${mcpPrefix}.url=${JSON.stringify(`${bridge.url}/mcp`)}`,
    "-c", `${mcpPrefix}.bearer_token_env_var=${JSON.stringify(mcpTokenEnv)}`,
    "-c", `${mcpPrefix}.required=true`,
    "-c", `${mcpPrefix}.enabled_tools=["list_directory","read_file","write_file","exec"]`,
    "-c", `${mcpPrefix}.default_tools_approval_mode="approve"`,
    "app-server", "--listen", "stdio://",
  ], {
    cwd: coordinatorIsolation,
    env: {
      PATH: `${sandboxBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: mainHome,
      CODEX_HOME: mainCodexHome,
      OPENCODEX_HOME: mainOcxHome,
      OCX_REMOTE_SPIKE_API_KEY: "test-only-not-a-real-key",
      [mcpTokenEnv]: bridge.token,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderrPromise = new Response(appServer.stderr).text();
  const peer = new JsonLinePeer(appServer.stdout, appServer.stdin);

  try {
    peer.send({
      method: "initialize",
      id: 0,
      params: {
        clientInfo: { name: "ocx_remote_workspace_test", title: "OCX Remote Workspace Test", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      },
    });
    const initialized = await peer.waitFor(message => message.id === 0);
    expect(initialized.error).toBeUndefined();
    peer.send({ method: "initialized", params: {} });

    peer.send({
      method: "thread/start",
      id: 1,
      params: {
        ...remoteWorkspaceThreadStartParams({
          executorName: "Computer 2",
          coordinatorIsolationPath: coordinatorIsolation,
          tools: ["list_directory", "read_file", "write_file", "exec"],
          mcp: {
            url: `${bridge.url}/mcp`,
            bearerTokenEnvVar: mcpTokenEnv,
            hubRuntimeReadPaths: [dirname(realpathSync(codexBin)), sandboxBin],
          },
        }),
        model: "gpt-5.6-sol",
        modelProvider: "ocx_remote_spike",
        ephemeral: true,
      },
    });
    const threadResponse = await peer.waitFor(message => message.id === 1);
    expect(threadResponse.error).toBeUndefined();
    const thread = threadResponse.result?.thread as { id?: string } | undefined;
    if (!thread?.id) throw new Error("Codex App Server did not return a thread ID");
    threadRef.id = thread.id;
    coordinator.register({
      sessionId: `session-${thread.id}`,
      threadId: thread.id,
      executorDeviceId: deviceId,
      executorName: "Computer 2",
      rootId: "selected-folder",
      capabilities: ["workspace.read", "workspace.write", "workspace.exec"],
      tools: ["list_directory", "read_file", "write_file", "exec"],
    });

    peer.send({
      method: "turn/start",
      id: 2,
      params: {
        threadId: thread.id,
        input: [{ type: "text", text: "Create the marker in the selected remote workspace." }],
        approvalPolicy: "never",
      },
    });

    let turnCompleted = false;
    for (let count = 0; count < 200 && !turnCompleted; count += 1) {
      const message = await peer.next();
      if (message.method === "item/tool/call" && message.id !== undefined) {
        const response = await coordinator.handle({
          method: "item/tool/call",
          id: message.id,
          params: message.params,
        });
        peer.send(response);
      }
      if (message.method === "turn/completed") turnCompleted = true;
      if (message.id === 2 && message.error) throw new Error(`turn/start failed: ${JSON.stringify(message.error)}`);
    }

    expect(turnCompleted).toBe(true);
    expect(existsSync(join(executorRoot, "integration-marker.txt"))).toBe(true);
    expect(readFileSync(join(executorRoot, "integration-marker.txt"), "utf8")).toBe("computer-2");
    expect(readFileSync(join(coordinatorIsolation, "integration-marker.txt"), "utf8")).toBe("main-unchanged");
    expect(requestBodies).toHaveLength(2);
    expect(JSON.stringify(requestBodies[0])).toContain(REMOTE_WORKSPACE_TOOL_NAMESPACE);
    // Current Codex consolidates MCP into the sandboxed functions.exec code-mode tool.
    // Executing the nested remote helper above proves the registered MCP server is callable.
    expect(JSON.stringify((requestBodies[0] as CapturedResponsesRequest).input)).toContain('"name":"functions"');
    const followUp = requestBodies[1] as CapturedResponsesRequest;
    const toolOutput = followUp.input?.find(item => item.type === "custom_tool_call_output");
    expect(toolOutput).toBeDefined();
    const serializedToolOutput = JSON.stringify(toolOutput);
    expect(serializedToolOutput).toContain("executor-cwd:");
    expect(serializedToolOutput).toContain(executorRoot);
    expect(serializedToolOutput).not.toContain(coordinatorIsolation);
    expect(serializedToolOutput).not.toContain("HUB-SECRET-MUST-NOT-LEAK");
  } finally {
    encryptedTransport.close();
    appServer.kill();
    await appServer.exited;
    await stderrPromise;
    await modelServer.stop(true);
    await bridge.stop();
    removeTreeWithRetry(root);
  }
}, 30_000);
