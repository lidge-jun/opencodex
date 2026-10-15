import { describe, expect, test } from "bun:test";
import { readMuseKeychain, MUSE_KEYCHAIN_TIMEOUT_MS, type MuseKeychainProcess } from "../../src/oauth/meta-muse-keychain";
import { MuseLoginError } from "../../src/oauth/meta-muse-errors";

function child(code: number, output = ""): MuseKeychainProcess {
  return { stdout: new Blob([output]).stream(), exited: Promise.resolve(code), kill() {} };
}

describe("Muse Keychain approval lifecycle (no real Keychain)", () => {
  test("allows time for a human approval and uses the measured service/account", async () => {
    expect(MUSE_KEYCHAIN_TIMEOUT_MS).toBe(120_000);
    let args: string[] = [];
    const result = await readMuseKeychain(undefined, {
      spawn: argv => { args = argv; return child(0, "  synthetic-credential\n"); },
    });
    expect(args).toEqual(["/usr/bin/security", "find-generic-password", "-s", "ai.meta.dev.credentials", "-a", "meta", "-w"]);
    expect(result).toBe("synthetic-credential");
  });

  test("approval after the old five-second cutoff still succeeds", async () => {
    const result = await readMuseKeychain(undefined, {
      spawn: () => ({ ...child(0, "approved"), exited: Bun.sleep(5_100).then(() => 0) }),
    });
    expect(result).toBe("approved");
  }, 10_000);

  test.each([[44, "keychain-missing"], [51, "keychain-denied"], [128, "keychain-denied"], [36, "keychain-locked"], [1, "keychain-unreadable"]] as const)("exit %i has safe reason %s", async (code, kind) => {
    const error = await readMuseKeychain(undefined, { spawn: () => child(code, "private-output") }).catch(e => e);
    expect(error).toBeInstanceOf(MuseLoginError);
    expect(error.kind).toBe(kind);
    expect(error.message).not.toContain("private-output");
  });

  test("deadline terminates a pending prompt and reports timeout", async () => {
    let killed = false;
    const error = await readMuseKeychain(undefined, {
      timeoutMs: 5,
      spawn: () => ({ stdout: new ReadableStream({ start() {} }), exited: new Promise(() => {}), kill() { killed = true; } }),
    }).catch(e => e);
    expect(error.kind).toBe("keychain-timeout");
    expect(killed).toBe(true);
  });

  test("cancellation kills the child without leaking its reason", async () => {
    const ac = new AbortController();
    let killed = false;
    const pending = readMuseKeychain(ac.signal, {
      spawn: () => ({ stdout: new ReadableStream(), exited: new Promise(() => {}), kill() { killed = true; } }),
    });
    ac.abort(new Error("private-cancellation-reason"));
    const error = await pending.catch(e => e);
    expect(error.kind).toBe("cancelled");
    expect(error.message).not.toContain("private-cancellation-reason");
    expect(killed).toBe(true);
  });

  test("an already cancelled login never spawns security", async () => {
    const ac = new AbortController(); ac.abort();
    let spawned = false;
    await expect(readMuseKeychain(ac.signal, { spawn: () => { spawned = true; return child(0); } })).rejects.toThrow(/cancelled/);
    expect(spawned).toBe(false);
  });

  test("spawn errors and empty entries have fixed diagnostics", async () => {
    await expect(readMuseKeychain(undefined, { spawn: () => { throw new Error("private-path"); } })).rejects.toThrow("Could not read the Muse Code credential");
    await expect(readMuseKeychain(undefined, { spawn: () => child(0) })).rejects.toThrow("Could not read the Muse Code credential");
  });
});
