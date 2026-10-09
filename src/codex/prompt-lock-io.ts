import { retryWindowsFileOperation, transientWindowsReplaceCode } from "../lib/windows-atomic-replace";

/** A held Windows handle is contention, never owner-death evidence. */
export class LockFileBusy extends Error {}

export function lockFileOperation<T>(operation: () => T, platform: NodeJS.Platform): T {
  let contended = false;
  try {
    return retryWindowsFileOperation(operation, { platform, sleep: Bun.sleepSync }, () => { contended = true; });
  }
  catch (error) {
    if (transientWindowsReplaceCode(platform, error)
      || (contended && (error as NodeJS.ErrnoException).code === "EEXIST")) throw new LockFileBusy("Lock filesystem operation is busy");
    throw error;
  }
}
