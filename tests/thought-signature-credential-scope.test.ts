/**
 * #1926: the durable thought-signature store must isolate entries per CREDENTIAL, not
 * just per destination, and must not expose signatures across a v3 -> v4 upgrade or an
 * unscoped credential. Companion: the terminal-barrier bound on persist visibility.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  awaitThoughtSignatureDurability,
  flushThoughtSignatureReplayForTests,
  lookupReplayThoughtSignature,
  rememberThoughtSignatureForReplay,
  resetThoughtSignatureReplayForTests,
  thoughtSignatureReplaySalt,
} from "../src/responses/thought-signature-replay";
import { durableReplayCredentialIdentity, durableReplayDestinationIdentity } from "../src/responses/reasoning-replay-cache";

const SIG = "CiQAx-credential-scope-signature-0123456789abcdef";

function scopeFor(credential: string | undefined, threadId = "thread-a") {
  return {
    clientThreadId: threadId,
    current: {
      providerName: "google",
      providerDestinationIdentity: "dest-google",
      providerDestinationDurableIdentity: durableReplayDestinationIdentity("https://generativelanguage.googleapis.com"),
      adapterName: "google",
      modelId: "gemini-3.6-flash",
      credentialIdentity: "cred-process-local",
      ...(credential ? { credentialDurableIdentity: credential } : {}),
    },
  };
}

describe("#1926 durable credential scope", () => {
  let previousHome: string | undefined;
  let testDir: string;

  beforeEach(() => {
    resetThoughtSignatureReplayForTests();
    previousHome = process.env.OPENCODEX_HOME;
    testDir = mkdtempSync(join(tmpdir(), "ocx-tsig-scope-"));
    process.env.OPENCODEX_HOME = testDir;
  });

  afterEach(async () => {
    await flushThoughtSignatureReplayForTests();
    resetThoughtSignatureReplayForTests();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    rmSync(testDir, { recursive: true, force: true });
  });

  test("two credentials on one destination never share a signature", () => {
    rememberThoughtSignatureForReplay("call_x", SIG, scopeFor("credential:aaa"));
    expect(lookupReplayThoughtSignature("call_x", scopeFor("credential:aaa"))).toBe(SIG);
    expect(lookupReplayThoughtSignature("call_x", scopeFor("credential:bbb"))).toBeUndefined();
  });

  test("a scope without a durable credential identity fails closed (no store, no lookup)", () => {
    const { result } = rememberThoughtSignatureForReplay("call_y", SIG, scopeFor(undefined));
    expect(result).toBe("unscoped");
    expect(lookupReplayThoughtSignature("call_y", scopeFor(undefined))).toBeUndefined();
    // And it cannot be read back under ANY concrete credential either.
    expect(lookupReplayThoughtSignature("call_y", scopeFor("credential:aaa"))).toBeUndefined();
  });

  test("v3 store rows are dropped on load (not upgradable without credential info)", async () => {
    rememberThoughtSignatureForReplay("call_z", SIG, scopeFor("credential:aaa"));
    await flushThoughtSignatureReplayForTests();
    const storeFile = join(testDir, "thought-signature-replay.json");
    const snapshot = JSON.parse(readFileSync(storeFile, "utf8")) as { version: number; entries: unknown[] };
    expect(snapshot.version).toBe(4);
    // Regress the file to v3 and reload: entries must be dropped wholesale.
    writeFileSync(storeFile, JSON.stringify({ ...snapshot, version: 3 }));
    resetThoughtSignatureReplayForTests();
    expect(lookupReplayThoughtSignature("call_z", scopeFor("credential:aaa"))).toBeUndefined();
  });

  test("v4 rows survive a reload under the same scope", async () => {
    rememberThoughtSignatureForReplay("call_w", SIG, scopeFor("credential:aaa"));
    await flushThoughtSignatureReplayForTests();
    resetThoughtSignatureReplayForTests();
    expect(lookupReplayThoughtSignature("call_w", scopeFor("credential:aaa"))).toBe(SIG);
  });

  test("Codex pool account identities survive reload without crossing account slots", async () => {
    const salt = thoughtSignatureReplaySalt();
    const poolA = durableReplayCredentialIdentity("codex", "pool-a", undefined, salt);
    const poolB = durableReplayCredentialIdentity("codex", "pool-b", undefined, salt);
    expect(poolA).toBeDefined();
    expect(poolB).toBeDefined();
    expect(poolA).not.toBe(poolB);

    rememberThoughtSignatureForReplay("call_pool", SIG, scopeFor(poolA, "thread-pool"));
    await flushThoughtSignatureReplayForTests();
    resetThoughtSignatureReplayForTests();

    const reloadedSalt = thoughtSignatureReplaySalt();
    const reloadedPoolA = durableReplayCredentialIdentity("codex", "pool-a", undefined, reloadedSalt);
    const reloadedPoolB = durableReplayCredentialIdentity("codex", "pool-b", undefined, reloadedSalt);
    expect(reloadedPoolA).toBe(poolA);
    expect(reloadedPoolB).toBe(poolB);
    expect(lookupReplayThoughtSignature("call_pool", scopeFor(reloadedPoolB, "thread-pool"))).toBeUndefined();
    expect(lookupReplayThoughtSignature("call_pool", scopeFor(reloadedPoolA, "thread-pool"))).toBe(SIG);
  });

  test("salt is minted once, persisted, and produces stable full-width identities", () => {
    const salt = thoughtSignatureReplaySalt();
    expect(salt).toBeDefined();
    const again = thoughtSignatureReplaySalt();
    expect(again).toBe(salt);
    const id1 = durableReplayCredentialIdentity("key", "sk-secret", undefined, salt);
    const id2 = durableReplayCredentialIdentity("key", "sk-secret", undefined, salt);
    const other = durableReplayCredentialIdentity("key", "sk-other", undefined, salt);
    expect(id1).toBe(id2);
    expect(id1).not.toBe(other);
    // Full 256-bit hex — no truncated verifier material.
    expect(id1).toMatch(/^credential:[0-9a-f]{64}$/);
    // Different header overrides are different credentials.
    const withHeader = durableReplayCredentialIdentity("key", "sk-secret", { authorization: "Bearer x" }, salt);
    expect(withHeader).not.toBe(id1);
  });

  test("durable identity is refused without a usable salt or material", () => {
    const salt = thoughtSignatureReplaySalt();
    expect(durableReplayCredentialIdentity("key", undefined, undefined, salt)).toBeUndefined();
    expect(durableReplayCredentialIdentity("key", "sk-secret", undefined, undefined)).toBeUndefined();
  });

  test("terminal barrier resolves after the queued persist settles (bounded)", async () => {
    rememberThoughtSignatureForReplay("call_b", SIG, scopeFor("credential:aaa"));
    await awaitThoughtSignatureDurability();
    // After the barrier the snapshot is on disk in the normal case.
    const storeFile = join(testDir, "thought-signature-replay.json");
    const snapshot = JSON.parse(readFileSync(storeFile, "utf8")) as { entries: unknown[] };
    expect(snapshot.entries.length).toBe(1);
  });
});
