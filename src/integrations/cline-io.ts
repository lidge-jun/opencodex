import { dirname, join, resolve } from "node:path";
import { type IntegrationIO, type IntegrationTransaction, type ReadResult, type StatKind } from "./config-io";
import type { IntegrationStateStore } from "./store";
import { fingerprint, type OwnershipRecord } from "./ownership";
import type { JournalEntry } from "./journal";
import { parseClineTransaction } from "./cline-transaction";
import { decodeClinePair, encodeClinePair, type ClineRawPair } from "./cline-document";

/** Per-file atomic replacement with durable pair recovery, not simultaneous two-file visibility. */
export class ClineTransactionError extends Error {
  readonly residual = true;
  constructor(readonly snapshotPath: string) {
    super(`Cline has an unfinished two-file operation. Stop Cline and retry the mutation. If either file was edited, recover from ${snapshotPath} before retrying.`);
  }
}

function sameRecord(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function clinePendingPath(store: IntegrationStateStore, configPath: string): string {
  return join(store.root, `cline-pending-${fingerprint(resolve(configPath))}.json`);
}

/** Snapshot/ownership remain in the existing store. Only the filesystem projection changes. */
export function createClineIO(
  base: IntegrationIO,
  configPath: string,
  store: IntegrationStateStore,
  recover = false,
): IntegrationIO {
  const catalogPath = join(dirname(configPath), "models.json");
  const markerPath = clinePendingPath(store, configPath);
  const targets = { settings: configPath, catalog: catalogPath };
  const keys = ["settings", "catalog"] as const;
  const kind = (path: string) => (base.lstatKind ?? base.statKind)(path);
  const readPair = (): ClineRawPair => {
    const pair: ClineRawPair = { settings: null, catalog: null };
    for (const key of keys) {
      const path = targets[key];
      const state = kind(path);
      if (state === "missing") continue;
      if (state !== "file") throw new ClineTransactionError(markerPath);
      const read = base.readText(path);
      if (read.kind !== "text") throw new ClineTransactionError(markerPath);
      pair[key] = read.text;
    }
    return pair;
  };
  const writeMember = (key: typeof keys[number], text: string | null): void => {
    if (text === null) base.removeFile(targets[key]);
    else { base.mkdirp(dirname(targets[key])); base.writeText(targets[key], text); }
  };
  const writePair = (pair: ClineRawPair): void => {
    for (const key of keys) writeMember(key, pair[key]);
  };
  const readPending = (): IntegrationTransaction | null => {
    if (kind(markerPath) === "missing") return null;
    if (kind(markerPath) !== "file") throw new ClineTransactionError(markerPath);
    const read = base.readText(markerPath);
    if (read.kind !== "text") throw new ClineTransactionError(markerPath);
    try {
      return parseClineTransaction(read.text, configPath);
    } catch { throw new ClineTransactionError(markerPath); }
  };
  const committed = (pending: IntegrationTransaction, current: ClineRawPair): boolean => {
    let operation: JournalEntry | null;
    let record: OwnershipRecord | undefined;
    try { operation = store.findCommittedOperation(pending.entry.opId); record = store.readRecordsStrict().cline; }
    catch { throw new ClineTransactionError(markerPath); }
    return operation !== null && operation.clientId === "cline" && operation.configPath === configPath
      && operation.resultFingerprint === pending.entry.resultFingerprint
      && encodeClinePair(current) === pending.nextText
      && sameRecord(record, pending.record);
  };
  const cleanup = (): void => {
    // The append is the commit boundary. Cleanup failure never rolls back a committed pair.
    try { base.removeFile(markerPath); } catch { /* The next mutation recognizes the committed record. */ }
  };
  const pendingSafe = (): boolean => {
    const pending = readPending();
    return pending === null || committed(pending, readPair());
  };

  if (resolve(configPath).toLowerCase() === resolve(catalogPath).toLowerCase()) throw new ClineTransactionError(markerPath);
  if (recover) {
    const pending = readPending();
    if (pending) {
      const current = readPair();
      if (committed(pending, current)) cleanup();
      else {
        // A journaled but mixed/inconsistent result is not an interrupted uncommitted write.
        try {
          if (store.findCommittedOperation(pending.entry.opId)) throw new ClineTransactionError(markerPath);
        } catch { throw new ClineTransactionError(markerPath); }
        const before = decodeClinePair(pending.before);
        const after = decodeClinePair(pending.nextText);
        if (!keys.every(key => current[key] === before[key] || current[key] === after[key])) throw new ClineTransactionError(markerPath);
        let record: OwnershipRecord | null;
        try { record = store.readRecordsStrict().cline ?? null; }
        catch { throw new ClineTransactionError(markerPath); }
        if (!sameRecord(record, pending.priorRecord) && !sameRecord(record, pending.record)) throw new ClineTransactionError(markerPath);
        try {
          writePair(before);
          if (pending.priorRecord) base.putRecord(pending.priorRecord);
          else base.dropRecord("cline");
          base.removeFile(markerPath);
        } catch { throw new ClineTransactionError(markerPath); }
      }
    }
  }

  return {
    ...base,
    statKind: (path): StatKind => {
      if (path !== configPath) return base.statKind(path);
      try {
        if (!pendingSafe()) return "failed";
        const pair = readPair();
        return pair.settings === null && pair.catalog === null ? "missing" : "file";
      } catch { return "failed"; }
    },
    readText: (path): ReadResult => {
      if (path !== configPath) return base.readText(path);
      try {
        if (!pendingSafe()) return { kind: "failed", code: "CLINE_PENDING" };
        const text = encodeClinePair(readPair());
        return text === null ? { kind: "missing" } : { kind: "text", text };
      } catch { return { kind: "failed", code: "CLINE_UNSAFE" }; }
    },
    beginTransaction: transaction => {
      if (transaction.entry.clientId !== "cline" || transaction.entry.configPath !== configPath) throw new ClineTransactionError(markerPath);
      if (readPending() !== null) throw new ClineTransactionError(markerPath);
      if (encodeClinePair(readPair()) !== transaction.before) throw new ClineTransactionError(markerPath);
      base.mkdirp(store.root);
      const { entry, before, nextText, record, priorRecord } = transaction;
      base.writeText(markerPath, JSON.stringify({ entry, before, nextText, record, priorRecord }));
    },
    writeText: (path, text) => {
      if (path !== configPath) return base.writeText(path, text);
      writePair(decodeClinePair(text));
    },
    removeFile: path => {
      if (path !== configPath) return base.removeFile(path);
      writePair({ settings: null, catalog: null });
    },
    finishTransaction: cleanup,
  };
}
