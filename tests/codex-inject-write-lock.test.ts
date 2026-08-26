/**
 * The production call edge, proven by contention rather than by a spy.
 *
 * `withCodexWriteLock` shipped with zero production callers, and every test it
 * had exercised it with a fabricated snapshot. The property that matters is not
 * "the lock function was invoked" — a pass-through mock satisfies that — but
 * that two real processes running the real injection cannot both write.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveCodexCoordinatorDatabasePath,
  resolveEffectiveUserIdentity,
} from "../src/codex/user-identity";
import { STABLE_ZERO_BYTE_COORDINATOR_AGE_MS } from "../src/codex/inject-coordination";

const repoRoot = join(import.meta.dir, "..");
const CHILD = join(repoRoot, "tests", "helpers", "codex-inject-race-child.ts");
const LOCK_CHILD = join(repoRoot, "tests", "helpers", "codex-write-lock-child.ts");

let root = "";
let codexHome = "";
let opencodexHome = "";
const cleanup: string[] = [];
const coordinatorCleanup: string[] = [];

function seedNative(): void {
  writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5"\n');
}

function runInject(port: number, lockTimeoutMs = 0): { success: boolean; status?: "skipped"; retryable: boolean; message: string } {
  const result = spawnSync(process.execPath, [CHILD], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      OPENCODEX_HOME: opencodexHome,
      OCX_INJECT_RACE_PAYLOAD: JSON.stringify({ port, lockTimeoutMs }),
    },
  });
  const line = (result.stdout ?? "").trim().split("\n").filter(Boolean).pop() ?? "{}";
  return JSON.parse(line) as { success: boolean; status?: "skipped"; retryable: boolean; message: string };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-inject-race-"));
  cleanup.push(root);
  codexHome = join(root, ".codex");
  opencodexHome = join(root, ".opencodex");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(opencodexHome, { recursive: true });
});

afterEach(() => {
  while (coordinatorCleanup.length) {
    const path = coordinatorCleanup.pop()!;
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      rmSync(`${path}${suffix}`, { force: true });
    }
  }
  while (cleanup.length) {
    const dir = cleanup.pop()!;
    // `force` covers a missing path, not a locked one: a child that is still exiting
    // can hold a coordinator file open for a few milliseconds, and Windows answers
    // EBUSY rather than unlinking underneath it. Retry briefly, then leave the temp
    // directory to the OS -- failing teardown would blame whichever test ran here.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw err;
        if (attempt < 4) Bun.sleepSync(50 * (attempt + 1));
      }
    }
  }
});

describe("the lock is on the production path", () => {
  test("a persisted OFF observed under N skips the real injector without writing", () => {
    seedNative();
    const configPath = join(codexHome, "config.toml");
    const before = readFileSync(configPath, "utf8");
    writeFileSync(join(opencodexHome, "config.json"), JSON.stringify({
      providers: {}, defaultProvider: "openai", clientIntegrations: { codex: false },
    }));

    const result = runInject(20200);

    expect(result).toMatchObject({ success: true, status: "skipped" });
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  test("a clean first apply coordinates and records a transition", () => {
    seedNative();
    const result = runInject(10100);
    expect(result.success).toBeTrue();

    // The row is the proof that the lock ran, not that the function was called.
    const state = spawnSync(process.execPath, ["--eval", `
      const { readCodexTransitionState } = require("./src/codex/transition-state");
      console.log(JSON.stringify(readCodexTransitionState()));
    `], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: opencodexHome },
    });
    const row = JSON.parse((state.stdout ?? "{}").trim().split("\n").pop() ?? "{}") as {
      kind?: string;
      state?: { nativeGeneration?: number; currentTxId?: string | null };
    };
    expect(row.kind).toBe("ready");
    expect(row.state?.nativeGeneration).toBeGreaterThan(0);
    // Guessing null passes on a fresh machine and fails on a real one, so the
    // id being present is part of the claim.
    expect(typeof row.state?.currentTxId).toBe("string");
  });

  /**
   * The contention proof. A real second process holds N through the production
   * lock module while a real injection runs; the injection must report busy and
   * must not have written its candidate bytes.
   */
  test("a held lock makes real injection report busy and write nothing", async () => {
    seedNative();
    // Establish the coordinator first: a clean home has no row, and the holder
    // needs one to contend over.
    expect(runInject(10100).success).toBeTrue();
    const afterFirst = readFileSync(join(codexHome, "config.toml"), "utf-8");

    const holdMarker = join(root, "held");
    const releaseMarker = join(root, "release");
    const holder = Bun.spawn([process.execPath, LOCK_CHILD], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        OPENCODEX_HOME: opencodexHome,
        OCX_LOCK_CHILD_PAYLOAD: JSON.stringify({ timeoutMs: 5_000, holdMarker, releaseMarker }),
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const deadline = Date.now() + 10_000;
    while (!existsSync(holdMarker) && Date.now() < deadline) {
      spawnSync(process.execPath, ["--eval", "Bun.sleepSync(20)"], { encoding: "utf8" });
    }
    expect(existsSync(holdMarker)).toBeTrue();

    // PROCESS-UNIQUE bytes: a different port means different candidate bytes, so
    // the loser's work is identifiable rather than assumed.
    const contender = runInject(20200);

    writeFileSync(releaseMarker, "go");
    // AWAIT the holder. Dropping its exit on the floor left a live child owning the
    // coordinator database while afterEach removed the temp root, and Windows refuses
    // to unlink a file another process still has open -- so teardown failed with EBUSY
    // and blamed this test for a race it had already won. POSIX unlinks regardless,
    // which is why only Windows ever saw it, and only under full-suite load.
    await holder.exited;

    expect(contender.success).toBeFalse();
    expect(contender.retryable).toBeTrue();
    // Its bytes are absent: the file still names the first winner's port.
    const finalConfig = readFileSync(join(codexHome, "config.toml"), "utf-8");
    expect(finalConfig).not.toContain("20200");
    expect(finalConfig).toBe(afterFirst);
  }, 30_000);
});

