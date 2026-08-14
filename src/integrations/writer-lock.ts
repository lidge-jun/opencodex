import { rm, writeFile } from "node:fs/promises";

const LOCK_DEADLINE_MS = 2_000;
const LOCK_DELAYS_MS = [20, 40, 80, 160, 200] as const;

export interface IntegrationWriterLockSeams {
  writeFile: (
    path: string,
    payload: string,
    options: { flag: "wx"; mode: 0o600 },
  ) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
  now: () => number;
  delay: (milliseconds: number) => Promise<void>;
  pid: number;
}

export class IntegrationWriterLockBusyError extends Error {
  constructor(readonly lockPath: string) {
    super("integration_mutation_busy");
    this.name = "IntegrationWriterLockBusyError";
  }
}

export class IntegrationWriterLockIOError extends Error {
  constructor(readonly lockPath: string, readonly operation: "acquire" | "release", cause: unknown) {
    // The management route returns Error.message to its caller. Keep the
    // private config path and OS diagnostic on typed fields/cause, not the wire.
    super(`integration writer lock ${operation} failed`, { cause });
    this.name = "IntegrationWriterLockIOError";
  }
}

const defaultSeams: IntegrationWriterLockSeams = {
  writeFile: async (path, payload, options) => { await writeFile(path, payload, options); },
  // Match DSH rc.6: an already-absent lock is a successful release.
  removeFile: async path => { await rm(path, { force: true }); },
  now: () => Date.now(),
  delay: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  pid: process.pid,
};

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/**
 * Hold the exact sibling `<settings>.lock` around one complete transaction.
 * A contender is never deleted: release runs only after our exclusive create
 * succeeded.
 */
export async function withIntegrationWriterLock<T>(
  configPath: string,
  operation: () => Promise<T>,
  seams: IntegrationWriterLockSeams = defaultSeams,
  suffix: ".lock" = ".lock",
): Promise<T> {
  const lockPath = `${configPath}${suffix}`;
  const startedAt = seams.now();
  let delayIndex = 0;
  for (;;) {
    try {
      await seams.writeFile(lockPath, `${seams.pid}\n`, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw new IntegrationWriterLockIOError(lockPath, "acquire", error);
      }
      const elapsedMs = seams.now() - startedAt;
      if (elapsedMs >= LOCK_DEADLINE_MS) {
        throw new IntegrationWriterLockBusyError(lockPath);
      }
      const backoffMs = LOCK_DELAYS_MS[Math.min(delayIndex, LOCK_DELAYS_MS.length - 1)]!;
      // Keep the final retry inside the advertised two-second deadline.
      const delayMs = Math.min(backoffMs, LOCK_DEADLINE_MS - elapsedMs);
      delayIndex += 1;
      await seams.delay(delayMs);
    }
  }

  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await operation() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  try {
    await seams.removeFile(lockPath);
  } catch (error) {
    // Cleanup cannot replace the protected operation's actual failure.
    if (!outcome.ok) throw outcome.error;
    throw new IntegrationWriterLockIOError(lockPath, "release", error);
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
