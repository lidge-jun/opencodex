/**
 * File integrations a linked Child owned before linking.
 *
 * A Child applying its Home's route intent disables, refreshes or creates file-integration blocks.
 * Without this record, disconnect cannot tell a block the link created from one the person had
 * set up on their own, and removed both. At the first link apply, before any client changes, the
 * Child records which file clients had an ownership record (with their model-name policy). The
 * record is private, bound to the link that captured it, and carries no paths or secrets.
 *
 * Disconnect restores those clients to their standalone state: a client the link left owned is
 * kept as is, a client the link disabled is applied again, and a client the person changed in the
 * meantime (a local opt-out, or a block of their own) is left alone. Clients the link created keep
 * the ordinary cleanup. Aside profiles are not recorded and keep that cleanup too.
 *
 * Callers hold the client lifecycle lock; reads are strict, so a damaged record refuses the
 * disconnect instead of silently dropping a standalone integration.
 */
import { chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, isMissingPathError } from "../config/atomic-write";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { hardenSecretDir } from "../lib/windows-secret-acl";
import { linkDir } from "../link/paths";
import { ROUTE_CLIENT_IDS, type RouteClientId } from "../link/route-intent";

type ModelNames = "alias" | "routed";
export interface FileIntentOriginals {
  version: 1;
  linkId: string;
  clients: Partial<Record<RouteClientId, { modelNames?: ModelNames }>>;
}

const RECORD_MAX_BYTES = 16 * 1024;
const NOT_FILE_CLIENTS: readonly RouteClientId[] = ["codex", "claude", "claude-desktop", "grok", "aside"];
const FILE_CLIENTS = ROUTE_CLIENT_IDS.filter(client => !NOT_FILE_CLIENTS.includes(client));
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export function fileIntentOriginalsPath(): string { return join(linkDir(), "file-intent-originals.json"); }

const unsafe = (): never => {
  throw new Error(`File integration originals record is unreadable; inspect or remove ${fileIntentOriginalsPath()} and retry`);
};

function parse(value: unknown): FileIntentOriginals {
  if (!isRecord(value) || value.version !== 1 || typeof value.linkId !== "string" || !/^lnk_[0-9a-f]{16}$/.test(value.linkId)
    || !isRecord(value.clients) || Object.keys(value).length !== 3) return unsafe();
  for (const [client, entry] of Object.entries(value.clients)) {
    if (!(FILE_CLIENTS as readonly string[]).includes(client) || !isRecord(entry)
      || Object.keys(entry).some(key => key !== "modelNames")
      || (entry.modelNames !== undefined && entry.modelNames !== "alias" && entry.modelNames !== "routed")) return unsafe();
  }
  return value as unknown as FileIntentOriginals;
}

/** Missing reads as null; a present but malformed record refuses. */
export function readFileIntentOriginals(): FileIntentOriginals | null {
  let stat;
  try { stat = lstatSync(fileIntentOriginalsPath()); } catch (error) { if (isMissingPathError(error)) return null; throw error; }
  if (!stat.isFile() || stat.size > RECORD_MAX_BYTES) return unsafe();
  let value: unknown;
  try { value = JSON.parse(readFileSync(fileIntentOriginalsPath(), "utf8")); } catch { return unsafe(); }
  return parse(value);
}

function writeRecord(record: FileIntentOriginals): void {
  parse(record);
  const dir = linkDir();
  assertNotRealHomeUnderTest(join(dir, ".."));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") hardenSecretDir(dir, { required: true });
  else chmodSync(dir, 0o700);
  atomicWriteFile(fileIntentOriginalsPath(), `${JSON.stringify(record, null, 2)}\n`);
  if (process.platform !== "win32") chmodSync(fileIntentOriginalsPath(), 0o600);
}

export function clearFileIntentOriginals(): void {
  assertNotRealHomeUnderTest(join(linkDir(), ".."));
  try { unlinkSync(fileIntentOriginalsPath()); } catch (error) { if (!isMissingPathError(error)) throw error; }
}

/**
 * Write-ahead capture for a link's first apply. `firstApply` is false once a route receipt bound
 * to a link exists, so clients a link created are never recorded as standalone. A record from
 * another link is stale and is replaced.
 */
export function captureFileIntentOriginals(linkId: string, firstApply: boolean,
  owners: Partial<Record<string, { modelNames?: ModelNames } | undefined>>): void {
  const existing = readFileIntentOriginals();
  if (existing?.linkId === linkId || !firstApply) return;
  const clients: FileIntentOriginals["clients"] = {};
  for (const client of FILE_CLIENTS) {
    const owner = owners[client];
    if (owner) clients[client] = owner.modelNames ? { modelNames: owner.modelNames } : {};
  }
  if (Object.keys(clients).length === 0) { if (existing) clearFileIntentOriginals(); return; }
  writeRecord({ version: 1, linkId, clients });
}