describe("homes the coordinator cannot adopt keep working", () => {
  /**
   * Every install predating this substrate is routed with no coordinator row,
   * and that row cannot be created over routed bytes. Gating on the lock there
   * would have broken re-injection for the entire installed base.
   */
  test("a pre-substrate routed home still injects, without a coordinator", () => {
    writeFileSync(join(codexHome, "config.toml"), [
      'model_provider = "opencodex"',
      'model = "gpt-5.5"',
      "",
      "[model_providers.opencodex]",
      'name = "OpenCodex Proxy"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'wire_api = "responses"',
      "",
    ].join("\n"));

    const result = runInject(10100);
    expect(result.success).toBeTrue();
    expect(readFileSync(join(codexHome, "config.toml"), "utf-8")).toContain("openai_base_url");
  });

  test("a zero-byte coordinator remnant does not wedge a pre-substrate routed home", () => {
    writeFileSync(join(codexHome, "config.toml"), [
      'model_provider = "opencodex"',
      'model = "gpt-5.5"',
      "",
      "[model_providers.opencodex]",
      'name = "OpenCodex Proxy"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'wire_api = "responses"',
      "",
    ].join("\n"));
    const coordinatorPath = resolveCodexCoordinatorDatabasePath(
      resolveEffectiveUserIdentity(),
      realpathSync.native(codexHome),
    );
    coordinatorCleanup.push(coordinatorPath);
    writeFileSync(coordinatorPath, "");
    if (process.platform !== "win32") chmodSync(coordinatorPath, 0o600);
    // Fresh zero-byte files remain on the coordinated path because they may
    // belong to a live SQLite creator. This fixture represents an old remnant.
    Bun.sleepSync(STABLE_ZERO_BYTE_COORDINATOR_AGE_MS + 100);

    const result = runInject(10100);

    expect(result.success).toBeTrue();
    expect(readFileSync(join(codexHome, "config.toml"), "utf-8")).toContain("openai_base_url");
    expect(readFileSync(coordinatorPath)).toHaveLength(0);
  });
});

describe("the transition is resolved, not left pending", () => {
  /**
   * `updateCodexHistoryTransition` had no production caller, so every completed
   * or skipped job left the row permanently `pending` — a transition published
   * and never resolved. The row must now show what the job actually did.
   */
  test("a completed apply leaves a converged row, not a pending one", () => {
    seedNative();
    expect(runInject(10100).success).toBeTrue();

    const state = spawnSync(process.execPath, ["--eval", `
      const { readCodexTransitionState } = require("./src/codex/transition-state");
      console.log(JSON.stringify(readCodexTransitionState()));
    `], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: opencodexHome },
    });
    const row = JSON.parse((state.stdout ?? "{}").trim().split("\n").pop() ?? "{}") as {
      kind?: string;
      state?: { history?: { status?: string } };
    };
    expect(row.kind).toBe("ready");
    expect(row.state?.history?.status).not.toBe("pending");
  });

  test("an opted-out apply records the opt-out as converged, not blocked", () => {
    seedNative();
    writeFileSync(join(opencodexHome, "config.json"), JSON.stringify({
      port: 10100,
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
      },
      defaultProvider: "openai",
      syncResumeHistory: false,
    }, null, 2));

    const result = spawnSync(process.execPath, [CHILD], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        OPENCODEX_HOME: opencodexHome,
        OCX_INJECT_RACE_PAYLOAD: JSON.stringify({ port: 10100, lockTimeoutMs: 0 }),
      },
    });
    expect(result.status).toBe(0);

    const state = spawnSync(process.execPath, ["--eval", `
      const { readCodexTransitionState } = require("./src/codex/transition-state");
      console.log(JSON.stringify(readCodexTransitionState()));
    `], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: opencodexHome },
    });
    const row = JSON.parse((state.stdout ?? "{}").trim().split("\n").pop() ?? "{}") as {
      kind?: string;
      state?: { history?: { status?: string; attempts?: number } };
    };
    expect(row.kind).toBe("ready");
    // Opt-out is a completed decision, not a failure: converged, never blocked,
    // and never left pending for a job that chose to do nothing.
    expect(row.state?.history?.status).toBe("converged");
  });
});
