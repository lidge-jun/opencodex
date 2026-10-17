import * as z from "zod/v4";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { OcxConfig } from "../types";
import { getConfigPath } from "./paths";

type PolicyConfig = { providers?: unknown; accountAutoPausePolicyRevisions?: unknown };
// fingerprint follows the live config; diskFingerprint follows the last observed disk state, so a
// detached load compares disk with disk and still fences an observed external policy change.
type Observed = { diskRevision: string; localGen: number; unknown: boolean; fingerprint: string; diskFingerprint: string };
export type AccountAutoPauseFence = { configPath: string; diskRevision: string; localGen: number; threshold: number; route: string };
const observed = new Map<string, Map<string, Observed>>();
// One process-wide allocator for every new entry and every advance: a deleted and recreated name
// can never reproduce an old {diskRevision, localGen} pair, even when both read "legacy".
let nextGeneration = 0;
const allocateGeneration = (): number => ++nextGeneration;
function hasProvider(config: PolicyConfig | undefined, name: string): boolean {
  const providers = record(config?.providers);
  return !!providers && Object.hasOwn(providers, name);
}
const UUID = z.uuid();
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function revisions(config: PolicyConfig): Record<string, string> | undefined | null {
  const value = config.accountAutoPausePolicyRevisions;
  if (value === undefined) return undefined;
  const map = record(value);
  return map && Object.values(map).every(v => typeof v === "string" && UUID.safeParse(v).success) ? map as Record<string, string> : null;
}
function revisionFor(map: Record<string, string> | undefined | null, name: string): string | undefined {
  return map && Object.hasOwn(map, name) ? map[name] : undefined;
}
function provider(config: PolicyConfig, name: string): Record<string, unknown> | undefined {
  const providers = record(config.providers);
  return providers && Object.hasOwn(providers, name) ? record(providers[name]) : undefined;
}
function route(row: Record<string, unknown> | undefined): string {
  return JSON.stringify([row?.baseUrl, row?.adapter, row?.authMode]);
}
export function accountAutoPauseFingerprint(row: unknown): string {
  const p = record(row), policy = record(p?.accountAutoPause);
  return JSON.stringify([!!p, policy?.enabled === true, policy?.consecutiveFailures ?? 2, p?.disabled === true, route(p)]);
}
export function snapshotAutoPauseFingerprints(config: PolicyConfig): Map<string, string> {
  return new Map(Object.entries(record(config.providers) ?? {}).map(([name, row]) => [name, accountAutoPauseFingerprint(row)]));
}
/** Caller revisions never authorize a write. The literal pre-write file owns the epoch. */
export function normalizeAccountAutoPauseRevisions(before: PolicyConfig | undefined, persisted: OcxConfig): void {
  const old = revisions(before ?? {});
  const names = new Set(Object.keys(old ?? {}));
  for (const config of [before, persisted]) {
    for (const [name, row] of Object.entries(record(config?.providers) ?? {})) {
      if (record(row)?.accountAutoPause !== undefined) names.add(name);
    }
  }
  // Records follow the providers that exist after disk-only preservation; a deleted provider's
  // record is reclaimed and a recreated one is minted a fresh UUID.
  const entries = [...names].filter(name => hasProvider(persisted, name)).map(name => [name, revisionFor(old, name)
    && accountAutoPauseFingerprint(provider(before ?? {}, name)) === accountAutoPauseFingerprint(provider(persisted, name))
    ? revisionFor(old, name)! : randomUUID()]);
  if (entries.length) persisted.accountAutoPausePolicyRevisions = Object.fromEntries(entries);
  else delete persisted.accountAutoPausePolicyRevisions;
}
/** Adopt disk epochs even when an external ABA left the effective policy unchanged. */
export function observeAccountAutoPauseRevisions(config: PolicyConfig, disk: PolicyConfig = config, previous?: Map<string, string>): void {
  const path = getConfigPath();
  let entries = observed.get(path);
  if (!entries) { entries = new Map(); observed.set(path, entries); }
  const map = revisions(disk);
  const names = new Set([...entries.keys(), ...Object.keys(record(config.providers) ?? {}), ...Object.keys(map ?? {})]);
  for (const name of names) {
    if (!hasProvider(config, name) && !hasProvider(disk, name)) { entries.delete(name); continue; }
    const fingerprint = accountAutoPauseFingerprint(provider(config, name));
    const old = entries.get(name);
    const prior = previous?.get(name) ?? old?.fingerprint ?? fingerprint;
    entries.set(name, { fingerprint, diskRevision: revisionFor(map, name) ?? "legacy", unknown: map === null,
      diskFingerprint: accountAutoPauseFingerprint(provider(disk, name)),
      localGen: !old || prior !== fingerprint ? allocateGeneration() : old.localGen });
  }
}
/**
 * A loaded snapshot adopts the disk epoch and compares its policy with the previously observed
 * disk policy. Many callers read detached snapshots; comparing one with the live fingerprint would
 * advance localGen on every live/snapshot difference. A disk-to-disk change still advances it.
 */
