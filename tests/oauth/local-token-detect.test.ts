import { afterEach, beforeAll, afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectClaudeCodeToken,
  detectClaudeCodeTokenAsync,
  detectGrokCliToken,
  hasClaudeCredentialContinuity,
  parseClaudeOauthPayload,
  readClaudeCredentialsFile,
  shouldAdoptGrokGeneration,
} from "../../src/oauth/local-token-detect";
import { claudeKeychainReader, createClaudeKeychainReader, isSyncTimeout } from "../../src/oauth/claude-keychain-read";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let tmp: string;
let prevConfigDir: string | undefined;
let prevHome: string | undefined;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "ocx-claude-detect-"));
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  prevHome = process.env.HOME;
});

afterAll(() => {
  removeTreeWithRetry(tmp);
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
});

describe("Claude Code credentials file fallback (Linux/Windows)", () => {
  test("reads .credentials.json from CLAUDE_CONFIG_DIR", () => {
    const dir = join(tmp, "claude-a");
    mkdirSync(dir, { recursive: true });
    const payload = { claudeAiOauth: { accessToken: "at-1", refreshToken: "rt-1", expiresAt: 1234 } };
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify(payload));
    process.env.CLAUDE_CONFIG_DIR = dir;

    const raw = readClaudeCredentialsFile();
    expect(raw).not.toBeNull();
    const creds = parseClaudeOauthPayload(raw!);
    expect(creds).toEqual({ access: "at-1", refresh: "rt-1", expires: 1234, source: "local-cli" });
  });

  test("returns null when the credentials file is missing", () => {
    process.env.CLAUDE_CONFIG_DIR = join(tmp, "claude-missing");
    expect(readClaudeCredentialsFile()).toBeNull();
  });

  test("parse rejects payloads without both tokens", () => {
    expect(parseClaudeOauthPayload(JSON.stringify({ claudeAiOauth: { accessToken: "only" } }))).toBeNull();
    expect(parseClaudeOauthPayload("not json")).toBeNull();
  });
});

describe("invalid expiry handling (NaN guard)", () => {
  test("parseClaudeOauthPayload coerces a string expiresAt to unknown (0) instead of NaN", () => {
    const raw = JSON.stringify({ claudeAiOauth: { accessToken: "at-1", refreshToken: "rt-1", expiresAt: "garbage" } });
    const creds = parseClaudeOauthPayload(raw);
    expect(creds).not.toBeNull();
    expect(creds!.expires).toBe(0);
    expect(Number.isFinite(creds!.expires)).toBe(true);
  });

  test("parseClaudeOauthPayload coerces a non-finite expiresAt to unknown (0)", () => {
    const raw = JSON.stringify({ claudeAiOauth: { accessToken: "at-1", refreshToken: "rt-1", expiresAt: NaN } });
    const creds = parseClaudeOauthPayload(raw);
    expect(creds).not.toBeNull();
    expect(creds!.expires).toBe(0);
  });

  test("detectGrokCliToken coerces an unparseable expires_at to unknown (0) instead of NaN", () => {
    const grokHome = join(tmp, "grok-home");
    mkdirSync(join(grokHome, ".grok"), { recursive: true });
    writeFileSync(join(grokHome, ".grok", "auth.json"), JSON.stringify({
      "https://auth.x.ai::1": {
        key: "xai-stub-access",
        refresh_token: "xai-stub-refresh",
        expires_at: "not-a-date",
      },
    }));
    process.env.HOME = grokHome;

    const creds = detectGrokCliToken();
    expect(creds).not.toBeNull();
    expect(creds!.expires).toBe(0);
    expect(Number.isFinite(creds!.expires)).toBe(true);
  });

  test("detectGrokCliToken passes through a parseable future expires_at", () => {
    const grokHome = join(tmp, "grok-home-future");
    mkdirSync(join(grokHome, ".grok"), { recursive: true });
    const future = new Date(Date.now() + 3600_000).toISOString();
    writeFileSync(join(grokHome, ".grok", "auth.json"), JSON.stringify({
      "https://auth.x.ai::1": {
        key: "xai-stub-access",
        refresh_token: "xai-stub-refresh",
        expires_at: future,
      },
    }));
    process.env.HOME = grokHome;

    const creds = detectGrokCliToken();
    expect(creds).not.toBeNull();
    expect(creds!.expires).toBeGreaterThan(Date.now());
  });

  test("detectGrokCliToken returns null when auth.json is absent", () => {
    process.env.HOME = join(tmp, "grok-home-missing");
    expect(detectGrokCliToken()).toBeNull();
  });
});

