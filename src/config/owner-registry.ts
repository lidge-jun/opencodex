/**
 * The cross-home owner registry.
 *
 * findCrossHomeOwner proves an owner through a home's protected runtime-port.json,
 * but it used to know exactly one home: the default ~/.opencodex. A custom-home
 * owner therefore stayed invisible to every other home (#6198): a second custom home
 * saw the shared clients' managed URL, could not prove the answering process, and
 * started as a competing owner that re-pointed shared Codex/Grok/Claude routing.
 *
 * This registry is the protected stable locator for those homes. Every runtime that
 * publishes runtime-port.json also drops one tiny pointer file here so another home
 * can find the record to attest against. The entries carry the home path only - the
 * attestation secret stays inside the home's own record - so a forged or stale entry
 * can never grant ownership; it can only send the reader to a record that still has
 * to prove itself.
 *
 * The anchor is the default OpenCodex home (~/.opencodex), an OpenCodex-owned
 * namespace every runtime for this user can reach regardless of which
 * OPENCODEX_HOME or CODEX_HOME it serves. Codex, Grok and Claude homes stay
 * untouched: discovery metadata must not write into the client state it exists
 * to protect, so OFF or foreign-owned client homes never see it. Entries are
 * written atomically and never read back as truth - they only nominate a home
 * for the caller's own record + liveness verification.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { atomicWriteFile } from "./atomic-write";
import { getConfigDir } from "./paths";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";

const REGISTRY_DIR_NAME = "ocx-homes";
/**
 * Test seam, not a user knob: os.homedir() resolves the passwd database on POSIX,
 * so rewriting HOME inside a test process cannot move the anchor and the armed
 * test-home guard would rightly refuse the write. Suites point this at their own
 * fixture home; production always leaves it unset so the default home stays the
 * one locator every sibling can find.
 */
const REGISTRY_DIR_ENV = "OCX_OWNER_REGISTRY_DIR";
const REGISTRY_ENTRY_SUFFIX = ".json";
const MAX_REGISTRY_ENTRIES = 64;
// Directory listing itself is bounded so a cluttered folder cannot stall startup;
// the 64-entry result cap applies AFTER validation so dead names cannot crowd out
// live owners.
const MAX_REGISTRY_LISTING = 4096;
const MAX_ENTRY_BYTES = 4096;
const HOME_KEY_LENGTH = 24;

function registryBaseDir(): string {
  // Always the default home, never the caller's OPENCODEX_HOME: the pointer must
  // sit where every sibling runtime can find it no matter which custom home is
  // serving.
  return join(homedir(), ".opencodex");
}

/** The shared directory the registry lives under. */
export function ownerRegistryDir(): string {
  const override = process.env[REGISTRY_DIR_ENV]?.trim();
  if (override) return resolve(override);
  return join(registryBaseDir(), REGISTRY_DIR_NAME);
}

function registryEntryPath(dir: string, home: string): string {
  const key = createHash("sha256").update(resolve(home)).digest("hex").slice(0, HOME_KEY_LENGTH);
  return join(dir, key + REGISTRY_ENTRY_SUFFIX);
}

/**
 * Record 'home' in the shared registry. Best-effort and never throws: a failed write
 * only degrades cross-home discovery, it must not break the publish that owns state.
 */
export function registerOwnerRegistryHome(home: string): void {
  try {
    const dir = ownerRegistryDir();
    // Guard every ancestor of the write target: an override that still resolves
    // under the protected ~/.opencodex must not slip past the test home guard.
    for (let ancestor = dir; ;) {
      assertNotRealHomeUnderTest(ancestor);
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    mkdirSync(dir, { recursive: true });
    atomicWriteFile(
      registryEntryPath(dir, home),
      JSON.stringify({ home: resolve(home), v: 1 }) + "\n",
    );
  } catch { /* discovery aid only */ }
}

export interface OwnerRegistryRead {
  homes: string[];
  /**
   * The listing or the validated result hit a bound before every pointer could be
   * checked. Callers must treat truncation as "discovery may have missed a live
   * owner" and fail closed rather than concluding no owner exists.
   */
  truncated: boolean;
}

/**
 * Every registered home path, including this process's own (the caller filters it
 * out). Entries are pointers, not facts: malformed, oversized, or unreadable entries
 * are skipped rather than trusted, and a pointer whose home no longer publishes a
 * runtime record nominates nothing - it is pruned before the entry cap so a pile
 * of dead homes cannot crowd out a live owner. Bounded so a cluttered directory
 * cannot stall startup discovery; when a bound actually cuts off unchecked
 * pointers, {@link OwnerRegistryRead.truncated} says the answer is incomplete.
 */
export function readOwnerRegistry(): OwnerRegistryRead {
  const dir = ownerRegistryDir();
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter(name => name.endsWith(REGISTRY_ENTRY_SUFFIX));
  } catch {
    return { homes: [], truncated: false };
  }
  let truncated = names.length > MAX_REGISTRY_LISTING;
  const homes: string[] = [];
  for (const name of names.slice(0, MAX_REGISTRY_LISTING)) {
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_ENTRY_BYTES) continue;
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      const home = parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>).home
        : undefined;
      if (typeof home !== "string" || home.length === 0) continue;
      // The record is written before the pointer, so a registered home without
      // runtime-port.json is a dead entry: skip it before it can spend the cap.
      if (!existsSync(join(home, "runtime-port.json"))) continue;
      if (homes.length >= MAX_REGISTRY_ENTRIES) { truncated = true; break; }
      homes.push(home);
    } catch { /* a bad entry names nothing */ }
  }
  return { homes, truncated };
}

/** Retire 'home' from the shared registry. Best-effort like registration. */
export function unregisterOwnerRegistryHome(home: string): void {
  try {
    unlinkSync(registryEntryPath(ownerRegistryDir(), home));
  } catch { /* a missing pointer needs no removal */ }
}

/** Register this process's own home after its runtime record is published. */
export function registerOwnHome(): void {
  registerOwnerRegistryHome(getConfigDir());
}