function adoptDiskAutoPauseRevisions(config: PolicyConfig): void {
  const path = getConfigPath();
  let entries = observed.get(path);
  if (!entries) { entries = new Map(); observed.set(path, entries); }
  const map = revisions(config);
  for (const name of new Set([...entries.keys(), ...Object.keys(record(config.providers) ?? {}), ...Object.keys(map ?? {})])) {
    if (!hasProvider(config, name)) { entries.delete(name); continue; }
    const old = entries.get(name);
    const diskRevision = revisionFor(map, name) ?? "legacy";
    const diskFingerprint = accountAutoPauseFingerprint(provider(config, name));
    entries.set(name, old
      ? { ...old, diskRevision, unknown: map === null, diskFingerprint, localGen: old.diskFingerprint !== diskFingerprint ? allocateGeneration() : old.localGen }
      : { fingerprint: diskFingerprint, diskFingerprint, diskRevision, unknown: map === null, localGen: allocateGeneration() });
  }
}
/** Test inspection only: observed records for the current config path. */
export function accountAutoPauseObservedSizeForTests(): number {
  return observed.get(getConfigPath())?.size ?? 0;
}
/** Initial load is an observation, never a persistence operation. */
export function observeLoadedAutoPauseConfig(config: OcxConfig): OcxConfig {
  adoptDiskAutoPauseRevisions(config);
  return config;
}
export function captureAccountAutoPauseFence(config: OcxConfig, name: string): AccountAutoPauseFence | undefined {
  // Only a config path no load or save has observed may be seeded from the caller's object. Once a
  // path is observed, a missing name means an authoritative observation removed it, and a stale
  // live snapshot must not re-enroll it; adoption by load, reload or save is required.
  if (!observed.has(getConfigPath())) observeAccountAutoPauseRevisions(config);
  const state = observed.get(getConfigPath())?.get(name);
  const p = provider(config, name), policy = record(p?.accountAutoPause);
  const threshold = policy?.consecutiveFailures ?? 2;
  if (!state || state.unknown || !p || p.disabled === true || policy?.enabled !== true || typeof threshold !== "number" || !Number.isInteger(threshold) || threshold < 1 || threshold > 100) return;
  return { configPath: getConfigPath(), diskRevision: state.diskRevision, localGen: state.localGen, threshold, route: route(p) };
}
export function accountAutoPauseFenceIsLocal(name: string, fence: AccountAutoPauseFence): boolean {
  const state = observed.get(fence.configPath)?.get(name);
  return getConfigPath() === fence.configPath && !!state && !state.unknown
    && state.diskRevision === fence.diskRevision && state.localGen === fence.localGen;
}
/** Must run inside the config mutation lock at the final persistence boundary. */
export function accountAutoPauseFenceMatchesDisk(name: string, fence: AccountAutoPauseFence, fresh?: PolicyConfig): boolean {
  if (!accountAutoPauseFenceIsLocal(name, fence)) return false;
  try {
    const disk = fresh ?? JSON.parse(readFileSync(fence.configPath, "utf8").replace(/^\uFEFF/, "")) as PolicyConfig;
    const map = revisions(disk), p = provider(disk, name), policy = record(p?.accountAutoPause);
    return map !== null && (revisionFor(map, name) ?? "legacy") === fence.diskRevision && !!p && p.disabled !== true
      && policy?.enabled === true && (policy.consecutiveFailures ?? 2) === fence.threshold && route(p) === fence.route;
  } catch { return false; }
}