describe("shouldAdoptGrokGeneration with NaN/unknown expiries", () => {
  const stored = { refresh: "stored-refresh", access: "stored-access", expires: Date.now() + 3600_000 };

  test("never adopts a disk credential with a non-finite expiry", () => {
    expect(shouldAdoptGrokGeneration(stored, { ...stored, expires: Number.NaN }, Date.now(), 60_000)).toBe(false);
  });

  test("rejects an unknown (0) disk expiry as requiring refresh", () => {
    expect(shouldAdoptGrokGeneration(stored, { ...stored, expires: 0 }, Date.now(), 60_000)).toBe(false);
  });

  test("rejects an already-expired disk credential", () => {
    expect(shouldAdoptGrokGeneration(stored, { ...stored, expires: Date.now() - 60_000 }, Date.now(), 60_000)).toBe(false);
  });

  test("adopts a newer valid disk credential", () => {
    const disk = { ...stored, expires: Date.now() + 7200_000 };
    expect(shouldAdoptGrokGeneration(stored, disk, Date.now(), 60_000)).toBe(true);
  });
});

describe("Claude credential continuity", () => {
  const stored = { access: "synthetic-access", refresh: "synthetic-refresh", expires: 1 };
  test("accepts a shared access or refresh token", () => {
    expect(hasClaudeCredentialContinuity(stored, { ...stored, refresh: "synthetic-new-refresh" })).toBe(true);
    expect(hasClaudeCredentialContinuity(stored, { ...stored, access: "synthetic-new-access" })).toBe(true);
  });
  test("rejects a completely replaced pair even when metadata agrees", () => {
    const metadata = { accountId: "synthetic-account", email: "synthetic@example.test" };
    expect(hasClaudeCredentialContinuity({ ...stored, ...metadata }, {
      access: "synthetic-other-access", refresh: "synthetic-other-refresh", expires: 2, ...metadata,
    })).toBe(false);
  });
  test("empty or whitespace-only values do not prove continuity", () => {
    for (const token of ["", " ", "\t"]) {
      expect(hasClaudeCredentialContinuity({ access: token, refresh: token, expires: 1 }, {
        access: token, refresh: token, expires: 2,
      })).toBe(false);
    }
  });
});

