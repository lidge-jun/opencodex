import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  nativeMainClaimPath,
  withNativeMainExclusiveClaim,
  withNativeMainSharedClaim,
} from "../src/codex/native-main-claim";
import { retainNativeMainOwner } from "../src/codex/native-main-owner";
import type { NativeProfileContext } from "../src/codex/native-profile-store";

const roots: string[] = [];
const noHardening = async (): Promise<void> => {};

function fixture(): NativeProfileContext {
  const codexHome = mkdtempSync(join(tmpdir(), "ocx-native-claim-"));
  roots.push(codexHome);
  return { codexHome } as NativeProfileContext;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("native-main shared and exclusive claims", () => {
  test("shared readers coexist while an immediate exclusive transition fails closed", async () => {
    const context = fixture();
    const entered = deferred();
    const release = deferred();
    const first = withNativeMainSharedClaim(context, async () => {
      entered.resolve();
      await release.promise;
      return "first";
    }, { hardenPath: noHardening });
    await entered.promise;

    await expect(withNativeMainSharedClaim(
      context,
      async () => "second",
      { hardenPath: noHardening },
    )).resolves.toBe("second");
    await expect(withNativeMainExclusiveClaim(
      context,
      async () => "must-not-run",
      { waitMs: 0, hardenPath: noHardening },
    )).rejects.toMatchObject({ code: "NATIVE_MAIN_CLAIM_BUSY", retryable: true });

    release.resolve();
    await expect(first).resolves.toBe("first");
  });

  test("closing a sibling reader cannot let another process bypass a retained shared claim", async () => {
    const context = fixture();
    const entered = deferred();
    const release = deferred();
    const retained = withNativeMainSharedClaim(context, async () => {
      entered.resolve();
      await release.promise;
    }, { hardenPath: noHardening });
    await entered.promise;
    await withNativeMainSharedClaim(context, async () => undefined, { hardenPath: noHardening });

    const child = Bun.spawn([
      process.execPath,
      join(import.meta.dir, "helpers", "native-main-claim-child.ts"),
      context.codexHome,
    ], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({ status: "rejected", code: "NATIVE_MAIN_CLAIM_BUSY" });

    release.resolve();
    await retained;
  });

  test("a bounded exclusive transition waits for an existing shared reader", async () => {
    const context = fixture();
    const entered = deferred();
    const release = deferred();
    const reader = withNativeMainSharedClaim(context, async () => {
      entered.resolve();
      await release.promise;
    }, { hardenPath: noHardening });
    await entered.promise;

    const writer = withNativeMainExclusiveClaim(
      context,
      async () => "exclusive",
      { waitMs: 2_000, pollMs: 10, hardenPath: noHardening },
    );
    const releaseTimer = setTimeout(release.resolve, 50);
    await expect(writer).resolves.toBe("exclusive");
    clearTimeout(releaseTimer);
    await reader;
  });

  test("a malformed claim database is preserved and reported unavailable", async () => {
    const context = fixture();
    mkdirSync(context.codexHome, { recursive: true });
    const path = nativeMainClaimPath(context);
    const malformed = Buffer.from("not-a-sqlite-database\n", "utf8");
    writeFileSync(path, malformed);

    await expect(withNativeMainSharedClaim(
      context,
      async () => "must-not-run",
      { hardenPath: noHardening },
    )).rejects.toMatchObject({ code: "NATIVE_MAIN_CLAIM_UNAVAILABLE", retryable: true });
    expect(readFileSync(path)).toEqual(malformed);
  });

  test("operation errors are preserved after claim setup succeeds", async () => {
    const context = fixture();
    const failure = new Error("operation failed");
    await expect(withNativeMainSharedClaim(
      context,
      async () => { throw failure; },
      { hardenPath: noHardening },
    )).rejects.toBe(failure);
  });

  test("release detaches an acquiring owner before asynchronous cleanup settles", async () => {
    const context = { ...fixture(), homeId: crypto.randomUUID() } as NativeProfileContext;
    const hardeningStarted = deferred();
    const allowHardening = deferred();
    const first = retainNativeMainOwner(context, {
      retryMs: 10,
      hardenPath: async () => {
        hardeningStarted.resolve();
        await allowHardening.promise;
      },
    });
    await hardeningStarted.promise;
    const closing = first.release();
    const successor = retainNativeMainOwner(context, { retryMs: 10, hardenPath: noHardening });
    expect(successor.snapshot().status).toBe("acquiring");
    allowHardening.resolve();
    await closing;

    const deadline = Date.now() + 2_000;
    while (successor.snapshot().status !== "held" && Date.now() < deadline) await Bun.sleep(10);
    expect(successor.snapshot().status).toBe("held");
    await successor.release();
  });
});

describe("the default hardener is actually reached from a claim", () => {
  /**
   * Nearly every test in this file injects `hardenPath: noHardening`, which is
   * right for the behavior they are testing and wrong as a whole: an audit
   * deleted the hardening call from `openClaimDatabase` and 89 tests across
   * three files stayed green. The primitive had 77 tests; the edge that reaches
   * it from a claim had none.
   *
   * So this one runs a claim with the DEFAULT hardener and inspects the file it
   * left behind. On POSIX that is the mode; the Windows branch is proven
   * separately in tests/windows-secret-acl.test.ts, where the ACL runner can be
   * observed.
   */
  test("a shared claim narrows a permissive claim database to 0600", async () => {
    const context = fixture();
    const path = nativeMainClaimPath(context);
    mkdirSync(join(context.codexHome), { recursive: true });
    writeFileSync(path, "");
    chmodSync(path, 0o644);
    // Windows synthesizes mode from the read-only attribute and answers 0o666
    // whatever chmod requested, so the narrowing cannot be observed through stat
    // there. The permissive precondition and the narrowed result are both POSIX
    // claims; the call itself still runs on every platform.
    const posixModes = process.platform !== "win32";
    if (posixModes) expect(statSync(path).mode & 0o777).toBe(0o644);

    // No hardenPath override: this is the production default.
    await withNativeMainSharedClaim(context, async () => undefined);

    if (posixModes) expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
