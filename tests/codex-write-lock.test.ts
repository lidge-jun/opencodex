/**
 * N — one bounded writer per canonical CODEX_HOME.
 *
 * What matters here is not that a mutex excludes. It is that the WRONG things
 * cannot happen: two spellings of one home must not take two locks, a home the
 * ambient environment would not have safety-checked must be refused rather than
 * locked, and a permanent refusal must never be reported as contention — a
 * caller told to retry something that will fail identically forever is how a UI
 * spins on a problem only the user can fix.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import {
  resolveCodexCoordinatorDatabasePath,
  resolveEffectiveUserIdentity,
} from "../src/codex/user-identity";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CODEX_WRITE_LOCK_MAX_TIMEOUT_MS,
  canonicalizeCodexHome,
  withCodexWriteLock,
} from "../src/codex/codex-write-lock";
import type { AdmissionSnapshot } from "../src/codex/convergence-types";

let root = "";
let codexHome = "";
let previousCodexHome: string | undefined;
const cleanup: string[] = [];

/**
 * The lock compares `authoritySnapshotId` and nothing else, so the rest is
 * deliberately minimal — a fixture that mirrored every field would suggest the
 * lock reads them.
 */
function admission(authoritySnapshotId = "authority-1"): AdmissionSnapshot {
  return { authoritySnapshotId } as AdmissionSnapshot;
}

function options(overrides: Partial<Parameters<typeof withCodexWriteLock>[0]> = {}) {
  const admitted = overrides.admitted ?? admission();
  return {
    timeoutMs: 0,
    admitted,
    readAdmissionUnderLock: () => admitted,
    ...overrides,
  } as Parameters<typeof withCodexWriteLock>[0];
}

/**
 * A commit that actually publishes a transition.
 *
 * The lock verifies the row before it will commit, so a callback that writes
 * nothing is not a valid commit — and that is the point: a caller cannot take N,
 * do something else, and have the coordinator record a transition it never made.
 */
function publishing<T>(value: T) {
  return (ctx: Parameters<Parameters<typeof withCodexWriteLock>[1]>[0]): T => {
    ctx.coordinator.beginTransition(
      // The expected pair comes from the row the lock just read, not from an
      // assumed zero: another process may have already published a transition,
      // and hardcoding {0, null} would make this test pass only when it runs
      // first.
      { nativeGeneration: ctx.expectation.nativeBefore, currentTxId: ctx.currentTxId },
      {
        txId: ctx.expectation.txId,
        direction: "apply",
        authoritySnapshotId: ctx.admission.authoritySnapshotId,
        nextRetryAt: new Date().toISOString(),
      },
    );
    return value;
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-write-lock-"));
  cleanup.push(root);
  codexHome = join(root, ".codex");
  mkdirSync(codexHome, { recursive: true });
  // A clean home: the coordinator refuses to initialize over routing residue.
  writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5"\n');
  previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
});

afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe("canonical home identity", () => {
  /**
   * Every spelling of one directory must land on one lock id, or two processes
   * that mean the same home take different locks and exclude nothing. This is
   * the split the whole design exists to prevent.
   */
  test("symlinked, trailing-slash and relative spellings share one lock id", () => {
    const link = join(root, "linked-home");
    if (process.platform === "win32") symlinkSync(codexHome, link, "junction");
    else symlinkSync(codexHome, link);

    const direct = canonicalizeCodexHome(codexHome);
    const viaLink = canonicalizeCodexHome(link);
    const trailing = canonicalizeCodexHome(`${codexHome}/`);
    const dotted = canonicalizeCodexHome(join(codexHome, ".", ""));

    expect(direct.ok && viaLink.ok && trailing.ok && dotted.ok).toBe(true);
    const ids = [direct, viaLink, trailing, dotted].map(r => (r.ok ? r.home.lockId : "x"));
    expect(new Set(ids).size).toBe(1);
  });

  test("two genuinely different homes do not share a lock id", () => {
    const other = join(root, "other-home");
    mkdirSync(other, { recursive: true });
    const a = canonicalizeCodexHome(codexHome);
    const b = canonicalizeCodexHome(other);
    expect(a.ok && b.ok).toBe(true);
    expect(a.ok && b.ok && a.home.lockId === b.home.lockId).toBe(false);
  });

  /**
   * A missing home is REFUSED rather than resolved optimistically. Keeping an
   * unresolved suffix would split one future home on a case-insensitive
   * filesystem, or alias two on a case-sensitive one.
   */
  test("a missing home refuses instead of inventing an identity", () => {
    const result = canonicalizeCodexHome(join(root, "never-created"));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("codex_home_missing");
  });

  test("a home that is a file refuses", () => {
    const file = join(root, "not-a-dir");
    writeFileSync(file, "x");
    const result = canonicalizeCodexHome(file);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("codex_home_unsafe");
  });
});

