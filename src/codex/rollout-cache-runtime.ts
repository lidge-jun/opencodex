import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CacheRuntimeState } from "../anthropic/cache-renewal";
import { getCodexHome, resolveCodexStateDbPath } from "./paths";
import { openCodexStateForPreflight } from "./history-state-open";
import { nativeThreadWriterHeld } from "./thread-writer-lock";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const UNKNOWN: CacheRuntimeState = { running: false, turn: null };
const MAX_LINE = 1024 * 1024;
export interface RolloutRuntimeDependencies {
  home(): string;
  statePath(): string;
  writerHeld(path: string): boolean;
}
const defaults: RolloutRuntimeDependencies = {
  home: getCodexHome, statePath: resolveCodexStateDbPath, writerHeld: nativeThreadWriterHeld,
};

/** 隐藏子代理没有前端owner：自身生命周期决定运行，原生锁排除进程退出后的旧日志。 */
export class RolloutCacheRuntime {
  private path?: string;
  private lock?: string;
  private identity?: string;
  private offset = 0;
  private partial = Buffer.alloc(0);
  private oversized = false;
  private metadata = false;
  private lifecycle = UNKNOWN;
  private lifecycleReason = "unconfirmed-lifecycle";
  private closed = false;
  private pending?: Promise<CacheRuntimeState>;
  private timer: ReturnType<typeof setInterval>;
  private last?: string;
  current = UNKNOWN;

  constructor(private thread: string, private turn: string,
    private update: (state: CacheRuntimeState, reason: string) => void,
    private deps: RolloutRuntimeDependencies = defaults) {
    this.timer = setInterval(() => { void this.refresh(); }, 1000);
    this.timer.unref();
    void Promise.resolve().then(() => this.refresh());
  }

  refresh(): Promise<CacheRuntimeState> {
    if (this.closed) return Promise.resolve(UNKNOWN);
    if (this.pending) return this.pending;
    const pending = this.inspect();
    this.pending = pending;
    void pending.finally(() => { if (this.pending === pending) this.pending = undefined; });
    return pending;
  }

  private publish(state: CacheRuntimeState, reason: string): CacheRuntimeState {
    if (this.closed) return UNKNOWN;
    this.current = state;
    const key = JSON.stringify([state.running, state.turn, reason]);
    if (this.last !== key) { this.last = key; this.update(state, reason); }
    return state;
  }

  private line(bytes: Buffer, oversized: boolean): void {
    if (!bytes.length) return;
    if (oversized) {
      // 原生记录头先于正文；摘要和轮次上下文不改变任务生命周期，大小不应阻断后续终态。
      const header = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, 256), { stream: true });
      if (/^\{"timestamp":"[^"\n]+",(?:"ordinal":\d+,)?"type":"(?:response_item|token_usage_record|compacted|turn_context)",/.test(header)) return;
      if (/^\{"timestamp":"[^"\n]+",(?:"ordinal":\d+,)?"type":"event_msg","payload":\{"type":"item_completed",/.test(header)) return;
      throw new Error("unsupported-large-runtime-record");
    }
    const row = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!this.metadata) {
      if (row.type !== "session_meta" || row.payload?.id !== this.thread) throw new Error("runtime-thread-mismatch");
      this.metadata = true;
      return;
    }
    if (row.type === "session_meta") {
      if (row.payload?.id !== this.thread) throw new Error("runtime-thread-mismatch");
      return;
    }
    if (row.type !== "event_msg") return;
    const event = row.payload;
    if (event?.type === "task_started") {
      this.lifecycle = UUID.test(event.turn_id ?? "") ? { running: true, turn: event.turn_id } : UNKNOWN;
      this.lifecycleReason = this.lifecycle.running ? "task-started" : "unsupported-lifecycle";
    } else if (event?.type === "task_complete" || event?.type === "turn_aborted") {
      if (!event.turn_id || event.turn_id === this.lifecycle.turn) {
        this.lifecycle = UNKNOWN;
        this.lifecycleReason = event.type;
      }
    }
  }

  private consume(chunk: Buffer): void {
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(10, start);
      const part = chunk.subarray(start, end < 0 ? chunk.length : end);
      if (!this.oversized && this.partial.length + part.length <= MAX_LINE) this.partial = Buffer.concat([this.partial, part]);
      else { this.oversized = true; if (this.partial.length < 256) this.partial = Buffer.concat([this.partial, part.subarray(0, 256 - this.partial.length)]); }
      if (end < 0) return;
      this.line(this.partial, this.oversized);
      this.partial = Buffer.alloc(0); this.oversized = false; start = end + 1;
      if (start === chunk.length) return;
    }
  }

  private async inspect(): Promise<CacheRuntimeState> {
    try {
      if (!UUID.test(this.thread) || !UUID.test(this.turn)) return this.publish(UNKNOWN, "unsupported-identity");
      if (!this.path) {
        const db = openCodexStateForPreflight(this.deps.statePath());
        try {
          const row = db.query<{ rollout_path: string }, [string]>("SELECT rollout_path FROM threads WHERE id = ?").get(this.thread);
          if (!row?.rollout_path?.endsWith(".jsonl")) return this.publish(UNKNOWN, "rollout-unavailable");
          this.path = row.rollout_path;
          this.lock = join(this.deps.home(), "thread-writer-locks", this.thread + ".lock");
        } finally { db.close(); }
      }
      if (!this.deps.writerHeld(this.lock!)) return this.publish(UNKNOWN, "writer-unavailable");
      const info = await stat(this.path);
      const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
      if (this.identity && (identity !== this.identity || info.size < this.offset)) return this.publish(UNKNOWN, "rollout-replaced");
      this.identity = identity;
      const handle = await open(this.path, "r");
      try {
        const opened = await handle.stat();
        if (`${opened.dev}:${opened.ino}:${opened.birthtimeMs}` !== identity) throw new Error("runtime-file-changed");
        const bytes = Buffer.alloc(256 * 1024);
        while (!this.closed && this.offset < info.size) {
          const { bytesRead } = await handle.read(bytes, 0, Math.min(bytes.length, info.size - this.offset), this.offset);
          if (!bytesRead) throw new Error("runtime-short-read");
          this.consume(bytes.subarray(0, bytesRead)); this.offset += bytesRead;
        }
      } finally { await handle.close(); }
      if (!this.deps.writerHeld(this.lock!)) return this.publish(UNKNOWN, "writer-unavailable");
      const state = this.metadata && this.lifecycle.running && this.lifecycle.turn === this.turn ? this.lifecycle : UNKNOWN;
      return this.publish(state, state.running ? "own-turn-active"
        : this.lifecycle.running ? "turn-replaced" : this.lifecycleReason);
    } catch (error) {
      const reason = error instanceof Error && ["unsupported-large-runtime-record", "runtime-thread-mismatch", "runtime-short-read", "runtime-file-changed"].includes(error.message)
        ? error.message : "runtime-unreadable";
      return this.publish(UNKNOWN, reason);
    }
  }

  close(): void {
    this.closed = true; clearInterval(this.timer); this.partial = Buffer.alloc(0); this.current = UNKNOWN;
  }
}
