import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import type { CacheRuntimeState } from "../anthropic/cache-renewal";
import { RolloutCacheRuntime, type RolloutRuntimeDependencies } from "./rollout-cache-runtime";

const UNKNOWN: CacheRuntimeState = { running: false, turn: null };
const ROOTS = new Set(["id", "hostId", "threadRuntimeStatus", "latestTurnStartMessageId"]);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function projectCacheRuntime(state: Record<string, any>): CacheRuntimeState {
  const turn = state.latestTurnStartMessageId;
  return { running: state.threadRuntimeStatus?.type === "active",
    turn: typeof turn === "string" && turn.length > 0 ? turn : null };
}

export function applyRuntimePatches(state: Record<string, any>, patches: unknown): Record<string, any> {
  if (!Array.isArray(patches)) throw new Error("invalid-runtime-patches");
  const next = structuredClone(state);
  for (const patch of patches) {
    if (!patch || !Array.isArray(patch.path) || !patch.path.length) throw new Error("invalid-runtime-path");
    if (!ROOTS.has(patch.path[0])) continue;
    if (!["add", "replace", "remove"].includes(patch.op)
      || patch.path.some((part: unknown) => typeof part !== "string" && typeof part !== "number"
        || ["__proto__", "prototype", "constructor"].includes(String(part)))) throw new Error("invalid-runtime-patch");
    let target: any = next;
    for (const part of patch.path.slice(0, -1)) {
      if (!target[part] || typeof target[part] !== "object") throw new Error("missing-runtime-path");
      target = target[part];
    }
    const key = patch.path.at(-1);
    if (patch.op === "remove") delete target[key];
    else target[key] = structuredClone(patch.value);
  }
  return next;
}

class ThreadRuntimeSubscription {
  private socket?: Socket;
  private buffer = Buffer.alloc(0);
  private client?: string;
  private owner?: string;
  private state: Record<string, any> = {};
  private revision?: number;
  private closed = false;
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private snapshots = new Set<(value: CacheRuntimeState) => void>();
  current = UNKNOWN;
  available = false;

  constructor(readonly thread: string, private update: (state: CacheRuntimeState) => void,
    private readonly pipe: string = "\\\\.\\pipe\\codex-ipc") {
    this.socket = connect(pipe);
    this.socket.unref();
    this.socket.on("data", chunk => this.receive(Buffer.from(chunk)));
    this.socket.on("error", () => this.close());
    this.socket.on("close", () => this.close());
    void this.initialize().catch(() => this.close());
  }