describe("refusals are not contention", () => {
  test("a timeout outside the cap is refused, not clamped", async () => {
    for (const timeoutMs of [-1, 1.5, CODEX_WRITE_LOCK_MAX_TIMEOUT_MS + 1]) {
      const result = await withCodexWriteLock(options({ timeoutMs }), () => "never");
      expect(result.status).toBe("refused");
      expect(result.status === "refused" && result.retryable).toBe(false);
    }
  });

  /**
   * The residue guard that decides whether the coordinator row may be created
   * resolves its home from the AMBIENT environment, while the lock path keys on
   * the home we were handed. Locking one directory while a different one was
   * safety-checked is the hazard; until that guard takes the target as a
   * parameter, a mismatch must refuse.
   */
  test("an explicit home that is not the ambient one is refused", async () => {
    const other = join(root, "elsewhere");
    mkdirSync(other, { recursive: true });
    const result = await withCodexWriteLock(options({ codexHome: other }), () => "never");
    expect(result.status).toBe("refused");
    expect(result.status === "refused" && result.reason).toBe("authority_not_proven");
  });

  test("a blank explicit home is refused as a programmer error", async () => {
    const result = await withCodexWriteLock(options({ codexHome: "   " }), () => "never");
    expect(result.status).toBe("refused");
    expect(result.status === "refused" && result.reason).toBe("codex_home_unsafe");
  });

  /**
   * A permanent failure must NOT enter the retry loop.
   *
   * This is the defect this unit produced repeatedly at other layers: a denial
   * classified as contention becomes an endless retry wearing the costume of a
   * busy lock. Here the coordinator database is replaced by a directory, so
   * every open fails identically forever — and a deadline long enough to notice
   * proves the difference. A retrying implementation burns the whole budget and
   * reports `busy`; a correct one refuses immediately.
   */
  test("an unopenable coordinator refuses immediately instead of retrying to the deadline", async () => {
    const identity = resolveEffectiveUserIdentity();
    const dbPath = resolveCodexCoordinatorDatabasePath(identity, realpathSync.native(codexHome));
    rmSync(dbPath, { force: true });
    // A directory where the database belongs: openable never, busy never.
    mkdirSync(dbPath, { recursive: true });

    const started = performance.now();
    const result = await withCodexWriteLock(options({ timeoutMs: 2_000 }), () => "never");
    const elapsed = performance.now() - started;

    expect(result.status).toBe("refused");
    expect(result.status === "refused" && result.retryable).toBe(false);
    // It did not spend the deadline discovering that a permanent failure is
    // permanent.
    expect(elapsed).toBeLessThan(1_000);
  });

  test("an explicit home equal to the ambient one is accepted", async () => {
    const result = await withCodexWriteLock(options({ codexHome }), publishing("ok"));
    expect(result.status).toBe("acquired");
  });
});

