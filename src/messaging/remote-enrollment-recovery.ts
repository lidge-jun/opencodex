import { join } from "node:path";
import { isSshAlias } from "../link/ssh-argv";
import { exactRecord, remoteError, REMOTE_PROTOCOL, validAlias, validCapability, validMachine, validPort, type MessageMachine } from "./remote-contract";
import { readRemoteFile, removeRemoteFile, withRemoteLock } from "./remote-files";
import type { RemoteMessageStore } from "./remote-store";
import { isThreadId } from "./types";

interface EnrollmentJournal {
  alias: string; ssh: string; fingerprint: string; generation: string;
  request: { protocol: typeof REMOTE_PROTOCOL; action: "enroll";
    params: { machine: MessageMachine; transaction: string; returnCapability: string; port: number } };
}

/** Interpret only safely read local journal text; storage/lock failures keep their own classification. */
export function parseEnrollmentJournal(text: string): EnrollmentJournal {
  try {
    const saved = exactRecord(JSON.parse(text), ["alias", "ssh", "fingerprint", "generation", "request"]);
    const request = exactRecord(saved.request, ["protocol", "action", "params"]);
    const params = exactRecord(request.params, ["machine", "transaction", "returnCapability", "port"]);
    if (!validAlias(saved.alias) || typeof saved.ssh !== "string" || !isSshAlias(saved.ssh)
      || typeof saved.fingerprint !== "string" || !/^SHA256:[A-Za-z0-9+/=]{1,64}$/.test(saved.fingerprint)
      || !isThreadId(saved.generation) || request.protocol !== REMOTE_PROTOCOL || request.action !== "enroll"
      || !validMachine(params.machine) || !isThreadId(params.transaction) || !validCapability(params.returnCapability)
      || !validPort(params.port)) throw new Error();
    // Preserve the parsed record's property order for exact saved-transaction ownership checks.
    return saved as unknown as EnrollmentJournal;
  } catch { throw remoteError("invalid_enrollment_journal", "Pending enrollment cannot be safely interpreted; explicit operator recovery is required."); }
}

/** Validate a recovery journal before exposing metadata or authorizing its exact removal. */
function readPending(store: RemoteMessageStore) {
  const text = readRemoteFile(join(store.directory, "enrollment.json"));
  if (text === null) return null;
  const saved = parseEnrollmentJournal(text);
  return { alias: saved.alias, generation: saved.generation,
    transaction: saved.request.params.transaction, machineId: saved.request.params.machine.id };
}

/** Read only bounded non-secret recovery metadata; absent storage remains absent. */
export function pendingRemoteEnrollment(store: RemoteMessageStore) {
  const pending = readPending(store);
  return pending ? { alias: pending.alias, transaction: pending.transaction,
    stale: pending.generation !== store.read()?.generation } : null;
}

/** Abandon one explicitly selected local transaction, never retrying it or claiming remote cleanup. */
export function abandonRemoteEnrollment(store: RemoteMessageStore, transaction: string) {
  if (!isThreadId(transaction)) throw remoteError("invalid_enrollment", "An exact pending transaction UUID is required.");
  // Recovery remains available while disabled, but never creates a missing store or lock.
  if (!readPending(store)) throw remoteError("enrollment_pending", "No pending enrollment exists to abandon.");
  return withRemoteLock(store.directory, () => {
    const pending = readPending(store);
    if (!pending || pending.transaction !== transaction) throw remoteError("enrollment_pending", "Pending enrollment changed; inspect it before abandoning the exact transaction.");
    removeRemoteFile(join(store.directory, "enrollment.json"));
    return { protocol: REMOTE_PROTOCOL, transaction, locallyAbandoned: true, remote: "unconfirmed",
      remoteCleanupCommand: `ocx message hosts remove ${pending.machineId} --transaction ${transaction} --json`,
      message: "Only the local recovery journal was removed. Existing peers are unchanged; the remote node may retain an enrollment requiring explicit cleanup." };
  });
}
