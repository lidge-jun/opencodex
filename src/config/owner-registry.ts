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
 * The anchor is CODEX_HOME because that is the shared state this protects: the
 * managed Codex client config lives there, and a sibling exists to leave that write
 * alone. Entries are written atomically and never read back as truth - they only
 * nominate a home for the caller's own record + liveness verification.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { atomicWriteFile } from "./atomic-write";
import { getConfigDir } from "./paths";
import { assertNotRealCodexHomeUnderTest } from "../lib/test-home-guard";

const REGISTRY_DIR_NAME = "ocx-homes";
const REGISTRY_ENTRY_SUFFIX = ".json";
const MAX_REGISTRY_ENTRIES = 64;
const MAX_ENTRY_BYTES = 4096;
const HOME_KEY_LENGTH = 24;

function registryBaseDir(): string {
  const raw = process.env.CODEX_HOME?.trim();
  // Without an env override the Codex client home defaults beside the user profile,
  // the same location the managed config writers use.
  return raw ? resolve(raw) : join(homedir(), ".codex");
}

/** The shared directory the registry lives under. */
export function ownerRegistryDir(): string {
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
    assertNotRealCodexHomeUnderTest(registryBaseDir());
    const dir = ownerRegistryDir();
    mkdirSync(dir, { recursive: true });
    atomicWriteFile(
      registryEntryPath(dir, home),
      JSON.stringify({ home: resolve(home), v: 1 }) + "\n",
    );
  } catch { /* discovery aid only */ }
}

/**
 * Every registered home path, including this process's own (the caller filters it
 * out). Entries are pointers, not facts: malformed, oversized, or unreadable entries
 * are skipped rather than trusted. Bounded so a cluttered directory cannot stall
 * startup discovery.
 */
export function readOwnerRegistryHomes(): string[] {
  const dir = ownerRegistryDir();
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter(name => name.endsWith(REGISTRY_ENTRY_SUFFIX))
      .slice(0, MAX_REGISTRY_ENTRIES);
  } catch {
    return [];
  }
  const homes: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_ENTRY_BYTES) continue;
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      const home = parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>).home
        : undefined;
      if (typeof home === "string" && home.length > 0) homes.push(home);
    } catch { /* a bad entry names nothing */ }
  }
  return homes;
}

/** Register this process's own home after its runtime record is published. */
export function registerOwnHome(): void {
  registerOwnerRegistryHome(getConfigDir());
}