  private send(message: object): void {
    if (this.closed || !this.socket) throw new Error("runtime-ipc-unavailable");
    const bytes = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length);
    this.socket.write(Buffer.concat([header, bytes]));
  }

  private request(method: "initialize" | "thread-owner-discovery", params: object, version: number): Promise<any> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error("runtime-ipc-timeout")); }, 3000);
      timer.unref();
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.send({ type: "request", requestId, sourceClientId: this.client ?? "initializing-client", version, method, params, timeoutMs: 3000 }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }

  private following(value: boolean): void {
    this.send({ type: "broadcast", sourceClientId: this.client, version: 1, method: "thread-stream-following-changed",
      targetClientIds: [this.owner], params: { conversationId: this.thread, hostId: "local", following: value } });
  }

  private async initialize(): Promise<void> {
    const initialized = await this.request("initialize", { clientType: "opencodex-cache-renewal" }, 0);
    this.client = initialized.result?.clientId;
    if (!this.client) throw new Error("runtime-ipc-initialize-failed");
    const owner = await this.request("thread-owner-discovery", { hostId: "local", conversationId: this.thread }, 1);
    if (owner.resultType !== "success" || !owner.handledByClientId) throw new Error("runtime-ipc-owner-missing");
    this.owner = owner.handledByClientId;
    this.following(true);
  }

  private receive(chunk: Buffer): void {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const size = this.buffer.readUInt32LE(0);
        if (size > 64 * 1024 * 1024) throw new Error("runtime-ipc-frame-limit");
        if (this.buffer.length < size + 4) break;
        const message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.buffer.subarray(4, 4 + size)));
        this.buffer = this.buffer.subarray(4 + size);
        const pending = this.pending.get(message.requestId);
        if (pending) { this.pending.delete(message.requestId); clearTimeout(pending.timer); pending.resolve(message); continue; }
        if (message.method === "ipc-connection-reset" || message.method === "client-status-changed"
          && message.params?.clientId === this.owner && message.params?.status !== "connected") { this.close(); return; }
        if (message.method !== "thread-stream-state-changed" || message.sourceClientId !== this.owner) continue;
        const params = message.params;
        if (params?.conversationId !== this.thread) continue;
        if (params.hostId !== "local" || message.version !== 11) throw new Error("runtime-ipc-protocol-changed");
        const change = params.change;
        if (!Number.isSafeInteger(change?.revision)) throw new Error("runtime-ipc-revision-missing");
        if (change.type === "snapshot") {
          if (change.conversationState?.id !== this.thread) throw new Error("runtime-ipc-thread-mismatch");
          this.state = Object.fromEntries([...ROOTS].map(key => [key, change.conversationState[key]]));
        } else {
          if (change.baseRevision !== this.revision) throw new Error("runtime-ipc-revision-gap");
          this.state = applyRuntimePatches(this.state, change.patches);
        }
        this.revision = change.revision;
        this.available = true;
        this.current = projectCacheRuntime(this.state);
        this.update(this.current);
        for (const listener of this.snapshots) listener(this.current);
        this.snapshots.clear();
      }
    } catch { this.close(); }
  }

  refresh(): Promise<CacheRuntimeState> {
    if (this.closed || !this.owner) return Promise.resolve(UNKNOWN);
    return new Promise(resolve => {
      const done = (state: CacheRuntimeState) => { clearTimeout(timer); this.snapshots.delete(done); resolve(state); };
      const timer = setTimeout(() => { this.close(); done(UNKNOWN); }, 3000); timer.unref();
      this.snapshots.add(done);
      try { this.following(true); } catch { this.close(); done(UNKNOWN); }
    });
  }

  close(): void {
    if (this.closed) return;
    try { if (this.owner) this.following(false); }
    catch { this.socket?.destroy(); } // A failed unsubscribe still closes the local subscription.
    this.closed = true;
    this.available = false;
    for (const row of this.pending.values()) { clearTimeout(row.timer); row.reject(new Error("runtime-ipc-closed")); }
    this.pending.clear();
    this.current = UNKNOWN;
    this.update(UNKNOWN);
    for (const listener of this.snapshots) listener(UNKNOWN);
    this.snapshots.clear();
    this.socket?.destroy();
    this.buffer = Buffer.alloc(0);
  }
}

export class CodexCacheRuntime {
  private subscriptions = new Map<string, { refresh(): Promise<CacheRuntimeState>; close(): void }>();
  constructor(private readonly pipe?: string, private readonly rolloutDeps?: RolloutRuntimeDependencies) {}
  watch(thread: string, update: (state: CacheRuntimeState) => void, expectedTurn?: string): () => void {
    let closed = false;
    let fallback: RolloutCacheRuntime | undefined;
    let last: string | undefined;
    const publish = (state: CacheRuntimeState, source: string, reason: string) => {
      if (closed) return;
      const key = JSON.stringify([source, state.running, state.turn, reason]);
      if (last !== key && UUID.test(thread) && expectedTurn && UUID.test(expectedTurn)) {
        last = key;
        console.info("[codex-cache-runtime]", JSON.stringify({ threadId: thread,
          turnId: expectedTurn, source, running: state.running, reason }));
      }
      update(state);
    };
    const secondary = () => {
      if (!expectedTurn) { publish(UNKNOWN, "unavailable", "own-turn-missing"); return; }
      return fallback ??= new RolloutCacheRuntime(thread, expectedTurn,
        (state, reason) => publish(state, "rollout-writer", reason), this.rolloutDeps);
    };
    const primary = new ThreadRuntimeSubscription(thread, state => {
      if (closed) return;
      if (primary.available) {
        fallback?.close(); fallback = undefined;
        publish(state, "ipc", "ipc-state");
      } else secondary();
    }, this.pipe);
    const subscription = {
      async refresh() {
        if (closed) return UNKNOWN;
        if (primary.available) {
          const state = await primary.refresh();
          if (primary.available) return state;
        }
        return await secondary()?.refresh() ?? UNKNOWN;
      },
      close() { closed = true; primary.close(); fallback?.close(); fallback = undefined; },
    };
    this.subscriptions.set(thread, subscription);
    return () => {
      if (this.subscriptions.get(thread) === subscription) this.subscriptions.delete(thread);
      subscription.close();
    };
  }
  async active(thread: string): Promise<boolean> {
    const current = this.subscriptions.get(thread);
    const state = await current?.refresh();
    return state?.running === true;
  }
}
