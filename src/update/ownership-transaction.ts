import { readFileSync } from "node:fs";
import {
  acquireOwnershipMutationLease,
  ownershipMutationLeaseChildEnvironment,
  unprivilegedOwnershipMutationEnvironment,
} from "../service/ownership-mutation-lease.mjs";

type Environment = Record<string, string | undefined>;
export interface UpdateOwnershipTransaction {
  controlEnvironment(environment?: Environment): Environment;
  unprivilegedEnvironment(environment?: Environment): Environment;
  /**
   * Free the lease before a service-manager-mediated start that cannot join it —
   * the manager's `ocx start` child runs with the stored registration environment,
   * not a delegated token, so held through the repair's serving wait the lease
   * keeps that proxy from starting (#5760). Idempotent; controlEnvironment keeps
   * injecting the token afterwards, which a released lease self-corrects (the
   * delegated join fails and the child acquires normally).
   */
  release(): void;
  /**
   * Take the lease back before re-reading ownership and mutating directly: the
   * released refresh window could have admitted a claim that must be vetoed, not
   * killed unleased. No-op while held; a still-claimed lease throws (bounded),
   * which callers must treat as fail-closed.
   */
  reacquire(): void;
}

/** One lease spans awaited stop, replacement and recovery. Never publish its token globally. */
export async function withUpdateOwnershipLease<T>(
  paths: string[], run: (transaction: UpdateOwnershipTransaction) => Promise<T>,
): Promise<T> {
  let lease = acquireOwnershipMutationLease(paths);
  let released = false;
  const release = () => { if (!released) { released = true; lease.release(); } };
  try {
    return await run({
      controlEnvironment: (env = process.env) => ownershipMutationLeaseChildEnvironment(env, lease.token),
      unprivilegedEnvironment: (env = process.env) => unprivilegedOwnershipMutationEnvironment(env),
      release: () => release(),
      reacquire: () => { if (released) { lease = acquireOwnershipMutationLease(paths); released = false; } },
    });
  } finally { release(); }
}

export type UpdateRuntimeTarget =
  | { kind: "absent" | "unknown" }
  | { kind: "target"; target: { pid: number; port: number; hostname: string } };

/** A malformed/unreadable record is uncertainty, never proof that the current runtime is absent. */
export function readUpdateRuntimeTarget(path: string, fallbackHostname: string): UpdateRuntimeTarget {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (error) { return { kind: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown" }; }
  try {
    const value = JSON.parse(raw);
    if (!Number.isSafeInteger(value?.pid) || value.pid <= 0
      || !Number.isInteger(value?.port) || value.port <= 0 || value.port > 65535
      || (value.hostname !== undefined && (typeof value.hostname !== "string" || !value.hostname.trim()))) {
      return { kind: "unknown" };
    }
    return { kind: "target", target: { pid: value.pid, port: value.port, hostname: value.hostname?.trim() ?? fallbackHostname } };
  } catch { return { kind: "unknown" }; }
}
