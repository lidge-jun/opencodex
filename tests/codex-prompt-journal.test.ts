/**
 * Transaction contract for src/codex/prompt-journal.ts.
 *
 * The property under test is not "recovery restores state" — it is "recovery
 * never writes a file it does not recognise". An earlier design rewrote both
 * targets from the post-image whenever either differed, which destroys a
 * legitimate edit made after a crash.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classify,
  decodeJournal,
  durableWrite,
  encodeJournal,
  hashBytes,
  recoverIfNeeded,
  sameRecoveryPath,
  type JournalRecord,
} from "../src/codex/prompt-journal";
import {
  hardenedSecretPathCountForTests,
  resetHardenedStateForTests,
  setIcaclsRunnerForTests,
  setPlatformForTests,
} from "../src/lib/windows-secret-acl";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const roots: string[] = [];

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-journal-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length) removeTreeWithRetry(roots.pop()!);
});

/** A transaction that changes config from PRE_C to POST_C and store PRE_S to POST_S. */
function scenario(opts: { config: string | null; store: string | null }) {
  const dir = root();
  const configPath = join(dir, "config.toml");
  const storePath = join(dir, "opencodex-prompt.json");
  const journalPath = join(dir, "opencodex-prompt.journal");

  const preConfigBytes = "PRE_C";
  const postConfigBytes = "POST_C";
  const preStoreBytes = "PRE_S";
  const postStoreBytes = "POST_S";

  const record: JournalRecord = {
    configPath,
    storePath,
    preConfig: hashBytes(preConfigBytes),
    postConfig: hashBytes(postConfigBytes),
    preStore: hashBytes(preStoreBytes),
    postStore: hashBytes(postStoreBytes),
    preConfigBytes,
    postConfigBytes,
    preStoreBytes,
    postStoreBytes,
  };

  if (opts.config !== null) writeFileSync(configPath, opts.config, "utf8");
  if (opts.store !== null) writeFileSync(storePath, opts.store, "utf8");
  writeFileSync(journalPath, encodeJournal(record), "utf8");

  return { configPath, storePath, journalPath, record };
}