describe("Claude Keychain reader never kills a blocked security child (#8161)", () => {
  class FakeChild extends EventEmitter {
    readonly stdout = Object.assign(new EventEmitter(), { unref: mock(() => undefined) });
    readonly unref = mock(() => undefined);
    readonly kill = mock(() => true);
  }

  function harness(platform = "darwin") {
    let clock = 1_000;
    const children: FakeChild[] = [];
    const syncRuns: number[] = [];
    let syncResult: () => string = () => "sync-secret\n";
    const deadlines: Array<{ ms: number; fn: () => void; cancelled: boolean }> = [];
    const reader = createClaudeKeychainReader({
      platform,
      spawn: (command, args) => {
        expect(command).toBe("security");
        expect(args).toEqual(["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      execSync: (command, args, timeoutMs) => {
        expect(command).toBe("security");
        expect(args).toEqual(["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
        syncRuns.push(timeoutMs);
        return syncResult();
      },
      now: () => clock,
      schedule(ms, fn) {
        const entry = { ms, fn, cancelled: false };
        deadlines.push(entry);
        return () => { entry.cancelled = true; };
      },
      timeoutMs: 5_000,
      backoffMs: 60_000,
    });
    const fireDeadline = (index = deadlines.length - 1): void => {
      const entry = deadlines[index]!;
      if (!entry.cancelled) entry.fn();
    };
    return {
      reader, children, deadlines, fireDeadline, syncRuns,
      advance: (ms: number) => { clock += ms; },
      setSyncResult: (fn: () => string) => { syncResult = fn; },
    };
  }

  test("a non-darwin host never spawns", async () => {
    const h = harness("linux");
    expect(await h.reader.readAsync()).toBeNull();
    expect(h.children).toHaveLength(0);
    expect(h.reader.syncReadBlocked()).toBe(false);
  });

  test("a successful read returns trimmed stdout and cancels its deadline", async () => {
    const h = harness();
    const read = h.reader.readAsync();
    h.children[0]!.stdout.emit("data", Buffer.from("{\"claudeAiOauth\":{}}\n"));
    h.children[0]!.emit("close", 0, null);
    expect(await read).toBe("{\"claudeAiOauth\":{}}");
    expect(h.deadlines[0]!.cancelled).toBe(true);
    expect(h.reader.syncReadBlocked()).toBe(false);
  });

  test("a nonzero exit (item not found) resolves null without backoff", async () => {
    const h = harness();
    const read = h.reader.readAsync();
    h.children[0]!.emit("close", 44, null);
    expect(await read).toBeNull();
    expect(h.reader.syncReadBlocked()).toBe(false);
    void h.reader.readAsync();
    expect(h.children).toHaveLength(2);
  });

  test("the deadline resolves null without killing, and unrefs the child", async () => {
    const h = harness();
    const read = h.reader.readAsync();
    expect(h.deadlines[0]!.ms).toBe(5_000);
    h.fireDeadline();
    expect(await read).toBeNull();
    const child = h.children[0]!;
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(child.stdout.unref).toHaveBeenCalledTimes(1);
  });

  test("concurrent reads share one child", async () => {
    const h = harness();
    const first = h.reader.readAsync();
    const second = h.reader.readAsync();
    expect(second).toBe(first);
    expect(h.children).toHaveLength(1);
    h.children[0]!.stdout.emit("data", "secret");
    h.children[0]!.emit("close", 0, null);
    expect(await Promise.all([first, second])).toEqual(["secret", "secret"]);
  });

  test("a timed-out child that is still blocked keeps every later read from spawning", async () => {
    const h = harness();
    const read = h.reader.readAsync();
    h.fireDeadline();
    await read;
    expect(h.reader.syncReadBlocked()).toBe(true);
    expect(await h.reader.readAsync()).toBeNull();
    // Past the backoff window, but the first child has still not exited.
    h.advance(60_001);
    expect(await h.reader.readAsync()).toBeNull();
    expect(h.reader.syncReadBlocked()).toBe(true);
    expect(h.children).toHaveLength(1);
  });

  test("after a timeout, reads back off until the window passes, then spawn again", async () => {
    const h = harness();
    const read = h.reader.readAsync();
    h.fireDeadline();
    await read;
    // The prompt is dismissed and the blocked child exits on its own.
    h.children[0]!.emit("close", 1, null);
    h.advance(59_999);
    expect(await h.reader.readAsync()).toBeNull();
    expect(h.reader.syncReadBlocked()).toBe(true);
    expect(h.children).toHaveLength(1);
    h.advance(2);
    expect(h.reader.syncReadBlocked()).toBe(false);
    void h.reader.readAsync();
    expect(h.children).toHaveLength(2);
  });

  test("stdout is decoded once, so a multi-byte character split across chunks survives", async () => {
    const h = harness();
    const read = h.reader.readAsync();
    const bytes = Buffer.from("{\"label\":\"caf\u00e9\"}");
    const split = bytes.indexOf(0xc3) + 1;
    h.children[0]!.stdout.emit("data", bytes.subarray(0, split));
    h.children[0]!.stdout.emit("data", bytes.subarray(split));
    h.children[0]!.emit("close", 0, null);
    expect(await read).toBe("{\"label\":\"caf\u00e9\"}");
  });

  test("an exit event alone does not settle the read before stdout closes", async () => {
    const h = harness();
    let settled = false;
    const read = h.reader.readAsync().then(value => { settled = true; return value; });
    h.children[0]!.emit("exit", 0, null);
    await Promise.resolve();
    expect(settled).toBe(false);
    h.children[0]!.stdout.emit("data", "tail");
    h.children[0]!.emit("close", 0, null);
    expect(await read).toBe("tail");
  });

  test("a late exit after the deadline does not resurrect the timed-out read", async () => {
    const h = harness();
    const read = h.reader.readAsync();
    h.fireDeadline();
    h.children[0]!.stdout.emit("data", "late");
    h.children[0]!.emit("close", 0, null);
    expect(await read).toBeNull();
  });

  test("a spawn error resolves null and releases the slot", async () => {
    const h = harness();
    const read = h.reader.readAsync();
    h.children[0]!.emit("error", new Error("ENOENT"));
    expect(await read).toBeNull();
    expect(h.reader.syncReadBlocked()).toBe(false);
  });

  test("a synchronous read returns trimmed stdout with the same deadline", () => {
    const h = harness();
    expect(h.reader.readSync()).toBe("sync-secret");
    expect(h.syncRuns).toEqual([5_000]);
  });

  test("a synchronous read does not run while an async child is still running", async () => {
    const h = harness();
    const read = h.reader.readAsync();
    expect(h.reader.readSync()).toBeNull();
    h.fireDeadline();
    await read;
    h.advance(60_001);
    // Backoff is over, but the timed-out child is still blocked on the prompt.
    expect(h.reader.readSync()).toBeNull();
    expect(h.syncRuns).toHaveLength(0);
    h.children[0]!.emit("close", 0, null);
    expect(h.reader.readSync()).toBe("sync-secret");
  });

  test("a synchronous timeout starts the backoff for both readers", async () => {
    const h = harness();
    h.setSyncResult(() => { throw Object.assign(new Error("t"), { code: "ETIMEDOUT", signal: "SIGTERM" }); });
    expect(h.reader.readSync()).toBeNull();
    h.setSyncResult(() => "sync-secret");
    expect(h.reader.readSync()).toBeNull();
    expect(await h.reader.readAsync()).toBeNull();
    expect(h.syncRuns).toHaveLength(1);
    expect(h.children).toHaveLength(0);
    h.advance(60_000);
    expect(h.reader.readSync()).toBe("sync-secret");
  });

  test("a synchronous nonzero exit (item not found) does not back off", () => {
    const h = harness();
    h.setSyncResult(() => { throw Object.assign(new Error("e"), { status: 44, signal: null }); });
    expect(h.reader.readSync()).toBeNull();
    expect(h.reader.syncReadBlocked()).toBe(false);
    h.setSyncResult(() => "sync-secret");
    expect(h.reader.readSync()).toBe("sync-secret");
  });

  test("a non-darwin host never runs the synchronous read", () => {
    const h = harness("linux");
    expect(h.reader.readSync()).toBeNull();
    expect(h.syncRuns).toHaveLength(0);
  });

  test("a late close from an errored child does not free its replacement's slot", async () => {
    const h = harness();
    const first = h.reader.readAsync();
    h.children[0]!.emit("error", new Error("spawn failure"));
    expect(await first).toBeNull();
    void h.reader.readAsync();
    expect(h.children).toHaveLength(2);
    h.children[0]!.emit("close", -2, null);
    expect(h.reader.syncReadBlocked()).toBe(true);
    expect(h.reader.readSync()).toBeNull();
    expect(h.syncRuns).toHaveLength(0);
  });

  test("isSyncTimeout distinguishes an execSync timeout from a nonzero exit", () => {
    expect(isSyncTimeout(Object.assign(new Error("t"), { code: "ETIMEDOUT", signal: "SIGTERM" }))).toBe(true);
    expect(isSyncTimeout(Object.assign(new Error("k"), { signal: "SIGKILL" }))).toBe(true);
    expect(isSyncTimeout(Object.assign(new Error("e"), { status: 44, signal: null }))).toBe(false);
    expect(isSyncTimeout(null)).toBe(false);
  });

  test("an error from a child that did start keeps its slot until that child closes", async () => {
    const h = harness();
    const first = h.reader.readAsync();
    // A started process: its error event does not mean it is gone, so no sibling may start.
    Object.assign(h.children[0]!, { pid: 4242 });
    h.children[0]!.emit("error", new Error("stdio failure"));
    expect(await first).toBeNull();
    expect(h.reader.syncReadBlocked()).toBe(true);
    expect(await h.reader.readAsync()).toBeNull();
    expect(h.reader.readSync()).toBeNull();
    expect(h.children).toHaveLength(1);
    expect(h.syncRuns).toHaveLength(0);
    h.children[0]!.emit("close", 1, null);
    expect(h.reader.syncReadBlocked()).toBe(false);
    void h.reader.readAsync();
    expect(h.children).toHaveLength(2);
  });

  test("another lookup's timeout starts the same backoff", async () => {
    const h = harness();
    h.reader.noteSyncTimeout();
    expect(h.reader.syncReadBlocked()).toBe(true);
    expect(await h.reader.readAsync()).toBeNull();
    expect(h.reader.readSync()).toBeNull();
    expect(h.children).toHaveLength(0);
    expect(h.syncRuns).toHaveLength(0);
    h.advance(60_001);
    expect(h.reader.syncReadBlocked()).toBe(false);
  });

  test("stdout past the 1 MiB cap is not a credential, even across chunks", async () => {
    const h = harness();
    const read = h.reader.readAsync();
    const chunk = Buffer.alloc(600 * 1024, 0x61);
    h.children[0]!.stdout.emit("data", chunk);
    h.children[0]!.stdout.emit("data", chunk);
    h.children[0]!.emit("close", 0, null);
    expect(await read).toBeNull();
  });
});

describe("Claude token detection reads the Keychain through the shared reader (#8161)", () => {
  const payload = JSON.stringify({ claudeAiOauth: { accessToken: "kc-access", refreshToken: "kc-refresh", expiresAt: 4_102_444_800_000 } });

  test("both detectors fall through to the shared reader when the profile has no file", async () => {
    process.env.CLAUDE_CONFIG_DIR = join(tmp, "no-file-profile");
    const sync = spyOn(claudeKeychainReader, "readSync").mockReturnValue(payload);
    const async = spyOn(claudeKeychainReader, "readAsync").mockResolvedValue(payload);
    try {
      expect(detectClaudeCodeToken()?.access).toBe("kc-access");
      expect((await detectClaudeCodeTokenAsync())?.access).toBe("kc-access");
      expect(sync).toHaveBeenCalledTimes(1);
      expect(async).toHaveBeenCalledTimes(1);
    } finally {
      sync.mockRestore();
      async.mockRestore();
    }
  });

  test("an empty Keychain value is no credential on either path", async () => {
    // Reader side: a whitespace-only secret is no credential, on both paths.
    const reader = createClaudeKeychainReader({
      platform: "darwin",
      spawn: () => {
        const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), pid: 7 });
        queueMicrotask(() => { child.stdout.emit("data", " \n"); child.emit("close", 0, null); });
        return child as never;
      },
      execSync: () => "  \n",
      now: () => 0,
      schedule: () => () => {},
    });
    expect(await reader.readAsync()).toBeNull();
    expect(reader.readSync()).toBeNull();
    // Detector side: the profile has no file, so both detectors consult the reader, and its null
    // (an empty value) leaves them with no credential instead of an empty one.
    process.env.CLAUDE_CONFIG_DIR = join(tmp, "empty-keychain-profile");
    const sync = spyOn(claudeKeychainReader, "readSync").mockReturnValue(null);
    const async = spyOn(claudeKeychainReader, "readAsync").mockResolvedValue(null);
    try {
      expect(detectClaudeCodeToken()).toBeNull();
      expect(await detectClaudeCodeTokenAsync()).toBeNull();
      expect(sync).toHaveBeenCalledTimes(1);
      expect(async).toHaveBeenCalledTimes(1);
    } finally {
      sync.mockRestore();
      async.mockRestore();
    }
  });

  test("a profile's credentials file wins without asking the Keychain", async () => {
    const dir = join(tmp, "file-first-profile");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".credentials.json"), payload.replace(/kc-/g, "file-"));
    process.env.CLAUDE_CONFIG_DIR = dir;
    const sync = spyOn(claudeKeychainReader, "readSync").mockReturnValue(payload);
    const async = spyOn(claudeKeychainReader, "readAsync").mockResolvedValue(payload);
    try {
      expect(detectClaudeCodeToken()?.access).toBe("file-access");
      expect((await detectClaudeCodeTokenAsync())?.access).toBe("file-access");
      expect(sync).not.toHaveBeenCalled();
      expect(async).not.toHaveBeenCalled();
    } finally {
      sync.mockRestore();
      async.mockRestore();
    }
  });
});
