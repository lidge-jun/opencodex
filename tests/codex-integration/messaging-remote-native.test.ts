import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MessageBudget } from "../../src/messaging/budget";
import { RemoteCapacity } from "../../src/messaging/remote-contract";
import { spawnRemoteHelper } from "../../src/messaging/remote-process";
import { localDaemonEndpoint, localSocket } from "../../src/messaging/socket";
import { sendRemoteMessage } from "../../src/messaging/remote-send";
import { remoteMessagingPair } from "../helpers/messaging-remote";
import { LOCAL_OTHER } from "../helpers/messaging-local";

const native = process.env.OCX_MESSAGE_CODEX_BINARY;
test.skipIf(!native || process.platform === "win32")("isolated real native daemon accepts gateway queue receipt and completes a synthetic turn", async () => {
  const pair = remoteMessagingPair(), home = join(pair.b.root, "native"), work = join(pair.b.root, "work");
  mkdirSync(home, { mode: 0o700 }); mkdirSync(work, { mode: 0o700 });
  let modelRequests = 0;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    if (req.method !== "POST" || !new URL(req.url).pathname.endsWith("/responses")) return new Response(null, { status: 404 });
    modelRequests++;
    const events = [{ type: "response.created", response: { id: "fixture-response" } },
      { type: "response.output_item.done", item: { type: "message", role: "assistant", id: "fixture-item",
        content: [{ type: "output_text", text: "fixture complete" }] } },
      { type: "response.completed", response: { id: "fixture-response", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  } });
  writeFileSync(join(home, "config.toml"), `model = "fixture-model"\nmodel_provider = "fixture"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.fixture]\nname = "offline fixture"\nbase_url = "http://127.0.0.1:${provider.port}/v1"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\n`, { mode: 0o600 });
  const capacity = new RemoteCapacity(), child = spawnRemoteHelper([native!, "app-server", "--listen", "unix://"], capacity,
    undefined, undefined, { PATH: process.env.PATH, HOME: pair.b.root, CODEX_HOME: home, CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: "1" });
  let socket: ReturnType<typeof localSocket> | undefined, owners: Awaited<ReturnType<typeof pair.owners>> | undefined;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const budget = new MessageBudget();
  let nextId = 0;
  const request = (method: string, params: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
    budget.throwIfEnded();
    const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error("native fixture control timeout")); }, budget.remainingMs(10000));
    pending.set(id, { resolve, reject, timer }); socket!.send(JSON.stringify({ id, method, params }));
  });
  const abortPending = () => {
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error("native fixture ended")); }
    pending.clear(); socket?.terminate();
  };
  budget.signal.addEventListener("abort", abortPending, { once: true });
  try {
    const path = join(home, "app-server-control", "app-server-control.sock");
    while (!existsSync(path)) { budget.throwIfEnded(); await Bun.sleep(25); }
    socket = localSocket(localDaemonEndpoint(home).url);
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer); budget.signal.removeEventListener("abort", cancelled);
        socket!.onopen = socket!.onerror = socket!.onclose = null;
        if (error) reject(error); else resolve();
      };
      const cancelled = () => finish(new Error("native fixture cancelled"));
      const timer = setTimeout(() => finish(new Error("native fixture connect timeout")), budget.remainingMs(5000));
      budget.signal.addEventListener("abort", cancelled, { once: true });
      socket!.onopen = () => finish(); socket!.onerror = socket!.onclose = () => finish(new Error("native fixture control unavailable"));
      if (budget.signal.aborted) cancelled();
    });
    socket.onmessage = event => {
      const raw = JSON.parse(String(event.data)), call = pending.get(raw.id); if (!call) return;
      pending.delete(raw.id); clearTimeout(call.timer);
      if (raw.error) call.reject(new Error("native fixture setup rejected")); else call.resolve(raw.result);
    };
    await request("initialize", { clientInfo: { name: "isolated_fixture", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    socket.send(JSON.stringify({ method: "initialized", params: {} }));
    // Setup alone creates this disposable thread. The product gateway cannot admit thread/start.
    const thread = (await request("thread/start", { cwd: work, approvalPolicy: "never", sandbox: "read-only" })).thread.id;
    owners = await pair.owners(home);
    const receipt = await sendRemoteMessage(pair.aStore, { host: "worker", thread, kind: "request", body: "native gateway fixture" },
      { home: pair.a.codexHome, senderId: LOCAL_OTHER }, budget);
    expect(receipt.status).toBe("queued");
    let completed = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      budget.throwIfEnded();
      const result = await request("thread/read", { threadId: thread, includeTurns: true });
      if (result.thread.turns.some((turn: any) => turn.status === "completed" && JSON.stringify(turn).includes(receipt.messageId))) { completed = true; break; }
      await Bun.sleep(25);
    }
    expect(completed).toBe(true); expect(modelRequests).toBe(1);
    const reply = await sendRemoteMessage(pair.bStore, { host: pair.aStore.requireEnabled().machine.id,
      thread: LOCAL_OTHER, kind: "response", inReplyTo: receipt.messageId, body: "native fixture response" },
    { home, senderId: thread }, budget);
    expect(reply.status).toBe("queued");
  } finally {
    budget.signal.removeEventListener("abort", abortPending); abortPending();
    await owners?.close(); await child.close(); budget.dispose();
    await provider.stop(true); await pair.close();
  }
  expect(capacity.snapshot()).toEqual({ connections: 0, requests: 0, helpers: 0, outputBytes: 0 });
}, 45000);
