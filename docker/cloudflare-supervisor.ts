// Entrypoint for the Cloudflare Container deployment (deploy/cloudflare). The container disk is
// wiped whenever the instance sleeps or rolls out, so this process restores both state homes from
// R2 before starting ocx and uploads them again while it runs and on SIGTERM.
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import {
  closeSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readdirSync, readFileSync, readlinkSync, readSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

// Intercepted by OpencodexHub.outboundByHost in deploy/cloudflare/src/index.ts; never reaches DNS.
const STATE_ORIGIN = "http://state.ocx.internal";
const SQLITE_HEADER = "SQLite format 3\0";
// These hold a lock for the life of their owner. Restoring one would hand a new process a lock
// row naming a dead one, and copying one can block on the owner's open transaction.
const LOCK_DATABASE = /(lock|mutation|owner|claim|serialization|publication|lifecycle)[^/]*\.(sqlite|db)$/i;
const SQLITE_SIDECAR = /-(wal|shm|journal)$/;
// Regenerated at startup when absent. Leaving it out keeps a working management credential out of R2.
const REGENERATED_SECRETS = new Set(["admin-api-token"]);

export type StateRoot = { prefix: string; dir: string };
export type FileClass = "copy" | "sqlite" | "skip";

export function classifyFile(name: string, header: string): FileClass {
  if (SQLITE_SIDECAR.test(name) || REGENERATED_SECRETS.has(name)) return "skip";
  if (header === SQLITE_HEADER) return LOCK_DATABASE.test(name) ? "skip" : "sqlite";
  return "copy";
}

function readHeader(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(SQLITE_HEADER.length);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString("latin1");
  } finally {
    closeSync(fd);
  }
}

function copySqlite(source: string, target: string): void {
  const database = new Database(source, { readonly: true });
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.query("VACUUM INTO ?").run(target);
  } finally {
    database.close();
  }
}

/** Copies a consistent view of each root into staging/<prefix>; returns a digest of what it staged. */
export function stageSnapshot(roots: StateRoot[], staging: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const root of roots) {
    if (!existsSync(root.dir)) continue;
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir).sort()) {
        const source = join(dir, name);
        const rel = join(root.prefix, relative(root.dir, source));
        const target = join(staging, rel);
        const stat = lstatSync(source);
        if (stat.isDirectory()) {
          mkdirSync(target, { recursive: true, mode: stat.mode & 0o777 });
          walk(source);
        } else if (stat.isSymbolicLink()) {
          mkdirSync(dirname(target), { recursive: true });
          symlinkSync(readlinkSync(source), target);
          hasher.update(`link\0${rel}\0${readlinkSync(source)}\0`);
        } else if (stat.isFile()) {
          const kind = classifyFile(name, readHeader(source));
          if (kind === "skip") continue;
          mkdirSync(dirname(target), { recursive: true });
          if (kind === "sqlite") copySqlite(source, target);
          else copyFileSync(source, target);
          hasher.update(`file\0${rel}\0${stat.mode & 0o777}\0`);
          hasher.update(readFileSync(target));
        }
      }
    };
    mkdirSync(join(staging, root.prefix), { recursive: true });
    walk(root.dir);
  }
  return hasher.digest("hex");
}

/** Copies staging/<prefix> over each root; files absent from the snapshot are left alone. */
export function applySnapshot(roots: StateRoot[], staging: string): void {
  for (const root of roots) {
    const source = join(staging, root.prefix);
    if (!existsSync(source)) continue;
    mkdirSync(root.dir, { recursive: true, mode: 0o700 });
    cpSync(source, root.dir, { recursive: true, force: true, verbatimSymlinks: true });
  }
}

