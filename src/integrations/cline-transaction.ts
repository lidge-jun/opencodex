import type { IntegrationTransaction } from "./config-io";
import { decodeClinePair, encodeClinePair, isClineObject } from "./cline-document";
import { isJournalEntry } from "./journal";
import { fingerprint, isOwnershipRecord, type OwnershipRecord } from "./ownership";
import { validRefreshablePaths } from "./ownership-policy";

const FRAGMENTS = [["catalog", "providers", "opencodex"], ["settings", "providers", "opencodex"]];
const CONTAINERS = new Set(["catalog", "settings", "catalog\0providers", "settings\0providers"]);

function clineRecord(value: unknown, configPath: string): value is OwnershipRecord | null {
  if (value === null) return true;
  if (!isOwnershipRecord(value) || value.clientId !== "cline" || value.configPath !== configPath) return false;
  if (value.fragmentPaths.length !== FRAGMENTS.length
    || !FRAGMENTS.every(expected => value.fragmentPaths.some(path =>
      path.length === expected.length && path.every((segment, index) => segment === expected[index])))) return false;
  if (value.createdContainers?.some(path => !CONTAINERS.has(path))) return false;
  if (value.refreshablePaths !== undefined
    && !validRefreshablePaths({ clientId: "cline", fragments: [] }, value.refreshablePaths)) return false;
  return value.protectedBlockFingerprint === undefined || value.refreshablePaths !== undefined;
}

/** Validate all recovery authority before a file or ownership record can be replaced. */
export function parseClineTransaction(text: string, configPath: string): IntegrationTransaction {
  const value: unknown = JSON.parse(text);
  if (!isClineObject(value) || !isJournalEntry(value.entry)
    || value.entry.clientId !== "cline" || value.entry.configPath !== configPath
    || !(typeof value.before === "string" || value.before === null)
    || !(typeof value.nextText === "string" || value.nextText === null)
    || !clineRecord(value.record, configPath) || !clineRecord(value.priorRecord, configPath)
    || !clineRecord(value.entry.priorRecord, configPath)
    || JSON.stringify(value.entry.priorRecord) !== JSON.stringify(value.priorRecord)
    || (value.record !== null && (value.record.opId !== value.entry.opId || value.record.appliedAt !== value.entry.at))) {
    throw new Error("invalid Cline transaction metadata");
  }
  if (encodeClinePair(decodeClinePair(value.before)) !== value.before
    || encodeClinePair(decodeClinePair(value.nextText)) !== value.nextText
    || value.entry.resultAbsent !== (value.nextText === null)
    || value.entry.resultFingerprint !== (value.nextText === null ? "" : fingerprint(value.nextText))) {
    throw new Error("inconsistent Cline transaction result");
  }
  return { entry: value.entry, before: value.before, nextText: value.nextText, record: value.record, priorRecord: value.priorRecord };
}
