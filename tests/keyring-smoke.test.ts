import { describe, expect, test } from "bun:test";
import { runKeyringSmoke, type KeyringSmokeEntry } from "../scripts/keyring-smoke";

class MemoryKeyringEntry implements KeyringSmokeEntry {
  secret: Buffer | null = null;
  deletes = 0;

  async setSecret(secret: Uint8Array): Promise<void> {
    this.secret = Buffer.from(secret);
  }

  async getSecret(): Promise<Uint8Array | null> {
    return this.secret ? Buffer.from(this.secret) : null;
  }

  async deleteCredential(): Promise<boolean> {
    this.deletes += 1;
    this.secret?.fill(0);
    this.secret = null;
    return true;
  }
}

describe("runKeyringSmoke", () => {
  test("creates, exactly reads, and deletes a unique entry", async () => {
    const entry = new MemoryKeyringEntry();
    const created: Array<[string, string]> = [];
    const ids = ["service-id", "account-id"];

    await runKeyringSmoke({
      createEntry: async (service, account) => {
        created.push([service, account]);
        return entry;
      },
      createRandomBytes: (size) => Buffer.alloc(size, 0x5a),
      createId: () => ids.shift()!,
    });

    expect(created).toEqual([["opencodex.keyring-smoke.service-id", "ci-account-id"]]);
    expect(entry.deletes).toBe(1);
    expect(entry.secret).toBeNull();
  });

  test("deletes the entry when readback verification fails", async () => {
    const entry = new MemoryKeyringEntry();
    entry.getSecret = async () => Buffer.alloc(32, 0x00);

    await expect(runKeyringSmoke({
      createEntry: async () => entry,
      createRandomBytes: (size) => Buffer.alloc(size, 0x5a),
      createId: () => "test-id",
    })).rejects.toThrow("readback did not match");

    expect(entry.deletes).toBe(1);
    expect(entry.secret).toBeNull();
  });

  test("zeros the buffer returned by the keyring", async () => {
    const entry = new MemoryKeyringEntry();
    const readback = Buffer.alloc(32, 0x5a);
    const generated = Buffer.alloc(32, 0x5a);
    entry.getSecret = async () => readback;

    await runKeyringSmoke({
      createEntry: async () => entry,
      createRandomBytes: () => generated,
      createId: () => "test-id",
    });

    expect(readback.equals(Buffer.alloc(32))).toBe(true);
    expect(generated.equals(Buffer.alloc(32))).toBe(true);
  });

  test("preserves a readback error when deletion returns false", async () => {
    const entry = new MemoryKeyringEntry();
    const generated = Buffer.alloc(32, 0x5a);
    entry.getSecret = async () => Buffer.alloc(32, 0x00);
    entry.deleteCredential = async () => {
      entry.deletes += 1;
      return false;
    };

    const error = await runKeyringSmoke({
      createEntry: async () => entry,
      createRandomBytes: () => generated,
      createId: () => "test-id",
    }).catch(cause => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("readback did not match");
    expect((error as Error & { cleanupError?: unknown }).cleanupError).toBeInstanceOf(Error);
    expect(Object.keys(error as Error)).toContain("cleanupError");
    expect((error as Error & { cleanupError: Error }).cleanupError.message)
      .toContain("could not delete the temporary entry");
    expect(entry.deletes).toBe(1);
    expect(generated.equals(Buffer.alloc(32))).toBe(true);
  });

  test("preserves a readback error when deletion throws", async () => {
    const entry = new MemoryKeyringEntry();
    const deletionError = new Error("injected keyring deletion failure");
    entry.getSecret = async () => Buffer.alloc(32, 0x00);
    entry.deleteCredential = async () => {
      entry.deletes += 1;
      throw deletionError;
    };

    const error = await runKeyringSmoke({
      createEntry: async () => entry,
      createRandomBytes: (size) => Buffer.alloc(size, 0x5a),
      createId: () => "test-id",
    }).catch(cause => cause);

    expect((error as Error).message).toContain("readback did not match");
    expect((error as Error & { cleanupError?: unknown }).cleanupError).toBe(deletionError);
    expect(entry.deletes).toBe(1);
  });

  test("fails when deletion is the only failed operation", async () => {
    const entry = new MemoryKeyringEntry();
    entry.deleteCredential = async () => {
      entry.deletes += 1;
      return false;
    };

    await expect(runKeyringSmoke({
      createEntry: async () => entry,
      createRandomBytes: (size) => Buffer.alloc(size, 0x5a),
      createId: () => "test-id",
    })).rejects.toThrow("could not delete the temporary entry");

    expect(entry.deletes).toBe(1);
  });
});