function read(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function recover(s: ReturnType<typeof scenario>) {
  return recoverIfNeeded(s.journalPath, {
    configPath: s.configPath,
    storePath: s.storePath,
  });
}

describe("envelope", () => {
  test("round-trips a record", () => {
    const record = { configPath: "/c", storePath: "/s" } as JournalRecord;
    expect(decodeJournal(encodeJournal(record))?.configPath).toBe("/c");
  });

  test("rejects a tampered body", () => {
    const encoded = encodeJournal({ configPath: "/c", storePath: "/s" } as JournalRecord);
    expect(decodeJournal(encoded.replace("/c", "/x"))).toBeNull();
  });

  test("rejects truncation, a missing tag, and garbage", () => {
    const encoded = encodeJournal({ configPath: "/c", storePath: "/s" } as JournalRecord);
    expect(decodeJournal(encoded.slice(0, encoded.length - 12))).toBeNull();
    expect(decodeJournal("nope deadbeef\n{}")).toBeNull();
    expect(decodeJournal("no-newline")).toBeNull();
    expect(decodeJournal(null)).toBeNull();
  });
});

describe("classification", () => {
  test("distinguishes pre, post, and unknown", () => {
    const pre = hashBytes("a");
    const post = hashBytes("b");
    expect(classify("a", pre, post)).toBe("pre");
    expect(classify("b", pre, post)).toBe("post");
    expect(classify("c", pre, post)).toBe("unknown");
  });

  test("absent is its own value, not an empty file", () => {
    const pre = hashBytes(null);
    const post = hashBytes("b");
    expect(classify(null, pre, post)).toBe("pre");
    expect(classify("", pre, post)).toBe("unknown");
  });
});

describe("path binding", () => {
  test("normalizes lexical segments without following the recorded path", () => {
    expect(sameRecoveryPath("/tmp/ocx/a/../config.toml", "/tmp/ocx/config.toml", "linux")).toBe(true);
  });

  test("uses case-insensitive identity only on Windows", () => {
    const mixed = "C:\\Users\\Alice\\.codex\\config.toml";
    expect(sameRecoveryPath(mixed, mixed.toLowerCase(), "win32")).toBe(true);
    expect(sameRecoveryPath(mixed, mixed.toLowerCase(), "linux")).toBe(false);
  });
});

describe("recovery", () => {
  test("no journal is a no-op", () => {
    const dir = root();
    expect(recoverIfNeeded(join(dir, "absent.journal"), {
      configPath: join(dir, "config.toml"),
      storePath: join(dir, "opencodex-prompt.json"),
    })).toEqual({ ok: true, action: "none" });
  });

  test("both targets at post-image: commit by deleting the journal", () => {
    // The writes finished; only step 6 was missing. This is the ONE case that
    // does not roll back, and it is not a roll-forward.
    const s = scenario({ config: "POST_C", store: "POST_S" });
    expect(recover(s)).toEqual({ ok: true, action: "committed" });
    expect(read(s.configPath)).toBe("POST_C");
    expect(read(s.storePath)).toBe("POST_S");
    expect(existsSync(s.journalPath)).toBe(false);
  });

  test("partially applied: roll back to the pre-image", () => {
    // Crash after config.toml but before the store. A journal on disk means
    // commit never happened, so the transaction is undone.
    const s = scenario({ config: "POST_C", store: "PRE_S" });
    expect(recover(s)).toEqual({ ok: true, action: "rolled-back" });
    expect(read(s.configPath)).toBe("PRE_C");
    expect(read(s.storePath)).toBe("PRE_S");
    expect(existsSync(s.journalPath)).toBe(false);
  });

  test("nothing applied: leave both alone", () => {
    const s = scenario({ config: "PRE_C", store: "PRE_S" });
    expect(recover(s).ok).toBe(true);
    expect(read(s.configPath)).toBe("PRE_C");
    expect(read(s.storePath)).toBe("PRE_S");
  });

  test("a config edited by someone else stops recovery cold", () => {
    // THE case this module exists for: crash, then Codex or the user edits
    // config.toml. Recovery must not overwrite it with a stale image.
    const s = scenario({ config: "SOMEONE ELSE WROTE THIS", store: "PRE_S" });
    const result = recover(s);
    expect(result.ok).toBe(false);
    expect(read(s.configPath)).toBe("SOMEONE ELSE WROTE THIS");
    expect(existsSync(s.journalPath)).toBe(true);
  });

  test("an unrecognised store aborts before the config is touched", () => {
    // One unknown target aborts the WHOLE recovery: we never repair one file
    // while the other carries a stranger's edit.
    const s = scenario({ config: "POST_C", store: "SOMEONE ELSE" });
    expect(recover(s).ok).toBe(false);
    expect(read(s.configPath)).toBe("POST_C");
    expect(read(s.storePath)).toBe("SOMEONE ELSE");
  });

  test("a corrupt journal is recovery_required, and nothing is written", () => {
    const s = scenario({ config: "POST_C", store: "PRE_S" });
    writeFileSync(s.journalPath, "ocx-journal-v1 deadbeef\n{\"configPath\":\"/x\"}", "utf8");
    const result = recover(s);
    expect(result.ok).toBe(false);
    expect(read(s.configPath)).toBe("POST_C");
    expect(read(s.storePath)).toBe("PRE_S");
    expect(existsSync(s.journalPath)).toBe(true);
  });

  test("a truncated journal is recovery_required", () => {
    const s = scenario({ config: "POST_C", store: "PRE_S" });
    const encoded = readFileSync(s.journalPath, "utf8");
    writeFileSync(s.journalPath, encoded.slice(0, encoded.length - 20), "utf8");
    expect(recover(s).ok).toBe(false);
    expect(read(s.configPath)).toBe("POST_C");
  });

  test("rollback deletes a file the pre-image says should not exist", () => {
    const dir = root();
    const configPath = join(dir, "config.toml");
    const storePath = join(dir, "store.json");
    const journalPath = join(dir, "p.journal");
    writeFileSync(configPath, "POST_C", "utf8");
    writeFileSync(storePath, "PRE_S", "utf8");
    writeFileSync(journalPath, encodeJournal({
      configPath, storePath,
      preConfig: hashBytes(null), postConfig: hashBytes("POST_C"),
      preStore: hashBytes("PRE_S"), postStore: hashBytes("POST_S"),
      preConfigBytes: null, postConfigBytes: "POST_C",
      preStoreBytes: "PRE_S", postStoreBytes: "POST_S",
    }), "utf8");
    expect(recoverIfNeeded(journalPath, { configPath, storePath }).ok).toBe(true);
    expect(existsSync(configPath)).toBe(false);
  });

  for (const mismatchedTarget of ["configPath", "storePath"] as const) {
    test(`a valid journal with a different ${mismatchedTarget} is rejected before recovery`, () => {
      const s = scenario({ config: "PRE_C", store: "PRE_S" });
      const attackerDir = root();
      const attackerConfigPath = join(attackerDir, "config.toml");
      const attackerStorePath = join(attackerDir, "opencodex-prompt.json");
      writeFileSync(attackerConfigPath, "POST_C", "utf8");
      writeFileSync(attackerStorePath, "PRE_S", "utf8");

      const forgedRecord: JournalRecord = {
        ...s.record,
        configPath: mismatchedTarget === "configPath" ? attackerConfigPath : s.configPath,
        storePath: mismatchedTarget === "storePath" ? attackerStorePath : s.storePath,
      };
      writeFileSync(s.journalPath, encodeJournal(forgedRecord), "utf8");

      const result = recover(s);
      expect(result).toMatchObject({ ok: false, error: "recovery_required" });
      if (result.ok) throw new Error("forged journal unexpectedly recovered");
      expect(result.detail).not.toContain(attackerDir);
      expect(read(attackerConfigPath)).toBe("POST_C");
      expect(read(attackerStorePath)).toBe("PRE_S");
      expect(read(s.configPath)).toBe("PRE_C");
      expect(read(s.storePath)).toBe("PRE_S");
      expect(existsSync(s.journalPath)).toBe(true);
    });
  }
});

describe("durable write", () => {
  test("creates at mode 0600, not by a later chmod", () => {
    if (process.platform === "win32") return;
    const dir = root();
    const path = join(dir, "secret.json");
    durableWrite(path, "body");
    expect(readFileSync(path, "utf8")).toBe("body");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("leaves no temp file behind", () => {
    const dir = root();
    durableWrite(join(dir, "a.json"), "x");
    const leftovers = require("node:fs").readdirSync(dir).filter((f: string) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  test("overwrites an existing file atomically", () => {
    const dir = root();
    const path = join(dir, "a.json");
    durableWrite(path, "one");
    durableWrite(path, "two");
    expect(readFileSync(path, "utf8")).toBe("two");
  });

  test("successful durable writes release temp ACL memos", () => {
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ocx-test-user";
    resetHardenedStateForTests();
    setPlatformForTests("win32");
    setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
    try {
      const dir = root();
      durableWrite(join(dir, "one.json"), "one");
      expect(hardenedSecretPathCountForTests()).toBe(0);
      durableWrite(join(dir, "two.json"), "two");
      expect(hardenedSecretPathCountForTests()).toBe(0);
    } finally {
      setIcaclsRunnerForTests(null);
      setPlatformForTests(null);
      resetHardenedStateForTests();
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
    }
  });

  test("a temp that disappears during hardening still releases its memo", () => {
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ocx-test-user";
    resetHardenedStateForTests();
    setPlatformForTests("win32");
    const dir = root();
    setIcaclsRunnerForTests(() => {
      // The temp vanishes mid-harden; hardenEntry still records the success memo.
      for (const name of readdirSync(dir)) {
        if (name.endsWith(".tmp")) unlinkSync(join(dir, name));
      }
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });
    try {
      // openSync then fails on the missing temp — but the success memo must not linger.
      expect(() => durableWrite(join(dir, "out.json"), "x")).toThrow();
      expect(hardenedSecretPathCountForTests()).toBe(0);
    } finally {
      setIcaclsRunnerForTests(null);
      setPlatformForTests(null);
      resetHardenedStateForTests();
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
    }
  });
});
