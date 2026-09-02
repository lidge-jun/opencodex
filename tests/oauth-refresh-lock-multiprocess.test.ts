import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OAUTH_PROVIDERS,
  refreshGenericAccountWithLock,
} from "../src/oauth";
import {
  OAUTH_REFRESH_LOCK_WAIT_MS,
  createOAuthRefreshIntentLock,
  getAccountCredential,
  getAccountSet,
  saveCredential,
} from "../src/oauth/store";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const origHome = process.env.HOME;
const origOcxHome = process.env.OPENCODEX_HOME;
const origKimiRefresh = OAUTH_PROVIDERS.kimi!.refresh;
let tmp: string;

/** Cursor refresh bound: 3 attempts × 15s timeout + retry backoff budget. */
const CURSOR_MAX_REFRESH_BOUND_MS = 15_000 * 3 + 5_000;

beforeEach(() => {
  tmp = join(tmpdir(), `oauth-lock-mp-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
  process.env.HOME = tmp;
  process.env.OPENCODEX_HOME = join(tmp, "ocx");
});

afterEach(() => {
  OAUTH_PROVIDERS.kimi!.refresh = origKimiRefresh;
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = origOcxHome;
  removeTreeWithRetry(tmp);
});

describe("OAuth refresh lock wait bound", () => {
  test("covers maximum Cursor refresh duration including retries", () => {
    expect(OAUTH_REFRESH_LOCK_WAIT_MS).toBeGreaterThanOrEqual(CURSOR_MAX_REFRESH_BOUND_MS);
  });
});

describe("slow multi-process OAuth refresh lock", () => {
  test("second process waits and adopts the persisted credential", async () => {
    await saveCredential("kimi", {
      access: "kimi-old",
      refresh: "rt-old",
      expires: Date.now() - 1,
      accountId: "kimi-acct",
    });
    const accountId = getAccountSet("kimi")!.activeAccountId;
    const readyPath = join(tmp, "lock-held");
    const holdMs = 2_500;

    const writerScript = `
      import { createOAuthRefreshIntentLock, saveCredential } from "./src/oauth/store.ts";
      const accountId = process.env.ACCOUNT_ID;
      const readyPath = process.env.READY_PATH;
      const holdMs = Number(process.env.HOLD_MS || "2500");
      const lock = createOAuthRefreshIntentLock("kimi", accountId);
      const guard = await lock.acquire();
      await Bun.write(readyPath, "held");
      await Bun.sleep(holdMs);
      await saveCredential("kimi", {
        access: "from-writer",
        refresh: "rt-writer",
        expires: Date.now() + 3_600_000,
        accountId: "kimi-acct",
      });
      guard.release();
      console.log("writer-done");
    `;

    const writer = Bun.spawn([process.execPath, "--eval", writerScript], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: tmp,
        OPENCODEX_HOME: join(tmp, "ocx"),
        ACCOUNT_ID: accountId,
        READY_PATH: readyPath,
        HOLD_MS: String(holdMs),
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const deadline = Date.now() + 15_000;
    while (!existsSync(readyPath) && Date.now() < deadline) {
      await Bun.sleep(25);
    }
    if (!existsSync(readyPath)) {
      const err = await new Response(writer.stderr).text();
      throw new Error(`writer never signaled lock held: ${err}`);
    }

    let idpCalls = 0;
    const stale = getAccountCredential("kimi", accountId)!;
    OAUTH_PROVIDERS.kimi!.refresh = async () => {
      idpCalls++;
      throw new Error("IdP must not be called after peer persisted a fresh credential");
    };

    const started = Date.now();
    const access = await refreshGenericAccountWithLock(
      "kimi",
      accountId,
      OAUTH_PROVIDERS.kimi!,
      stale,
      { intentLock: createOAuthRefreshIntentLock("kimi", accountId) },
    );
    const waited = Date.now() - started;

    expect(access).toBe("from-writer");
    expect(idpCalls).toBe(0);
    expect(waited).toBeGreaterThanOrEqual(holdMs - 200);
    expect(getAccountCredential("kimi", accountId)?.refresh).toBe("rt-writer");

    const writerExit = await writer.exited;
    expect(writerExit).toBe(0);
    const writerOut = await new Response(writer.stdout).text();
    expect(writerOut).toContain("writer-done");
  }, 30_000);
});