describe("holding the lock", () => {
  test("the callback runs under the lock and its value comes back", async () => {
    const result = await withCodexWriteLock(options(), ctx => {
      expect(ctx.canonicalCodexHome).toBe(realpathSync.native(codexHome));
      expect(ctx.expectation.nativeAfter).toBe(ctx.expectation.nativeBefore + 1);
      return publishing(42)(ctx);
    });
    expect(result.status).toBe("acquired");
    expect(result.status === "acquired" && result.value).toBe(42);
  });

  /**
   * Reentrancy is a DIAGNOSIS, not the exclusion mechanism — SQLite already
   * refuses the second open. The value is that the caller is told "you already
   * hold this" instead of being sent into a retry loop that cannot succeed.
   */
  test("re-entering from inside the callback is refused as reentrant, not busy", async () => {
    let nested: Promise<Awaited<ReturnType<typeof withCodexWriteLock>>> | undefined;
    const outer = await withCodexWriteLock(options(), ctx => {
      // The nested call STARTS synchronously — far enough to read the reentrancy
      // store and refuse — and its promise is settled after the callback returns.
      // Returning it would trip the thenable guard, so it is captured instead.
      nested = withCodexWriteLock(options(), publishing("nested"));
      return publishing(1)(ctx);
    });
    expect(outer.status).toBe("acquired");
    const inner = await nested!;
    expect(inner.status).toBe("refused");
    expect(inner.status === "refused" && inner.reason).toBe("reentrant");
  });

  /**
   * A callback failure is the CALLER's error, not a lock outcome. Converting it
   * into `busy` would tell them to retry something that will fail identically,
   * and into `refused` would hide their own exception.
   */
  test("a callback throw propagates rather than becoming busy or refused", async () => {
    await expect(withCodexWriteLock(options(), () => { throw new Error("caller blew up"); }))
      .rejects.toThrow("caller blew up");
  });

  test("an admission that changed under the lock refuses without committing", async () => {
    let calls = 0;
    const result = await withCodexWriteLock(
      options({ readAdmissionUnderLock: () => admission("authority-2") }),
      () => { calls += 1; return "never"; },
    );
    expect(result.status).toBe("refused");
    expect(result.status === "refused" && result.reason).toBe("authority_not_proven");
    // The commit never ran: a stale snapshot must not reach the callback at all.
    expect(calls).toBe(0);
  });

  /**
   * An `async` callback is rejected at typecheck, but a cast one is not. C is
   * synchronous, so awaiting it is impossible and the only safe answer is to
   * reject rather than let a promise escape the held section.
   */
  test("a cast async callback is rejected instead of escaping the held section", async () => {
    await expect(withCodexWriteLock(
      options(),
      (async () => "sneaky") as never,
    )).rejects.toThrow(/synchronous/);
  });
});

