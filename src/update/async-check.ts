import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { unprivilegedOwnershipMutationEnvironment } from "../service/ownership-mutation-lease.mjs";
import { PKG, registrySpawnTarget, type Channel, type Installer } from "./index";
import type { PnpmGlobalOwner } from "./pnpm-global-install.mjs";

export const REGISTRY_DEADLINE_MS = 12_000;
export const REGISTRY_OUTPUT_LIMIT = 4_096;

export interface PnpmOwnerDeps {
  workerUrl?: URL;
  deadlineMs?: number;
  invoked?: string;
}

export async function pnpmOwner(deps: PnpmOwnerDeps = {}): Promise<PnpmGlobalOwner | null> {
  return new Promise(resolve => {
    let worker: Worker;
    try {
      worker = new Worker((deps.workerUrl ?? new URL("./pnpm-owner-worker.ts", import.meta.url)).href);
    } catch {
      resolve(null);
      return;
    }
    let done = false;
    const finish = (owner: PnpmGlobalOwner | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(owner);
    };
    const timer = setTimeout(() => finish(null), deps.deadlineMs ?? REGISTRY_DEADLINE_MS);
    worker.onmessage = event => finish(event.data as PnpmGlobalOwner | null);
    worker.onerror = () => finish(null);
    try { worker.postMessage(deps.invoked ?? process.argv[1] ?? ""); }
    catch { finish(null); }
  });
}

export interface AsyncLookupDeps {
  ownerFn: () => Promise<PnpmGlobalOwner | null>;
  spawnFn: typeof spawn;
  deadlineMs?: number;
}

const defaultDeps: AsyncLookupDeps = { ownerFn: pnpmOwner, spawnFn: spawn };

export async function latestVersionAsync(
  channel: Channel,
  installer: Installer,
  deps: AsyncLookupDeps = defaultDeps,
): Promise<string | null> {
  if (installer === "source" || installer === "mise") return null;
  let owner: PnpmGlobalOwner | null | undefined;
  try { owner = installer === "pnpm" ? await deps.ownerFn() : undefined; }
  catch { return null; }
  if (installer === "pnpm" && !owner) return null;
  const target = registrySpawnTarget(installer, ["view", `${PKG}@${channel}`, "version"], owner ?? undefined);
  if (!target) return null;

  return new Promise(resolve => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = deps.spawnFn(target.bin, target.args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: unprivilegedOwnershipMutationEnvironment(target.env ?? process.env),
        ...target.options,
      }) as ChildProcessWithoutNullStreams;
    } catch {
      resolve(null);
      return;
    }
    child.stdin.end();
    let done = false;
    let bytes = 0;
    let stdout = "";
    let failed = false;
    const finish = (version: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(version);
    };
    const accept = (chunk: Buffer, capture: boolean) => {
      bytes += chunk.length;
      if (bytes > REGISTRY_OUTPUT_LIMIT) {
        failed = true;
        child.kill();
      } else if (capture) {
        stdout += chunk.toString("utf8");
      }
    };
    child.stdout.on("data", (chunk: Buffer) => accept(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => accept(chunk, false));
    child.once("error", () => finish(null));
    child.once("close", code => {
      const value = stdout.trim();
      finish(!failed && code === 0 && (channel === "latest"
        ? /^\d+\.\d+\.\d+$/.test(value)
        : /^\d+\.\d+\.\d+(?:-preview\.\d+)?$/.test(value))
        ? value : null);
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, deps.deadlineMs ?? REGISTRY_DEADLINE_MS);
  });
}
