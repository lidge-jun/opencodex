import { afterEach, beforeAll, afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectClaudeCodeTokenAsync,
  detectGrokCliToken,
  hasClaudeCredentialContinuity,
  parseClaudeOauthPayload,
  readClaudeCredentialsFile,
  shouldAdoptGrokGeneration,
} from "../../src/oauth/local-token-detect";
import { claudeKeychainReader } from "../../src/oauth/claude-keychain-read";
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

describe("Claude token detection reads the Keychain through the shared reader (#8161)", () => {
  const payload = JSON.stringify({ claudeAiOauth: { accessToken: "kc-access", refreshToken: "kc-refresh", expiresAt: 4_102_444_800_000 } });

  test("the detector falls through to the shared reader when the profile has no file", async () => {
    process.env.CLAUDE_CONFIG_DIR = join(tmp, "no-file-profile");
    const read = spyOn(claudeKeychainReader, "readAsync").mockResolvedValue(payload);
    try {
      expect((await detectClaudeCodeTokenAsync())?.access).toBe("kc-access");
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      read.mockRestore();
    }
  });

  test("an empty Keychain value is no credential", async () => {
    // The profile has no file, so the detector consults the reader, and its null (an empty
    // value) leaves it with no credential instead of an empty one.
    process.env.CLAUDE_CONFIG_DIR = join(tmp, "empty-keychain-profile");
    const read = spyOn(claudeKeychainReader, "readAsync").mockResolvedValue(null);
    try {
      expect(await detectClaudeCodeTokenAsync()).toBeNull();
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      read.mockRestore();
    }
  });

  test("a profile's credentials file wins without asking the Keychain", async () => {
    const dir = join(tmp, "file-first-profile");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".credentials.json"), payload.replace(/kc-/g, "file-"));
    process.env.CLAUDE_CONFIG_DIR = dir;
    const read = spyOn(claudeKeychainReader, "readAsync").mockResolvedValue(payload);
    try {
      expect((await detectClaudeCodeTokenAsync())?.access).toBe("file-access");
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  test("there is no synchronous Claude Code token detector", async () => {
    expect(Object.keys(await import("../../src/oauth/local-token-detect"))).not.toContain("detectClaudeCodeToken");
  });
});
