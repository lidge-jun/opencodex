import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  CLOUDFLARE_TUNNEL_TOKEN_FILENAME,
  cloudflareTunnelStartOverrides,
  replaceStoredCloudflareTunnelToken,
  resolveCloudflareTunnelSetup,
  storedCloudflareTunnelTokenPath,
} from "../src/server/cloudflare-setup";

const runnerToken = `eyJ${"a".repeat(64)}`;
let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "opencodex-cloudflare-setup-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(testDir, { recursive: true, force: true });
});

describe("Cloudflare Tunnel setup resolution", () => {
  test("defaults to an unconfigured Named Tunnel with SSE and fails closed", () => {
    const setup = resolveCloudflareTunnelSetup({}, { env: {}, configDir: testDir });

    expect(setup).toEqual({
      mode: "named",
      configured: false,
      source: "none",
      publicUrl: null,
      supportsSse: true,
    });
    expect(cloudflareTunnelStartOverrides(setup)).toEqual({ mode: "named" });
  });

  test("accepts a complete environment-managed Named Tunnel", () => {
    const fromToken = resolveCloudflareTunnelSetup({}, {
      env: {
        OPENCODEX_CLOUDFLARE_TUNNEL_TOKEN: runnerToken,
        OPENCODEX_CLOUDFLARE_PUBLIC_URL: "https://api.example.com/",
      },
      configDir: testDir,
    });
    expect(fromToken).toEqual({
      mode: "named",
      configured: true,
      source: "environment",
      publicUrl: "https://api.example.com",
      supportsSse: true,
    });

    const tokenFile = join(testDir, "environment-token");
    writeFileSync(tokenFile, `${runnerToken}\n`, { mode: 0o600 });
    const fromFile = resolveCloudflareTunnelSetup({}, {
      env: {
        OPENCODEX_CLOUDFLARE_TUNNEL_TOKEN_FILE: tokenFile,
        OPENCODEX_CLOUDFLARE_PUBLIC_URL: "https://api.example.com",
      },
      configDir: testDir,
    });
    expect(fromFile).toMatchObject({
      mode: "named",
      configured: true,
      source: "environment",
      supportsSse: true,
    });
  });

  test("rejects partial or ambiguous environment configuration", () => {
    for (const env of [
      { OPENCODEX_CLOUDFLARE_PUBLIC_URL: "https://api.example.com" },
      { OPENCODEX_CLOUDFLARE_TUNNEL_TOKEN: runnerToken },
      {
        OPENCODEX_CLOUDFLARE_TUNNEL_TOKEN: runnerToken,
        OPENCODEX_CLOUDFLARE_TUNNEL_TOKEN_FILE: join(testDir, "other-token"),
        OPENCODEX_CLOUDFLARE_PUBLIC_URL: "https://api.example.com",
      },
      {
        OPENCODEX_CLOUDFLARE_TUNNEL_TOKEN_FILE: join(testDir, "missing-token"),
        OPENCODEX_CLOUDFLARE_PUBLIC_URL: "https://api.example.com",
      },
    ]) {
      expect(resolveCloudflareTunnelSetup({}, { env, configDir: testDir })).toMatchObject({
        mode: "named",
        configured: false,
        source: "environment",
        supportsSse: true,
        error: "environment_incomplete",
      });
    }
  });

  test("stores the runner token only in the fixed 0600 file and verifies its fingerprint", () => {
    const change = replaceStoredCloudflareTunnelToken(
      `cloudflared tunnel run --token ${runnerToken}`,
      testDir,
    );
    const expectedPath = join(testDir, CLOUDFLARE_TUNNEL_TOKEN_FILENAME);
    const fingerprint = createHash("sha256").update(runnerToken, "utf8").digest("hex");

    expect(change.path).toBe(expectedPath);
    expect(storedCloudflareTunnelTokenPath(testDir)).toBe(expectedPath);
    expect(basename(change.path)).toBe(CLOUDFLARE_TUNNEL_TOKEN_FILENAME);
    expect(change.fingerprint).toBe(fingerprint);
    expect(readFileSync(change.path, "utf8")).toBe(`${runnerToken}\n`);
    if (process.platform !== "win32") expect(statSync(change.path).mode & 0o777).toBe(0o600);

    const setup = resolveCloudflareTunnelSetup({
      cloudflareTunnel: {
        mode: "named",
        publicUrl: "https://api.example.com",
        tokenFingerprint: fingerprint,
      },
    }, { env: {}, configDir: testDir });
    expect(setup).toEqual({
      mode: "named",
      configured: true,
      source: "local",
      publicUrl: "https://api.example.com",
      supportsSse: true,
      tokenFile: expectedPath,
    });
    expect(cloudflareTunnelStartOverrides(setup)).toEqual({
      mode: "named",
      namedTunnel: { publicUrl: "https://api.example.com", tokenFile: expectedPath },
    });
  });

  test("fails closed when the local token is missing or its fingerprint changes", () => {
    const expectedFingerprint = createHash("sha256").update(runnerToken, "utf8").digest("hex");
    const configured = {
      cloudflareTunnel: {
        mode: "named" as const,
        publicUrl: "https://api.example.com",
        tokenFingerprint: expectedFingerprint,
      },
    };

    expect(resolveCloudflareTunnelSetup(configured, { env: {}, configDir: testDir }))
      .toMatchObject({ configured: false, error: "token_missing", supportsSse: true });

    const tokenPath = storedCloudflareTunnelTokenPath(testDir);
    writeFileSync(tokenPath, `eyJ${"b".repeat(64)}\n`, { mode: 0o600 });
    expect(resolveCloudflareTunnelSetup(configured, { env: {}, configDir: testDir }))
      .toMatchObject({ configured: false, error: "token_mismatch", supportsSse: true });
  });

  test("can explicitly opt into the development-only Quick Tunnel mode", () => {
    const setup = resolveCloudflareTunnelSetup(
      { cloudflareTunnel: { mode: "quick" } },
      { env: {}, configDir: testDir },
    );
    expect(setup).toEqual({
      mode: "quick",
      configured: true,
      source: "quick",
      publicUrl: null,
      supportsSse: false,
    });
  });

  test("rolls a new runner-token file back without leaving credentials behind", () => {
    const change = replaceStoredCloudflareTunnelToken(runnerToken, testDir);
    expect(existsSync(change.path)).toBe(true);

    change.rollback();

    expect(existsSync(change.path)).toBe(false);
  });
});