describe("two real processes contend for one lock", () => {
  /**
   * The evidence this phase actually owes. A second async task in this isolate
   * shares the connection cache and the reentrancy store, so it proves neither
   * exclusion nor its absence — this unit has already shipped a test that looked
   * like a race and was not one. So: a real child process, calling the
   * production module.
   */
  const childPath = join(import.meta.dir, "helpers", "codex-write-lock-child.ts");

  function spawnChild(payload: Record<string, unknown>) {
    return Bun.spawn(["bun", childPath], {
      env: { ...process.env, CODEX_HOME: codexHome, OCX_LOCK_CHILD_PAYLOAD: JSON.stringify(payload) },
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  /** Same child, but with the home-shaped environment variables under test. */
  function spawnChildWithEnv(payload: Record<string, unknown>, env: Record<string, string>) {
    return Bun.spawn(["bun", childPath], {
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        ...env,
        OCX_LOCK_CHILD_PAYLOAD: JSON.stringify(payload),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  async function childResult(child: ReturnType<typeof Bun.spawn>) {
    const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    const line = stdout.trim().split("\n").filter(Boolean).at(-1) ?? "{}";
    return JSON.parse(line) as { status: string; reason?: string; value?: string; lockId?: string };
  }

  async function waitFor(path: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (Bun.file(path).size > 0) return;
      await Bun.sleep(10);
    }
    throw new Error(`timed out waiting for ${path}`);
  }

  test("a second process is excluded while the first holds, and succeeds after it releases", async () => {
    const holdMarker = join(root, "held");
    const releaseMarker = join(root, "release");

    const holder = spawnChild({ holdMarker, releaseMarker, timeoutMs: 0 });
    await waitFor(holdMarker);

    // The lock is genuinely held by another process right now.
    const blocked = await withCodexWriteLock(options({ timeoutMs: 0 }), publishing("parent"));
    expect(blocked.status).toBe("busy");
    expect(blocked.status === "busy" && blocked.reason).toBe("deadline");

    writeFileSync(releaseMarker, "go");
    const held = await childResult(holder);
    expect(held.status).toBe("acquired");

    // And once it is released the same call succeeds — proving the earlier busy
    // was contention rather than a permanent refusal wearing its label.
    const after = await withCodexWriteLock(options({ timeoutMs: 5_000 }), publishing("parent"));
    expect(after.status).toBe("acquired");
  }, 30_000);

  test("both processes resolve the same lock id for one home", async () => {
    const first = await childResult(spawnChild({ timeoutMs: 5_000 }));
    expect(first.status).toBe("acquired");
    const local = canonicalizeCodexHome(codexHome);
    expect(local.ok && first.lockId).toBe(local.ok ? local.home.lockId : "x");
  }, 30_000);

  /**
   * A waiting contender must actually wait rather than fail fast — and must
   * still come back typed rather than hanging. The holder releases partway
   * through, so a deadline longer than the hold succeeds.
   */
  test("a contender with a deadline waits for the holder instead of failing immediately", async () => {
    const holdMarker = join(root, "held-2");
    const releaseMarker = join(root, "release-2");
    const holder = spawnChild({ holdMarker, releaseMarker, timeoutMs: 0 });
    await waitFor(holdMarker);

    const waiter = withCodexWriteLock(options({ timeoutMs: 5_000 }), publishing("waited"));
    await Bun.sleep(150);
    writeFileSync(releaseMarker, "go");

    const [waited, holderResult] = await Promise.all([waiter, childResult(holder)]);
    expect(holderResult.status).toBe("acquired");
    expect(waited.status).toBe("acquired");
    expect(waited.status === "acquired" && waited.waitedMs).toBeGreaterThan(0);
  }, 30_000);

  /**
   * C7/C18 — the namespace keys on the OS user, not on any home accessor.
   *
   * This is defect #7 of this unit, and it had no test until now: the lock module
   * shipped with real two-process contention proven, while the property that makes
   * that contention MEAN anything was unasserted. Bun 1.3.14 returns an
   * environment-controlled home from both `os.homedir()` and
   * `os.userInfo().homedir`, so a namespace derived from either splits one OS user
   * across two lock files whenever a service and a CLI see different HOME values —
   * and two processes that should exclude each other quietly stop doing so.
   *
   * The plan is explicit that setting HOME and USERPROFILE to the SAME fake value
   * in both children is insufficient, because that cannot catch the original split.
   * So each case varies one variable while holding the other equal, and the last
   * varies both in opposite directions at once.
   */
  /*
   * Built INSIDE each test, not at module scope.
   *
   * `root` is assigned in beforeEach, so evaluating these paths while the module
   * loads produced `join("", "fake-home-a")` — a RELATIVE path — and the children
   * dutifully created `fake-home-a/` and friends in the repository root. The test
   * still "passed" its exclusion assertion, which is the tell: a fixture that
   * silently writes to the wrong place looks identical to one that works.
   */
  const homeEnvironments = () => [
    {
      name: "HOME differs, USERPROFILE shared",
      a: { HOME: join(root, "fake-home-a"), USERPROFILE: join(root, "fake-common") },
      b: { HOME: join(root, "fake-home-b"), USERPROFILE: join(root, "fake-common") },
    },
    {
      name: "USERPROFILE differs, HOME shared",
      a: { HOME: join(root, "fake-common"), USERPROFILE: join(root, "fake-profile-a") },
      b: { HOME: join(root, "fake-common"), USERPROFILE: join(root, "fake-profile-b") },
    },
    {
      name: "both differ, in opposite directions",
      a: { HOME: join(root, "fake-home-a"), USERPROFILE: join(root, "fake-profile-b") },
      b: { HOME: join(root, "fake-home-b"), USERPROFILE: join(root, "fake-profile-a") },
    },
  ] as const;

  for (const index of [0, 1, 2] as const) {
    test(`one OS user and one home take ONE lock, case ${index}`, async () => {
      const { name, a, b } = homeEnvironments()[index];
      // Same OS user, same CODEX_HOME, different home-shaped environment. They
      // must exclude each other, which can only happen if they resolved the same
      // namespace.
      //
      // Every fake home is created under the per-test temp root first, so a
      // child that resolves one still writes inside the fixture.
      for (const dir of [a.HOME, a.USERPROFILE, b.HOME, b.USERPROFILE]) {
        mkdirSync(dir, { recursive: true });
      }
      const holdMarker = join(root, `held-env-${name.replace(/[^a-z]+/gi, "-")}`);
      const releaseMarker = join(root, `release-env-${name.replace(/[^a-z]+/gi, "-")}`);

      const holder = spawnChildWithEnv({ holdMarker, releaseMarker, timeoutMs: 0 }, { ...a });
      await waitFor(holdMarker);

      // Fail-fast: if the two environments produced different lock files this
      // would acquire instead of reporting contention.
      const contender = await childResult(
        spawnChildWithEnv({ timeoutMs: 0 }, { ...b }),
      );
      expect(contender.status).toBe("busy");

      writeFileSync(releaseMarker, "go");
      const held = await childResult(holder);
      expect(held.status).toBe("acquired");

      // And the identity is literally the same value, not merely a shared outcome.
      const after = await childResult(
        spawnChildWithEnv({ timeoutMs: 5_000 }, { ...b }),
      );
      expect(after.status).toBe("acquired");
      expect(after.lockId).toBe(held.lockId);
    }, 30_000);
  }
});
