#!/usr/bin/env bun
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export interface KeyringSmokeEntry {
  setSecret(secret: Uint8Array, signal?: AbortSignal): Promise<void>;
  getSecret(signal?: AbortSignal): Promise<Uint8Array | null>;
  deleteCredential(signal?: AbortSignal): Promise<boolean>;
}

export interface KeyringSmokeOptions {
  createEntry?: (service: string, account: string) => Promise<KeyringSmokeEntry>;
  createRandomBytes?: (size: number) => Buffer;
  createId?: () => string;
  timeoutMs?: number;
}

async function createOsEntry(service: string, account: string): Promise<KeyringSmokeEntry> {
  const { AsyncEntry } = await import("@napi-rs/keyring");
  return new AsyncEntry(service, account);
}

export async function runKeyringSmoke({
  createEntry = createOsEntry,
  createRandomBytes = randomBytes,
  createId = randomUUID,
  timeoutMs = 8_000,
}: KeyringSmokeOptions = {}): Promise<void> {
  const service = `opencodex.keyring-smoke.${createId()}`;
  const account = `ci-${createId()}`;
  const secret = createRandomBytes(32);
  let entry: KeyringSmokeEntry | null = null;
  let readback: Uint8Array | null = null;
  let stored: Buffer | null = null;
  let operationFailed = false;
  let operationError: unknown;

  try {
    entry = await createEntry(service, account);
    await entry.setSecret(secret, AbortSignal.timeout(timeoutMs));
    readback = await entry.getSecret(AbortSignal.timeout(timeoutMs));
    stored = readback ? Buffer.from(readback) : null;
    if (!stored || stored.byteLength !== secret.byteLength || !timingSafeEqual(stored, secret)) {
      throw new Error("OS keyring smoke readback did not match the stored value.");
    }
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  let cleanupFailed = false;
  let cleanupError: unknown;
  if (entry) {
    try {
      if (!await entry.deleteCredential(AbortSignal.timeout(timeoutMs))) {
        throw new Error("OS keyring smoke could not delete the temporary entry.");
      }
    } catch (error) {
      cleanupFailed = true;
      cleanupError = error;
    }
  }

  readback?.fill(0);
  stored?.fill(0);
  secret.fill(0);

  if (operationFailed) {
    if (cleanupFailed && operationError instanceof Error) {
      Object.defineProperty(operationError, "cleanupError", {
        configurable: true,
        enumerable: true,
        value: cleanupError,
      });
    }
    throw operationError;
  }
  if (cleanupFailed) throw cleanupError;
}

if (import.meta.main) {
  await runKeyringSmoke();
  console.log("OS keyring create/read/delete smoke passed.");
}
