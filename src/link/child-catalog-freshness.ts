import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { catalogEtag } from "../lib/catalog-etag";
import { patchChildObservation, updateChildObservations } from "./child-observations";
import { linkStorePath } from "./paths";
import { readLinkStore, type LinkStore } from "./store";

/** One completed `/v1/catalog` fetch by a Child: when, and the etag of the bytes served. Proves a fetch only. */
export interface CatalogPull { at: number; etag: string }

export interface CatalogPullRecorder {
  /** From the relay's onCatalogServed; keyId resolves through links.json when linkId is null. */
  record(served: { linkId: string | null; keyId: string | null; etag: string }): void;
  pulled(linkId: string): CatalogPull | null;
  /** Equals pulled(linkId)?.at ?? null. */
  pulledAt(linkId: string): number | null;
  /** Write every pull not yet persisted, ignoring the per-link interval. */
  flush(): void;
}

export const CATALOG_PULL_WRITE_INTERVAL_MS = 30_000;

const errorName = (error: unknown): string => error instanceof Error ? error.name : "unknown";

/**
 * A linkId absent from links.json, or a keyId no link holds, records nothing. Memory is updated synchronously; the file
 * write is deferred to a microtask (no timer) and happens at most once per link per 30 s. A later pull inside that
 * window stays in memory and is written by the next pull after the window or by flush(). A failed write (for example
 * ConfigMutationLockError under contention) keeps the memory value and is retried on the next write attempt.
 */
export function createCatalogPullRecorder(deps: {
  storePath?: string; readStore?: () => LinkStore; now?: () => number; debounceMs?: number;
  write?: (linkId: string, pull: CatalogPull) => void;
} = {}): CatalogPullRecorder {
  const now = deps.now ?? Date.now;
  const debounceMs = deps.debounceMs ?? CATALOG_PULL_WRITE_INTERVAL_MS;
  const readStore = deps.readStore ?? (() => readLinkStore(deps.storePath ?? linkStorePath()));
  const write = deps.write ?? ((linkId: string, pull: CatalogPull) => {
    updateChildObservations(file => patchChildObservation(file, linkId, { catalogPulledAt: pull.at, catalogPulledEtag: pull.etag }, new Date(pull.at)),
      deps.storePath ? { storePath: deps.storePath, path: join(dirname(deps.storePath), "child-observations.json") } : {});
  });
  const pulls = new Map<string, CatalogPull>();
  const lastWrite = new Map<string, number>();
  const dirty = new Set<string>();
  let scheduled = false;
  const writeOne = (linkId: string): void => {
    const pull = pulls.get(linkId);
    if (!pull) { dirty.delete(linkId); return; }
    try {
      write(linkId, pull);
      dirty.delete(linkId);
      lastWrite.set(linkId, now());
    } catch (error) {
      console.warn(`[link] catalog pull write failed linkId=${linkId} error=${errorName(error)}`);
    }
  };
  const writeDue = (): void => {
    scheduled = false;
    for (const linkId of [...dirty]) {
      const last = lastWrite.get(linkId);
      if (last === undefined || now() - last >= debounceMs) writeOne(linkId);
    }
  };
  return {
    record(served) {
      let store: LinkStore;
      try { store = readStore(); } catch { return; }
      const link = served.linkId !== null
        ? store.links.find(candidate => candidate.id === served.linkId)
        : served.keyId !== null ? store.links.find(candidate => candidate.apiKeyId === served.keyId) : undefined;
      if (!link) return;
      pulls.set(link.id, { at: now(), etag: served.etag });
      dirty.add(link.id);
      if (!scheduled) { scheduled = true; queueMicrotask(writeDue); }
    },
    pulled: linkId => pulls.get(linkId) ?? null,
    pulledAt: linkId => pulls.get(linkId)?.at ?? null,
    flush() { for (const linkId of [...dirty]) writeOne(linkId); },
  };
}

/** The Home catalog's identity. changedAt is display only: no verdict compares times. */
export interface CatalogRevision { etag: string; changedAt: number }
export interface CatalogRevisionMonitor { current(): CatalogRevision | null }

/**
 * Checked on each read, never on a timer: stat the catalog file, hash only when its size or mtime changed, persist
 * `homeCatalog` only when the etag moved. changedAt = min(now, mtimeMs). A persist failure (lock contention) keeps the
 * revision in memory and is retried on the next read, so a status read never fails on it. An unreadable file is null.
 */
export function createCatalogRevisionMonitor(deps: {
  catalogPath: () => string; read: (path: string) => string | null; load: () => CatalogRevision | null;
  persist: (revision: CatalogRevision) => void; now?: () => number;
  stat?: (path: string) => { size: number; mtimeMs: number };
}): CatalogRevisionMonitor {
  const now = deps.now ?? Date.now;
  const stat = deps.stat ?? ((path: string) => statSync(path));
  let cache: { path: string; size: number; mtimeMs: number; revision: CatalogRevision | null } | null = null;
  let known: CatalogRevision | null | undefined;
  let pending: CatalogRevision | null = null;
  const persistPending = (): void => {
    if (!pending) return;
    try {
      deps.persist(pending);
      pending = null;
    } catch (error) {
      console.warn(`[link] catalog revision save deferred error=${errorName(error)}`);
    }
  };
  return {
    current() {
      let path: string;
      let info: { size: number; mtimeMs: number };
      try {
        path = deps.catalogPath();
        info = stat(path);
      } catch { cache = null; return null; }
      if (cache && cache.path === path && cache.size === info.size && cache.mtimeMs === info.mtimeMs) {
        persistPending();
        return cache.revision;
      }
      let body: string | null;
      try { body = deps.read(path); } catch { body = null; }
      if (body === null) { cache = { path, size: info.size, mtimeMs: info.mtimeMs, revision: null }; return null; }
      const etag = catalogEtag(body);
      if (known === undefined) {
        try { known = deps.load(); } catch { known = null; }
      }
      let revision: CatalogRevision;
      if (known && known.etag === etag) revision = known;
      else {
        revision = { etag, changedAt: Math.min(now(), Math.floor(info.mtimeMs)) };
        known = revision;
        pending = revision;
      }
      cache = { path, size: info.size, mtimeMs: info.mtimeMs, revision };
      persistPending();
      return revision;
    },
  };
}

export type CatalogState = "current" | "behind" | "unknown";

/** Etag equality, never time order. syncedEtag is 030's catalogSyncedEtag (a Home-run sync that synced). */
export function catalogVerdict(pulledEtag: string | null, syncedEtag: string | null, revision: CatalogRevision | null): CatalogState {
  if (revision === null || (pulledEtag === null && syncedEtag === null)) return "unknown";
  return pulledEtag === revision.etag || syncedEtag === revision.etag ? "current" : "behind";
}
