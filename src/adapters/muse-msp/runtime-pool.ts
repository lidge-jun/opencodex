import type { ProviderAdapter } from "../base";
import { MuseMspError } from "./connection";
import { createMuseNativeAdapter } from "./native-adapter";
import type { MuseMspRunner } from "./runner";

type OwnedRunner = Pick<MuseMspRunner, "run" | "onResponseRendered" | "close">;
type Entry = { runner: OwnedRunner; adapter: ProviderAdapter; targetKey: string; closing?: Promise<void> };

/**
 * Server-owned registry for native MSP sessions. The caller supplies a key that
 * changes whenever the route's executable, configuration or account binding
 * changes; it is an opaque route key, never a credential or a user-provided ID.
 * Adapters created for separate HTTP requests share the same session owner.
 */
export class MuseNativeRuntimePool {
  private readonly entries = new Map<string, Entry>();
  private readonly routes = new Map<string, { generation: number; key: string }>();
  private readonly routeLocks = new Map<string, Promise<void>>();
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly maxRuntimes = 16) {
    if (!Number.isSafeInteger(maxRuntimes) || maxRuntimes < 1 || maxRuntimes > 16) throw new MuseMspError("invalid_host_limit");
  }

  acquire(key: string, create: () => OwnedRunner, targetKey: string): ProviderAdapter {
    if (this.closed || typeof key !== "string" || !key || Buffer.byteLength(key) > 4096) throw new MuseMspError("unavailable_runtime");
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.closing) throw new MuseMspError("unavailable_runtime");
      if (existing.targetKey !== targetKey) throw new MuseMspError("runtime_binding_mismatch");
      return existing.adapter;
    }
    if (this.entries.size >= this.maxRuntimes) throw new MuseMspError("unavailable_runtime");
    const runner = create();
    try {
      const adapter = createMuseNativeAdapter(runner, targetKey);
      this.entries.set(key, { runner, adapter, targetKey });
      return adapter;
    } catch (error) { void Promise.resolve().then(() => runner.close()).catch(() => {}); throw error; }
  }

  /** Serialize generation changes and never revive a stale route after a newer one. */
  async acquireRoute(route: string, generation: number, key: string, create: () => OwnedRunner, targetKey: string): Promise<ProviderAdapter> {
    if (this.closed || typeof route !== "string" || !route || Buffer.byteLength(route) > 4096 || !Number.isSafeInteger(generation) || generation < 0) throw new MuseMspError("unavailable_runtime");
    const previous = this.routeLocks.get(route);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const tail = (previous ?? Promise.resolve()).then(() => held);
    this.routeLocks.set(route, tail);
    try {
      await previous;
      if (this.closed) throw new MuseMspError("unavailable_runtime");
      const current = this.routes.get(route);
      if (current && (generation < current.generation || (generation === current.generation && key !== current.key))) throw new MuseMspError("stale_native_route");
      if (current && generation > current.generation) {
        await this.retire(current.key);
        if (this.closed) throw new MuseMspError("unavailable_runtime");
      }
      const adapter = this.acquire(key, create, targetKey);
      this.routes.set(route, { generation, key });
      return adapter;
    } finally {
      release();
      if (this.routeLocks.get(route) === tail) this.routeLocks.delete(route);
    }
  }

  /** Retire a route generation and finish closing its children before reusing its key. */
  retire(key: string): Promise<void> {
    const entry = this.entries.get(key);
    return entry ? this.closeEntry(key, entry) : Promise.resolve();
  }

  private closeEntry(key: string, entry: Entry): Promise<void> {
    if (!entry.closing) entry.closing = Promise.resolve().then(() => entry.runner.close()).then(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return entry.closing;
  }

  /** Close only the runners created by this pool, once. */
  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.closing = Promise.allSettled([...this.entries].map(([key, entry]) => this.closeEntry(key, entry))).then(results => {
        this.entries.clear();
        this.routes.clear();
        if (results.some(result => result.status === "rejected")) throw new MuseMspError("runtime_close_failed");
      });
    }
    return this.closing;
  }
}
