import { Database } from "bun:sqlite";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { CLOUD_HELPER_ROOT, CLOUD_HELPER_SOCKET, CloudNetworkError } from "./contract";
import { CloudHostsMapping } from "./hosts";
import { serveCloudMapping } from "./helper";

export function flushCloudResolver(): void {
  for (const [command, ...args] of [["/usr/bin/dscacheutil", "-flushcache"], ["/usr/bin/killall", "-HUP", "mDNSResponder"]]) {
    const result = spawnSync(command!, args, { stdio: "ignore", timeout: 5_000 });
    if (result.status !== 0) throw new CloudNetworkError("resolver_flush_failed");
  }
}

export function systemCloudMapping() {
  return new CloudHostsMapping({ hosts: "/private/etc/hosts", journal: join(CLOUD_HELPER_ROOT, "state/mapping.pending") }, flushCloudResolver);
}

export function readHelperOwner(root = CLOUD_HELPER_ROOT, fileOwner = 0): { uid: number; gid: number } {
  const path = join(root, "install.json");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== fileOwner || (stat.mode & 0o022) !== 0) throw new CloudNetworkError("helper_install_untrusted");
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value.protocol !== 1 || !Number.isInteger(value.uid) || value.uid <= 0 || !Number.isInteger(value.gid) || value.gid < 0) {
    throw new CloudNetworkError("helper_install_invalid");
  }
  return { uid: value.uid, gid: value.gid };
}

/** OS-held lock spans the service lifetime and excludes an installer or another helper. */
export async function withCloudHelperLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  const lock = new Database(join(root, "state/owner.sqlite"), { create: true });
  try { lock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE"); return await work(); }
  finally { lock.close(); }
}

export async function runSystemCloudHelper(): Promise<number> {
  if (process.platform !== "darwin" || process.getuid?.() !== 0) throw new CloudNetworkError("helper_requires_root_macos");
  process.umask(0o077);
  const owner = readHelperOwner();
  return withCloudHelperLock(CLOUD_HELPER_ROOT, async () => {
    let finish!: () => void;
    const shutdown = new Promise<void>(resolve => { finish = resolve; });
    process.once("SIGTERM", finish);
    process.once("SIGINT", finish);
    try {
      const service = await serveCloudMapping({ socketPath: CLOUD_HELPER_SOCKET, mapping: systemCloudMapping(), ...owner });
      await shutdown;
      await service.stop();
      return 0;
    } finally { process.off("SIGTERM", finish); process.off("SIGINT", finish); }
  });
}

// Source/npm installs bundle this same system entry; no user config or proxy credentials are loaded.
if (import.meta.main) {
  try { process.exitCode = await runSystemCloudHelper(); }
  catch { console.error("OpenCodex cloud network helper requires inspection/recovery."); process.exitCode = 1; }
}
