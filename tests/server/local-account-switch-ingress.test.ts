// Moved out of server-management-auth.test.ts, which sits at the 2000-line ratchet threshold.
// Proves the account-switch capability survives the real server ingress and reaches the handler.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flushNativeMainStartupReleases } from "../../src/codex/native-profile-startup";
import { resetContextRelayActivationForTests } from "../../src/codex/context-compat";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import {
  accountSwitchBodyDigest,
  createLocalAccountSwitchCapability,
  LOCAL_ACCOUNT_SWITCH_BODY_HEADER,
} from "../../src/lib/local-account-switch-capability";
import {
  LOCAL_MANAGEMENT_CAPABILITY_EXPIRES_AT_HEADER,
  LOCAL_MANAGEMENT_CAPABILITY_HEADER,
  LOCAL_MANAGEMENT_EXPECTED_PID_HEADER,
  LOCAL_MANAGEMENT_NONCE_HEADER,
} from "../../src/lib/local-management-capability";
import { flushWindowsSecretAclReapsBeforeRemoval, resetHardenedStateForTests } from "../../src/lib/windows-secret-acl";
import { startServer } from "../../src/server";

const previous = {
  home: process.env.OPENCODEX_HOME,
  codexHome: process.env.CODEX_HOME,
  dataToken: process.env.OPENCODEX_API_AUTH_TOKEN,
  adminToken: process.env.OPENCODEX_ADMIN_AUTH_TOKEN,
};
let testHome = "";

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-account-switch-ingress-"));
  process.env.OPENCODEX_HOME = testHome;
  process.env.CODEX_HOME = testHome;
  resetContextRelayActivationForTests();
  process.env.OPENCODEX_API_AUTH_TOKEN = "data-secret";
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "admin-secret";
});

afterEach(async () => {
  await flushNativeMainStartupReleases();
  await flushConfigDirHardeningForTests();
  await flushWindowsSecretAclReapsBeforeRemoval(testHome);
  resetContextRelayActivationForTests();
  resetHardenedStateForTests();
  restore("CODEX_HOME", previous.codexHome);
  restore("OPENCODEX_HOME", previous.home);
  restore("OPENCODEX_API_AUTH_TOKEN", previous.dataToken);
  restore("OPENCODEX_ADMIN_AUTH_TOKEN", previous.adminToken);
  if (testHome) rmSync(testHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  testHome = "";
});

test("local account switch reaches the real management handler", async () => {
  const secret = "B".repeat(43);
  const server = startServer(0, {
    localAttestationSecret: secret,
    managementAuthState: { available: false, reason: "test unavailable state" },
  });
  const path = "/api/oauth/accounts/active";
  const body = JSON.stringify({ provider: "nonexistent", accountId: "missing" });
  const digest = accountSwitchBodyDigest(new TextEncoder().encode(body));
  const nonce = "A".repeat(43);
  const expiry = Date.now() + 10_000;
  try {
    const response = await fetch(new URL(path, server.url), {
      method: "PUT", body,
      headers: {
        "content-type": "application/json",
        [LOCAL_MANAGEMENT_EXPECTED_PID_HEADER]: String(process.pid),
        [LOCAL_MANAGEMENT_NONCE_HEADER]: nonce,
        [LOCAL_MANAGEMENT_CAPABILITY_EXPIRES_AT_HEADER]: String(expiry),
        [LOCAL_ACCOUNT_SWITCH_BODY_HEADER]: digest,
        [LOCAL_MANAGEMENT_CAPABILITY_HEADER]: createLocalAccountSwitchCapability(
          secret, nonce, "PUT", path, process.pid, server.port, expiry, digest,
        )!,
      },
    });
    expect([401, 403, 503]).not.toContain(response.status);
    expect(response.status).toBe(400);
    expect((await response.json() as { error?: string }).error).toBe("unknown oauth provider");
  } finally {
    await server.stop(true);
  }
});

