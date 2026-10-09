import { X509Certificate } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, rmSync, writeFileSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import {
  decodePickerCaCredential, openPickerCaCredential, pickerCaConfigId, readPickerCaCredential,
  writePickerCaCredential, type PickerCaStore, type StoredPickerCa,
} from "./picker-ca-store";

const MAX_PUBLIC_STATE_BYTES = 64 * 1024;
interface AuthorityMetadata { schema: 1; configId: string; fingerprint: string }
interface Initialization extends AuthorityMetadata { predecessor: string | null }

export function canonicalPickerConfigDir(configDir: string): string {
  const canonical = realpathSync(configDir);
  const stat = lstatSync(canonical);
  if (!stat.isDirectory() || (process.platform !== "win32" && stat.uid !== process.getuid!())) {
    throw new Error("picker_ca_config_unsafe");
  }
  return canonical;
}

/** Public records still cannot follow symlinks or accept oversized/malformed recovery data. */
function readState(path: string, configId: string, initialization: boolean): Initialization | AuthorityMetadata | null {
  // BigInt stats: a Windows file ID exceeds 2^53, so Number ino loses low bits and two files can compare equal.
  let expected: BigIntStats;
  try { expected = lstatSync(path, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("picker_ca_metadata_unsafe"); }
  if (expected.isSymbolicLink()) throw new Error("picker_ca_metadata_unsafe");
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("picker_ca_metadata_unsafe"); }
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (stat.dev !== expected.dev || stat.ino !== expected.ino) throw new Error("picker_ca_metadata_unsafe");
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(MAX_PUBLIC_STATE_BYTES)
      || (process.platform !== "win32" && stat.uid !== BigInt(process.getuid!()))) throw new Error();
    const bytes = Buffer.alloc(MAX_PUBLIC_STATE_BYTES + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, null);
      if (count === 0) break;
      used += count;
    }
    if (used > MAX_PUBLIC_STATE_BYTES) throw new Error();
    const raw = bytes.subarray(0, used).toString("utf8");
    const value = JSON.parse(raw);
    const keys = initialization ? "configId,fingerprint,predecessor,schema" : "configId,fingerprint,schema";
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== keys || value.schema !== 1 || value.configId !== configId
      || typeof value.fingerprint !== "string" || !/^[A-F0-9]{64}$/.test(value.fingerprint)
      || (initialization && value.predecessor !== null && typeof value.predecessor !== "string")) throw new Error();
    if (initialization && value.predecessor !== null
      && new X509Certificate(value.predecessor).toString() !== value.predecessor) throw new Error();
    return value;
  } catch (error) {
    if (error instanceof Error && error.message === "picker_ca_metadata_unsafe") throw error;
    throw new Error("picker_ca_metadata_invalid");
  }
  finally { closeSync(fd); }
}

export interface PersistentPickerCaOptions {
  configDir: string;
  stateDir: string;
  store?: PickerCaStore;
  acceptsAuthority: (pem: string) => boolean;
  create: () => StoredPickerCa;
  /** Refuses a different live predecessor BEFORE the journal or credential can be written. */
  predecessor: (ca: StoredPickerCa) => string | null;
  publish: (ca: StoredPickerCa, predecessor: string | null) => void;
  publishMetadata: (path: string, value: string) => void;
}

/** Caller holds the canonical picker CA lease throughout the store/publication transaction. */
export function ensurePersistentPickerCa(options: PersistentPickerCaOptions): StoredPickerCa {
  const configId = pickerCaConfigId(options.configDir);
  const metadataPath = join(options.stateDir, "authority.json");
  const journalPath = join(options.stateDir, "authority-init.json");
  const metadata = readState(metadataPath, configId, false);
  let journal = readState(journalPath, configId, true) as Initialization | null;
  const entry = openPickerCaCredential(configId, options.store);
  const raw = readPickerCaCredential(entry);
  let ca: StoredPickerCa;
  if (raw === null) {
    if (metadata || journal) throw new Error("picker_ca_store_missing");
    ca = options.create();
    const predecessor = options.predecessor(ca);
    journal = { schema: 1, configId, fingerprint: ca.fingerprint, predecessor };
    // Exclusive evidence is durable before ANY credential mutation. Never erase it on failure.
    writeFileSync(journalPath, JSON.stringify(journal) + "\n", { flag: "wx", mode: 0o600 });
    writePickerCaCredential(entry, configId, ca);
  } else {
    ca = decodePickerCaCredential(raw, configId, options.acceptsAuthority);
    if ((!metadata && !journal) || (metadata && metadata.fingerprint !== ca.fingerprint)
      || (journal && journal.fingerprint !== ca.fingerprint)) throw new Error("picker_ca_metadata_mismatch");
    const predecessor = options.predecessor(ca);
    if (journal) {
      // A crash may have published the new certificate already, but no different predecessor
      // may be adopted under an existing journal. Public evidence must be exact and key-free.
      if (predecessor !== null && predecessor !== journal.predecessor) throw new Error("picker_ca_metadata_mismatch");
    } else if (predecessor !== null) throw new Error("picker_ca_metadata_mismatch");
  }
  options.publishMetadata(metadataPath, JSON.stringify({ schema: 1, configId, fingerprint: ca.fingerprint }) + "\n");
  options.publish(ca, journal?.predecessor ?? null);
  if (journal) rmSync(journalPath); // Last: store, metadata, certificate, owner, and cleanup evidence now exist.
  return ca;
}
