import { afterEach, beforeAll, afterAll, describe, expect, spyOn, test } from "bun:test";
import { claudeKeychain } from "../../src/lib/claude-keychain";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectGrokCliToken,
  hasClaudeCredentialContinuity,
  observeClaudeCodeToken,
  parseClaudeOauthPayload,
  readClaudeCredentialsFile,
  shouldAdoptGrokGeneration,
} from "../../src/oauth/local-token-detect";
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
  test.each(["missing", "invalid"])("a preferred file becoming valid during a Keychain read cannot be shadowed (%s)", async initial => {
    const dir = join(tmp, `profile-changes-during-read-${initial}`);
    mkdirSync(dir, { recursive: true });
    if (initial === "invalid") writeFileSync(join(dir, ".credentials.json"), "{}");
    process.env.CLAUDE_CONFIG_DIR = dir;
    let release!: (value: { status: "present"; value: string }) => void;
    const blocked = new Promise<{ status: "present"; value: string }>(resolve => { release = resolve; });
    const read = spyOn(claudeKeychain, "read").mockReturnValue(blocked);
    try {
      const observation = observeClaudeCodeToken();
      expect(read).toHaveBeenCalledTimes(1);
      writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
        accessToken: "synthetic-new", refreshToken: "synthetic-new-refresh", expiresAt: 1234,
      } }));
      release({ status: "present", value: JSON.stringify({ claudeAiOauth: {
        accessToken: "synthetic-old", refreshToken: "synthetic-old-refresh", expiresAt: 1234,
      } }) });
      expect(await observation).toEqual({ kind: "unavailable" });
    } finally { read.mockRestore(); }
  });

  test("an explicit profile with a usable credential takes precedence over Keychain", async () => {
    const dir = join(tmp, "claude-priority");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
      accessToken: "synthetic-file", refreshToken: "synthetic-refresh", expiresAt: 1234,
    } }));
    process.env.CLAUDE_CONFIG_DIR = dir;
    const read = spyOn(claudeKeychain, "read").mockResolvedValue({ status: "unavailable" });
    try {
      expect(await observeClaudeCodeToken()).toMatchObject({ kind: "present", credential: { access: "synthetic-file" } });
      expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
  });

  test("unavailable Keychain with no usable profile remains unavailable", async () => {
    process.env.CLAUDE_CONFIG_DIR = join(tmp, "claude-unavailable");
    const read = spyOn(claudeKeychain, "read").mockResolvedValue({ status: "unavailable" });
    try { expect(await observeClaudeCodeToken()).toEqual({ kind: "unavailable" }); }
    finally { read.mockRestore(); }
  });

  test("a default-profile file cannot override an unavailable higher-priority Keychain", async () => {
    const dir = mkdtempSync(join(tmp, "default-profile-"));
    const previousProfile = process.env.USERPROFILE;
    const previousHome = process.env.HOME;
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: {
      accessToken: "synthetic-file", refreshToken: "synthetic-refresh", expiresAt: 1234,
    } }));
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    delete process.env.CLAUDE_CONFIG_DIR;
    const read = spyOn(claudeKeychain, "read").mockResolvedValue({ status: "unavailable" });
    try { expect(await observeClaudeCodeToken()).toEqual({ kind: "unavailable" }); }
    finally {
      read.mockRestore();
      if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    }
  });

  test.each(["", "{broken", "{}"])("an unusable explicit profile is not fallback evidence when Keychain is unavailable (%s)", async raw => {
    const dir = join(tmp, `claude-unusable-${raw.length}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".credentials.json"), raw);
    process.env.CLAUDE_CONFIG_DIR = dir;
    const read = spyOn(claudeKeychain, "read").mockResolvedValue({ status: "unavailable" });
    try {
      expect(await observeClaudeCodeToken()).toEqual({ kind: "unavailable" });
      expect(read).toHaveBeenCalledTimes(1);
    } finally { read.mockRestore(); }
  });

  test("authoritative Keychain absence remains absent", async () => {
    process.env.CLAUDE_CONFIG_DIR = join(tmp, "claude-absent");
    const read = spyOn(claudeKeychain, "read").mockResolvedValue({ status: "absent" });
    try { expect(await observeClaudeCodeToken()).toEqual({ kind: "absent" }); }
    finally { read.mockRestore(); }
  });

  test("an unreadable explicit credentials file is unavailable rather than absent", async () => {
    const dir = join(tmp, "claude-unreadable");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, ".credentials.json");
    writeFileSync(path, "{}");
    process.env.CLAUDE_CONFIG_DIR = dir;
    const originalRead = fs.readFileSync;
    const file = spyOn(fs, "readFileSync").mockImplementation(((target: unknown, ...args: unknown[]) => {
      if (target === path) throw Object.assign(new Error("synthetic access denied"), { code: "EACCES" });
      return originalRead(target as never, ...args as []);
    }) as typeof fs.readFileSync);
    const keychain = spyOn(claudeKeychain, "read").mockResolvedValue({ status: "absent" });
    try { expect(await observeClaudeCodeToken()).toEqual({ kind: "unavailable" }); }
    finally { file.mockRestore(); keychain.mockRestore(); }
  });
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