function run(cmd: string[]): void {
  const result = Bun.spawnSync(cmd, { stdout: "ignore", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${cmd[0]} exited ${result.exitCode}: ${result.stderr.toString().trim()}`);
}

class LeaseLostError extends Error {}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

class Supervisor {
  private readonly bootId = randomBytes(16).toString("hex");
  private lastDigest: string | undefined;
  private child: Bun.Subprocess | undefined;
  private placeholder: ReturnType<typeof Bun.serve> | undefined;
  private leaseHeld = false;
  private stopping = false;
  // The heartbeat must outlive `stopping`: a slow final upload can take longer than the lease.
  private releasing = false;
  // Every upload runs through this chain, so a periodic upload can never commit after the final one.
  private uploads: Promise<void> = Promise.resolve();

  constructor(
    private readonly roots: StateRoot[],
    private readonly intervalMs: number,
    private readonly port: number,
  ) {}

  private state(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("x-ocx-boot-id", this.bootId);
    return fetch(`${STATE_ORIGIN}${path}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
  }

  // The Worker marks the container ready once the port answers. A closed port during a stale lease
  // wait left requests hanging for minutes, and after ocx exits it would turn requests into 500s.
  private openPlaceholder(): void {
    this.placeholder ??= Bun.serve({
      port: this.port,
      hostname: "0.0.0.0",
      fetch: () => Response.json(
        { error: { message: "opencodex is restoring or saving its state; retry shortly.", type: "server_error" } },
        { status: 503, headers: { "retry-after": "10" } },
      ),
    });
  }

  private async closePlaceholder(): Promise<void> {
    await this.placeholder?.stop(true);
    this.placeholder = undefined;
  }

  private async renewLease(): Promise<void> {
    const response = await this.state("/lease", { method: "PUT" });
    if (response.status === 409) throw new LeaseLostError("another container holds the state lease");
    if (!response.ok) throw new Error(`lease request failed: ${response.status}`);
  }

  private async releaseLease(): Promise<void> {
    this.releasing = true;
    try {
      await this.state("/lease", { method: "DELETE" });
    } catch (error) {
      console.error(`Lease release failed; the next container waits for it to expire: ${errorText(error)}`);
    }
  }

  async acquireLease(): Promise<void> {
    while (true) {
      const response = await this.state("/lease", { method: "POST" });
      if (response.ok) {
        this.leaseHeld = true;
        return;
      }
      if (response.status !== 409) throw new Error(`lease request failed: ${response.status}`);
      const wait = Number(response.headers.get("retry-after")) || 5;
      console.log(`Waiting ${wait}s for the previous container to release the state lease.`);
      await Bun.sleep(Math.min(wait, 10) * 1000);
    }
  }

  async restore(): Promise<boolean> {
    const response = await this.state("/snapshot", {}, 10 * 60_000);
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`snapshot download failed: ${response.status}`);
    const work = mkdtempSync(join(tmpdir(), "ocx-restore-"));
    try {
      const archive = join(work, "snapshot.tar.gz");
      await Bun.write(archive, response);
      const staging = join(work, "tree");
      mkdirSync(staging);
      run(["tar", "-xzf", archive, "-C", staging, "--no-same-owner"]);
      applySnapshot(this.roots, staging);
      this.lastDigest = stageSnapshot(this.roots, join(work, "digest"));
      console.log(`Restored state snapshot (${Bun.file(archive).size} bytes).`);
      return true;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  private upload(): Promise<void> {
    const next = this.uploads.then(() => this.uploadNow());
    this.uploads = next.catch(() => {});
    return next;
  }

  private async uploadNow(): Promise<void> {
    const work = mkdtempSync(join(tmpdir(), "ocx-snapshot-"));
    try {
      const staging = join(work, "tree");
      mkdirSync(staging);
      const digest = stageSnapshot(this.roots, staging);
      if (digest === this.lastDigest) return;
      const archive = join(work, "snapshot.tar.gz");
      run(["tar", "-czf", archive, "-C", staging, "."]);
      const file = Bun.file(archive);
      const response = await this.state("/snapshot", {
        method: "PUT",
        body: file,
        headers: { "content-length": String(file.size) },
      }, 10 * 60_000);
      if (response.status === 409) throw new LeaseLostError("state lease lost before upload");
      if (!response.ok) throw new Error(`snapshot upload failed: ${response.status}`);
      this.lastDigest = digest;
      console.log(`Uploaded state snapshot (${file.size} bytes).`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  private fence(error: LeaseLostError): never {
    // Uploading now would publish state a newer container has already moved past.
    console.error(`${error.message}; stopping without uploading.`);
    this.stopping = true;
    this.child?.kill("SIGKILL");
    process.exit(1);
  }

  async shutdown(signal: NodeJS.Signals): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    // No lease means no state of ours exists yet. An acquire may still be in flight, so release anyway.
    if (!this.leaseHeld) {
      await this.releaseLease();
      process.exit(0);
    }
    const child = this.child;
    if (child && child.exitCode === null) {
      child.kill(signal);
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 60_000);
      await child.exited;
      clearTimeout(killTimer);
    }
    let saved = !child;
    if (child) {
      try {
        this.openPlaceholder();
      } catch (error) {
        console.error(`Placeholder listener unavailable during shutdown: ${errorText(error)}`);
      }
      // The platform allows 15 minutes between SIGTERM and SIGKILL; spend some of it on retries.
      for (let attempt = 1; attempt <= 6 && !saved; attempt++) {
        try {
          await this.upload();
          saved = true;
        } catch (error) {
          if (error instanceof LeaseLostError) this.fence(error);
          console.error(`Final snapshot attempt ${attempt} failed: ${errorText(error)}`);
          if (attempt < 6) await Bun.sleep(Math.min(2 ** attempt, 30) * 1000);
        }
      }
    }
    // Released even after a failed upload: our state is frozen now, so making the next container
    // wait out the lease would only add downtime to the loss.
    await this.releaseLease();
    process.exit(saved ? child?.exitCode ?? 0 : 1);
  }

  async main(command: string[]): Promise<void> {
    // bun runs as PID 1 here, and PID 1 drops signals it has no handler for.
    for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => void this.shutdown(signal));
    this.openPlaceholder();
    await this.acquireLease();
    try {
      if (!(await this.restore())) seedBootstrapConfig(this.roots[0]!.dir);
    } catch (error) {
      // Never fall through to a fresh home: its first upload would replace the saved state.
      await this.releaseLease();
      throw new Error(`state restore failed; not starting ocx: ${errorText(error)}`);
    }
    if (this.stopping) return;
    await this.closePlaceholder();
    this.child = Bun.spawn(command, { stdio: ["inherit", "inherit", "inherit"] });
    void this.child.exited.then(() => this.shutdown("SIGTERM"));

    // The heartbeat has its own timer so a slow upload cannot let the lease go stale.
    const heartbeat = setInterval(() => {
      if (this.releasing) return;
      this.renewLease().catch(error => {
        if (error instanceof LeaseLostError) this.fence(error);
        console.error(`Lease renewal failed: ${errorText(error)}`);
      });
    }, Math.min(this.intervalMs, 30_000));

    while (!this.stopping) {
      await Bun.sleep(this.intervalMs);
      if (this.stopping) break;
      try {
        await this.upload();
      } catch (error) {
        if (error instanceof LeaseLostError) this.fence(error);
        // A busy database or a transient network error: the next interval retries.
        console.error(`Periodic snapshot skipped: ${errorText(error)}`);
      }
    }
    clearInterval(heartbeat);
  }
}

/** First boot only: replace the image's default config with the operator's secret config. */
export function seedBootstrapConfig(home: string, env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.OCX_BOOTSTRAP_CONFIG_JSON?.trim();
  if (!raw) return false;
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OCX_BOOTSTRAP_CONFIG_JSON must be a JSON object");
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "config.json"), `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  return true;
}

if (import.meta.main) {
  const home = process.env.HOME || "/home/bun";
  const roots: StateRoot[] = [
    { prefix: "opencodex", dir: process.env.OPENCODEX_HOME || join(home, ".opencodex") },
    { prefix: "codex", dir: process.env.CODEX_HOME || join(home, ".codex") },
  ];
  const intervalSeconds = Math.min(60, Math.max(5, Number(process.env.OCX_SNAPSHOT_INTERVAL_SECONDS) || 30));
  const supervisor = new Supervisor(roots, intervalSeconds * 1000, 10100);
  supervisor.main(["bun", "run", "src/cli/index.ts", "start", "--port", "10100"]).catch(error => {
    console.error(`Supervisor failed: ${errorText(error)}`);
    process.exit(1);
  });
}
