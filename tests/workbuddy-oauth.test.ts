import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildWorkBuddyAuthHeaders,
  parseWorkBuddyAuthFile,
  readWorkBuddySessionSnapshot,
  resetWorkBuddyAuthCache,
  resolveWorkBuddyAuthFilePath,
} from "../src/oauth/workbuddy-credentials";
import {
  importLocalWorkBuddyAuth,
  loginWorkBuddy,
  refreshWorkBuddyToken,
  workBuddyNativeInputsForHome,
} from "../src/oauth/workbuddy";
import { OAUTH_PROVIDERS } from "../src/oauth/index";

const SAMPLE_SESSION = {
  auth: {
    accessToken: "access-token-123",
    refreshToken: "refresh-token-456",
    expiresAt: 4_102_444_800_000,
    domain: "personal.example.cn",
  },
  account: {
    uid: "user-uid-789",
    enterpriseId: "ent-001",
  },
};

function writeSessionFile(dir: string, payload: unknown = SAMPLE_SESSION): string {
  const authDir = join(dir, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth");
  mkdirSync(authDir, { recursive: true });
  const path = join(authDir, "workbuddy-desktop.info");
  writeFileSync(path, `${JSON.stringify(payload)}\n`, "utf8");
  return path;
}

describe("workbuddy auth file resolution", () => {
  test("darwin resolves Application Support path", () => {
    expect(resolveWorkBuddyAuthFilePath({
      env: {},
      platform: "darwin",
      home: "/Users/x",
    })).toBe("/Users/x/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info");
  });

  test("win32 resolves APPDATA CodeBuddyExtension path", () => {
    expect(resolveWorkBuddyAuthFilePath({
      env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" },
      platform: "win32",
      home: "C:\\Users\\u",
    })).toBe("C:\\Users\\u\\AppData\\Roaming\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop.info");
  });

  test("WORKBUDDY_AUTH_FILE override wins", () => {
    expect(resolveWorkBuddyAuthFilePath({
      env: { WORKBUDDY_AUTH_FILE: "/tmp/custom.info" },
      platform: "linux",
      home: "/home/u",
    })).toBe("/tmp/custom.info");
  });
});

describe("workbuddy auth parsing", () => {
  test("parseWorkBuddyAuthFile normalizes session fields", () => {
    const snapshot = parseWorkBuddyAuthFile(JSON.stringify(SAMPLE_SESSION));
    expect(snapshot).toEqual({
      accessToken: "access-token-123",
      refreshToken: "refresh-token-456",
      expires: 4_102_444_800_000,
      uid: "user-uid-789",
      domain: "personal.example.cn",
      enterpriseId: "ent-001",
    });
  });

  test("buildWorkBuddyAuthHeaders includes enterprise tenant headers", () => {
    const snapshot = parseWorkBuddyAuthFile(JSON.stringify(SAMPLE_SESSION))!;
    expect(buildWorkBuddyAuthHeaders(snapshot)).toEqual({
      Authorization: "Bearer access-token-123",
      "X-User-Id": "user-uid-789",
      "Content-Type": "application/json",
      "X-Domain": "personal.example.cn",
      "X-Enterprise-Id": "ent-001",
      "X-Tenant-Id": "ent-001",
    });
  });

  test("parseWorkBuddyAuthFile rejects malformed expiresAt values", () => {
    const withoutExpires = {
      ...SAMPLE_SESSION,
      auth: {
        accessToken: SAMPLE_SESSION.auth.accessToken,
        refreshToken: SAMPLE_SESSION.auth.refreshToken,
        domain: SAMPLE_SESSION.auth.domain,
      },
    };
    expect(parseWorkBuddyAuthFile(JSON.stringify(withoutExpires))).toBeNull();
    expect(parseWorkBuddyAuthFile(JSON.stringify({
      ...SAMPLE_SESSION,
      auth: { ...SAMPLE_SESSION.auth, expiresAt: "not-a-number" },
    }))).toBeNull();
    expect(parseWorkBuddyAuthFile(JSON.stringify({
      ...SAMPLE_SESSION,
      auth: { ...SAMPLE_SESSION.auth, expiresAt: 0 },
    }))).toBeNull();
    expect(parseWorkBuddyAuthFile(JSON.stringify({
      ...SAMPLE_SESSION,
      auth: { ...SAMPLE_SESSION.auth, expiresAt: Number.POSITIVE_INFINITY },
    }))).toBeNull();
  });
});

describe("workbuddy oauth login", () => {
  let tempHome = "";

  beforeEach(() => {
    resetWorkBuddyAuthCache();
    tempHome = mkdtempSync(join(tmpdir(), "workbuddy-oauth-"));
    process.env.WORKBUDDY_AUTH_FILE = writeSessionFile(tempHome);
  });

  afterEach(() => {
    delete process.env.WORKBUDDY_AUTH_FILE;
    resetWorkBuddyAuthCache();
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("importLocalWorkBuddyAuth reads desktop session", () => {
    const cred = importLocalWorkBuddyAuth(workBuddyNativeInputsForHome(tempHome, "darwin"));
    expect(cred?.access).toBe("access-token-123");
    expect(cred?.refresh).toBe("refresh-token-456");
    expect(cred?.accountId).toBe("user-uid-789");
    expect(cred?.source).toBe("local-cli");
    expect(cred?.workbuddy).toEqual({
      domain: "personal.example.cn",
      enterpriseId: "ent-001",
    });
  });

  test("loginWorkBuddy imports local session", async () => {
    const messages: string[] = [];
    const cred = await loginWorkBuddy({
      onProgress: message => messages.push(message),
    });
    expect(cred.access).toBe("access-token-123");
    expect(messages).toContain("Imported WorkBuddy desktop session.");
  });

  test("registered forceLogin still imports the desktop session", async () => {
    const cred = await OAUTH_PROVIDERS.workbuddy!.login({}, { forceLogin: true });
    expect(cred.access).toBe("access-token-123");
    expect(cred.accountId).toBe("user-uid-789");
  });

  test("refreshWorkBuddyToken re-reads the desktop session", async () => {
    const initial = await loginWorkBuddy({});
    const refreshed = await refreshWorkBuddyToken(initial.refresh, undefined, initial);
    expect(refreshed.access).toBe("access-token-123");
    expect(refreshed.accountId).toBe("user-uid-789");
  });

  test("refresh rejects a mismatched desktop account", async () => {
    const initial = await loginWorkBuddy({});
    writeFileSync(process.env.WORKBUDDY_AUTH_FILE!, JSON.stringify({
      ...SAMPLE_SESSION,
      account: { uid: "other-user" },
    }), "utf8");
    resetWorkBuddyAuthCache();
    await expect(refreshWorkBuddyToken(initial.refresh, undefined, initial)).rejects.toThrow(/different account/);
  });

  test("readWorkBuddySessionSnapshot returns null for invalid JSON", () => {
    writeFileSync(process.env.WORKBUDDY_AUTH_FILE!, "{not-json", "utf8");
    expect(readWorkBuddySessionSnapshot(workBuddyNativeInputsForHome(tempHome, "darwin"))).toBeNull();
  });
});
