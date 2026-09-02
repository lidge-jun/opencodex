import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SERVER_BUDGET_MS } from "./helpers/test-budget";
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { findAvailablePort } from "../src/server/ports";
import type { OcxConfig } from "../src/types";
import { serveGuiFile, serveSessionBootstrap } from "../src/server/gui-static";
import { isProxyAdmissionSecret } from "../src/server/auth-cors";
import {
  initializeManagementAuthState,
  issueGuiSession,
  managementPrincipal,
  removeManagementTokenPathBestEffort,
  requireManagementAuth,
} from "../src/server/management-auth";
import {
  hardenSecretPath,
  hardenedSecretPathCountForTests,
  resetHardenedStateForTests,
  setIcaclsRunnerForTests,
  setPlatformForTests,
  timedOutSecretPathCountForTests,
  hardenSecretDir,
} from "../src/lib/windows-secret-acl";
import {
  LOCAL_ATTESTATION_CHALLENGE_HEADER,
  LOCAL_ATTESTATION_PROOF_HEADER,
  verifyLocalAttestationProof,
} from "../src/lib/local-management-attestation";
import {
  LOCAL_MANAGEMENT_CAPABILITY_HEADER,
  LOCAL_MANAGEMENT_CAPABILITY_EXPIRES_AT_HEADER,
  LOCAL_MANAGEMENT_CAPABILITY_TTL_MS,
  LOCAL_MANAGEMENT_EXPECTED_PID_HEADER,
  LOCAL_MANAGEMENT_NONCE_HEADER,
  LOCAL_MANAGEMENT_READ_PATHS,
  createLocalManagementReadCapability,
} from "../src/lib/local-management-capability";
import {
  CODEX_APP_SERVER_STATE_PATH,
  CODEX_RESTART_PATH,
} from "../src/lib/codex-restart-contract";
import {
  SYSTEM_RESTART_CAPABILITY_HEADER,
  SYSTEM_RESTART_EXPECTED_PID_HEADER,
  SYSTEM_RESTART_METHOD,
  SYSTEM_RESTART_NONCE_HEADER,
  SYSTEM_RESTART_PATH,
  createSystemRestartCapability,
} from "../src/lib/system-restart-contract";
import {
  LOCAL_PROVIDER_RELOAD_CAPABILITY_HEADER,
  LOCAL_PROVIDER_RELOAD_CAPABILITY_TTL_MS,
  LOCAL_PROVIDER_RELOAD_EXPECTED_PID_HEADER,
  LOCAL_PROVIDER_RELOAD_EXPIRES_AT_HEADER,
  LOCAL_PROVIDER_RELOAD_METHOD,
  LOCAL_PROVIDER_RELOAD_NAME_HEADER,
  LOCAL_PROVIDER_RELOAD_NONCE_HEADER,
  LOCAL_PROVIDER_RELOAD_PATH,
  createLocalProviderReloadCapability,
  verifyLocalProviderReloadCapability,
} from "../src/lib/local-provider-reload-contract";
import {
  GUI_PAIR_BROWSER_ORIGIN_HEADER,
  GUI_PAIR_CAPABILITY_HEADER,
  GUI_PAIR_CAPABILITY_TTL_MS,
  GUI_PAIR_EXPECTED_PID_HEADER,
  GUI_PAIR_EXPIRES_AT_HEADER,
  GUI_PAIR_METHOD,
  GUI_PAIR_NONCE_HEADER,
  GUI_PAIR_PATH,
  createGuiPairCapability,
} from "../src/lib/gui-pair-capability";
import {
  GUI_PAIRING_GRANT_TTL_MS,
  LOOPBACK_GUI_SESSION_TTL_MS,
  REMOTE_GUI_SESSION_TTL_MS,
  authorizeGuiSessionRequest,
  consumeGuiPairingGrant,
  createGuiPairingGrant,
} from "../src/server/gui-session";
import { setSystemRestartIoForTests } from "../src/server/management/system-restart";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const previousHome = process.env.OPENCODEX_HOME;
const previousDataToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousAdminToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
let testHome = "";

function remoteConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "0.0.0.0",
    defaultProvider: "test",
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
        disabled: true,
        models: ["gpt-test"],
      },
    },
  };
}

function hubConfig(publicOrigin = "https://hub.example.test"): OcxConfig {
  return {
    ...remoteConfig(),
    runtimeRole: "hub",
    hub: { managementPublicOrigin: publicOrigin },
    remoteGui: { allowedTailscaleUsers: ["alice@example.test"] },
    corsAllowOrigins: ["https://dashboard.example.test"],
  };
}

function websocketHandshakeOpens(url: URL, token: string): Promise<boolean> {
  return new Promise(resolve => {
    const target = new URL("/v1/responses", url);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(target, {
      headers: { "X-OpenCodex-API-Key": token },
    } as unknown as string[]);
    let settled = false;
    const finish = (opened: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      resolve(opened);
    };
    socket.addEventListener("open", () => finish(true));
    socket.addEventListener("error", () => finish(false));
    socket.addEventListener("close", () => finish(false));
    const timer = setTimeout(() => finish(false), 5_000);
  });
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-management-auth-"));
  process.env.OPENCODEX_HOME = testHome;
  process.env.OPENCODEX_API_AUTH_TOKEN = "data-secret";
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "admin-secret";
});

afterEach(() => {
  setSystemRestartIoForTests();
  setIcaclsRunnerForTests(null);
  setPlatformForTests(null);
  resetHardenedStateForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousDataToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousDataToken;
  if (previousAdminToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdminToken;
  if (testHome) removeTreeWithRetry(testHome);
  testHome = "";
});

describe("management and data-plane credential separation", () => {
  test("healthz proves the listener owns the protected runtime secret", async () => {
    const secret = "A".repeat(43);
    const challenge = "B".repeat(43);
    const server = startServer(0, { localAttestationSecret: secret });
    try {
      const health = await fetch(new URL("/healthz", server.url), {
        headers: { [LOCAL_ATTESTATION_CHALLENGE_HEADER]: challenge },
      });
      const proof = health.headers.get(LOCAL_ATTESTATION_PROOF_HEADER);
      expect(verifyLocalAttestationProof(secret, challenge, process.pid, server.port, proof)).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("a process-scoped capability authorizes only the exact restart operation", async () => {
    const secret = "A".repeat(43);
    const nonce = "B".repeat(43);
    let scheduled = 0;
    // The capability contract is platform-independent. Avoid making this HTTP
    // integration assertion depend on the host's live icacls policy; dedicated
    // Windows ACL tests cover that boundary separately.
    setPlatformForTests("linux");
    setSystemRestartIoForTests({
      isDraining: () => false,
      schedule: () => { scheduled += 1; },
      setDraining: () => {},
    });
    const unavailable = { available: false, reason: "injected unavailable state" } as const;
    const server = startServer(0, {
      localAttestationSecret: secret,
      managementAuthState: unavailable,
    });
    try {
      const capability = createSystemRestartCapability(
        secret,
        nonce,
        SYSTEM_RESTART_METHOD,
        SYSTEM_RESTART_PATH,
        process.pid,
        server.port,
      );
      const headers = {
        [SYSTEM_RESTART_EXPECTED_PID_HEADER]: String(process.pid),
        [SYSTEM_RESTART_NONCE_HEADER]: nonce,
        [SYSTEM_RESTART_CAPABILITY_HEADER]: capability!,
      };

      const restart = await fetch(new URL(SYSTEM_RESTART_PATH, server.url), {
        method: SYSTEM_RESTART_METHOD,
        headers,
      });
      expect(restart.status).toBe(202);
      expect(scheduled).toBe(1);

      const foreignRoute = await fetch(new URL("/api/config", server.url), {
        method: "POST",
        headers,
      });
      expect(foreignRoute.status).toBe(503);

      const tampered = await fetch(new URL(SYSTEM_RESTART_PATH, server.url), {
        method: SYSTEM_RESTART_METHOD,
        headers: { ...headers, [SYSTEM_RESTART_CAPABILITY_HEADER]: "C".repeat(43) },
      });
      expect(tampered.status).toBe(503);

      const wrongMethod = await fetch(new URL(SYSTEM_RESTART_PATH, server.url), {
        method: "DELETE",
        headers,
      });
      expect(wrongMethod.status).toBe(503);

      const wrongPortCapability = createSystemRestartCapability(
        secret,
        nonce,
        SYSTEM_RESTART_METHOD,
        SYSTEM_RESTART_PATH,
        process.pid,
        server.port + 1,
      );
      const wrongPort = await fetch(new URL(SYSTEM_RESTART_PATH, server.url), {
        method: SYSTEM_RESTART_METHOD,
        headers: {
          ...headers,
          [SYSTEM_RESTART_CAPABILITY_HEADER]: wrongPortCapability!,
        },
      });
      expect(wrongPort.status).toBe(503);
      expect(scheduled).toBe(1);

      const request = new Request(new URL(SYSTEM_RESTART_PATH, server.url), {
        method: SYSTEM_RESTART_METHOD,
        headers,
      });
      const local = { attestationSecret: secret, pid: process.pid, port: server.port };
      expect(requireManagementAuth(request, unavailable, remoteConfig(), local)).toBeNull();
      expect(managementPrincipal(request, unavailable, remoteConfig(), local))
        .toBe("system-restart-capability");
    } finally {
      await server.stop(true);
    }
  });

  test("a local-read capability authorizes only its exact GET path", async () => {
    const secret = "A".repeat(43);
    const nonce = "B".repeat(43);
    const unavailable = { available: false, reason: "injected unavailable state" } as const;
    const server = startServer(0, {
      localAttestationSecret: secret,
      managementAuthState: unavailable,
    });
    const headersFor = (path: string, port = server.port, requestNonce = nonce) => {
      const expiresAt = Date.now() + LOCAL_MANAGEMENT_CAPABILITY_TTL_MS;
      return {
        [LOCAL_MANAGEMENT_EXPECTED_PID_HEADER]: String(process.pid),
        [LOCAL_MANAGEMENT_NONCE_HEADER]: requestNonce,
        [LOCAL_MANAGEMENT_CAPABILITY_EXPIRES_AT_HEADER]: String(expiresAt),
        [LOCAL_MANAGEMENT_CAPABILITY_HEADER]: createLocalManagementReadCapability(
          secret,
          requestNonce,
          "GET",
          path,
          process.pid,
          port,
          expiresAt,
        )!,
      };
    };
    try {
      const memoryHeaders = headersFor(LOCAL_MANAGEMENT_READ_PATHS.systemMemory);
      const memory = await fetch(new URL(LOCAL_MANAGEMENT_READ_PATHS.systemMemory, server.url), {
        headers: memoryHeaders,
      });
      expect(memory.status).toBe(200);
      const memoryBody = await memory.json() as { pid?: number; bunVersion?: string };
      expect(memoryBody.pid).toBe(process.pid);
      expect(memoryBody.bunVersion).toBe(Bun.version);

      const replay = await fetch(new URL(LOCAL_MANAGEMENT_READ_PATHS.systemMemory, server.url), {
        headers: memoryHeaders,
      });
      expect(replay.status).toBe(503);

      const memoryCapabilityOnAccounts = await fetch(
        new URL(LOCAL_MANAGEMENT_READ_PATHS.codexAccounts, server.url),
        {
          headers: headersFor(
            LOCAL_MANAGEMENT_READ_PATHS.systemMemory,
            server.port,
            "C".repeat(43),
          ),
        },
      );
      expect(memoryCapabilityOnAccounts.status).toBe(503);

      const accountHeaders = headersFor(LOCAL_MANAGEMENT_READ_PATHS.codexAccounts);
      const accounts = await fetch(new URL(LOCAL_MANAGEMENT_READ_PATHS.codexAccounts, server.url), {
        headers: accountHeaders,
      });
      expect(accounts.status).toBe(200);

      const query = await fetch(
        new URL(`${LOCAL_MANAGEMENT_READ_PATHS.codexAccounts}?include=all`, server.url),
        {
          headers: headersFor(
            LOCAL_MANAGEMENT_READ_PATHS.codexAccounts,
            server.port,
            "E".repeat(43),
          ),
        },
      );
      expect(query.status).toBe(503);

      const mutation = await fetch(new URL(LOCAL_MANAGEMENT_READ_PATHS.codexAccounts, server.url), {
        method: "POST",
        headers: {
          ...headersFor(
            LOCAL_MANAGEMENT_READ_PATHS.codexAccounts,
            server.port,
            "F".repeat(43),
          ),
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(mutation.status).toBe(503);

      const foreignRoute = await fetch(new URL("/api/config", server.url), {
        headers: headersFor(
          LOCAL_MANAGEMENT_READ_PATHS.codexAccounts,
          server.port,
          "G".repeat(43),
        ),
      });
      expect(foreignRoute.status).toBe(503);

      const wrongPort = await fetch(new URL(LOCAL_MANAGEMENT_READ_PATHS.systemMemory, server.url), {
        headers: headersFor(
          LOCAL_MANAGEMENT_READ_PATHS.systemMemory,
          server.port + 1,
          "H".repeat(43),
        ),
      });
      expect(wrongPort.status).toBe(503);

      const principalHeaders = headersFor(
        LOCAL_MANAGEMENT_READ_PATHS.systemMemory,
        server.port,
        "I".repeat(43),
      );
      const request = new Request(new URL(LOCAL_MANAGEMENT_READ_PATHS.systemMemory, server.url), {
        headers: principalHeaders,
      });
      const local = { attestationSecret: secret, pid: process.pid, port: server.port };
      expect(requireManagementAuth(request, unavailable, remoteConfig(), local)).toBeNull();
      expect(managementPrincipal(request, unavailable, remoteConfig(), local))
        .toBe("local-read-capability");
    } finally {
      await server.stop(true);
    }
  });

  test("a provider-reload capability is one-shot and exact to its operation", () => {
    const secret = "A".repeat(43);
    const nonce = "J".repeat(43);
    const expiresAt = Date.now() + LOCAL_PROVIDER_RELOAD_CAPABILITY_TTL_MS;
    const unavailable = { available: false, reason: "injected unavailable state" } as const;
    const local = { attestationSecret: secret, pid: process.pid, port: 10100 };
    const headers = {
      [LOCAL_PROVIDER_RELOAD_EXPECTED_PID_HEADER]: String(process.pid),
      [LOCAL_PROVIDER_RELOAD_NONCE_HEADER]: nonce,
      [LOCAL_PROVIDER_RELOAD_EXPIRES_AT_HEADER]: String(expiresAt),
      [LOCAL_PROVIDER_RELOAD_NAME_HEADER]: "xai",
      "content-length": "0",
      [LOCAL_PROVIDER_RELOAD_CAPABILITY_HEADER]: createLocalProviderReloadCapability(
        secret,
        nonce,
        LOCAL_PROVIDER_RELOAD_METHOD,
        LOCAL_PROVIDER_RELOAD_PATH,
        "xai",
        process.pid,
        local.port,
        expiresAt,
      )!,
    };

    const request = new Request(`http://127.0.0.1:${local.port}${LOCAL_PROVIDER_RELOAD_PATH}`, {
      method: LOCAL_PROVIDER_RELOAD_METHOD,
      headers,
    });
    expect(requireManagementAuth(request, unavailable, remoteConfig(), local)).toBeNull();
    expect(managementPrincipal(request, unavailable, remoteConfig(), local))
      .toBe("local-provider-reload-capability");

    const replay = new Request(request.url, { method: LOCAL_PROVIDER_RELOAD_METHOD, headers });
    expect(requireManagementAuth(replay, unavailable, remoteConfig(), local)?.status).toBe(503);
    const wrongName = new Request(request.url, {
      method: LOCAL_PROVIDER_RELOAD_METHOD,
      headers: { ...headers, [LOCAL_PROVIDER_RELOAD_NAME_HEADER]: "openai" },
    });
    expect(requireManagementAuth(wrongName, unavailable, remoteConfig(), local)?.status).toBe(503);
    const query = new Request(`${request.url}?name=xai`, { method: LOCAL_PROVIDER_RELOAD_METHOD, headers });
    expect(requireManagementAuth(query, unavailable, remoteConfig(), local)?.status).toBe(503);
    const body = new Request(request.url, {
      method: LOCAL_PROVIDER_RELOAD_METHOD,
      headers: { ...headers, "content-length": "2" },
      body: "{}",
    });
    expect(requireManagementAuth(body, unavailable, remoteConfig(), local)?.status).toBe(503);
  });

  test("provider-reload capability binds method path process endpoint and TTL", () => {
    const secret = "A".repeat(43);
    const nonce = "K".repeat(43);
    const now = 1_800_000_000_000;
    const pid = 4242;
    const port = 10100;
    const name = "xai";
    const validExpiry = now + LOCAL_PROVIDER_RELOAD_CAPABILITY_TTL_MS;
    const capability = createLocalProviderReloadCapability(
      secret,
      nonce,
      LOCAL_PROVIDER_RELOAD_METHOD,
      LOCAL_PROVIDER_RELOAD_PATH,
      name,
      pid,
      port,
      validExpiry,
    )!;
    const verify = (
      method = LOCAL_PROVIDER_RELOAD_METHOD,
      path = LOCAL_PROVIDER_RELOAD_PATH,
      selectedName = name,
      selectedPid = pid,
      selectedPort = port,
      expiresAt = validExpiry,
      candidate = capability,
    ) => verifyLocalProviderReloadCapability(
      secret,
      nonce,
      method,
      path,
      selectedName,
      selectedPid,
      selectedPort,
      expiresAt,
      candidate,
      now,
    );

    expect(verify()).toBe(true);
    expect(verify("GET")).toBe(false);
    expect(verify(LOCAL_PROVIDER_RELOAD_METHOD, "/api/providers")).toBe(false);
    expect(verify(LOCAL_PROVIDER_RELOAD_METHOD, LOCAL_PROVIDER_RELOAD_PATH, "openai")).toBe(false);
    expect(verify(LOCAL_PROVIDER_RELOAD_METHOD, LOCAL_PROVIDER_RELOAD_PATH, name, pid + 1)).toBe(false);
    expect(verify(LOCAL_PROVIDER_RELOAD_METHOD, LOCAL_PROVIDER_RELOAD_PATH, name, pid, port + 1)).toBe(false);
    expect(verify(LOCAL_PROVIDER_RELOAD_METHOD, LOCAL_PROVIDER_RELOAD_PATH, name, pid, port, now, capability)).toBe(false);

    const tooLate = now + LOCAL_PROVIDER_RELOAD_CAPABILITY_TTL_MS + 1;
    const tooLateCapability = createLocalProviderReloadCapability(
      secret,
      nonce,
      LOCAL_PROVIDER_RELOAD_METHOD,
      LOCAL_PROVIDER_RELOAD_PATH,
      name,
      pid,
      port,
      tooLate,
    )!;
    expect(verify(
      LOCAL_PROVIDER_RELOAD_METHOD,
      LOCAL_PROVIDER_RELOAD_PATH,
      name,
      pid,
      port,
      tooLate,
      tooLateCapability,
    )).toBe(false);
  });

  test("management-token temp cleanup forgets successful ACL memos and retains failed removals", () => {
    const temporary = join(testHome, ".admin-token.tmp");
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ocx-test-user";
    resetHardenedStateForTests();
    setPlatformForTests("win32");
    setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
    try {
      writeFileSync(temporary, "secret", { mode: 0o600 });
      hardenSecretPath(temporary, { required: true });
      removeManagementTokenPathBestEffort(temporary);
      expect(hardenedSecretPathCountForTests()).toBe(0);

      writeFileSync(temporary, "secret", { mode: 0o600 });
      hardenSecretPath(temporary, { required: true });
      removeManagementTokenPathBestEffort(temporary, () => {
        throw Object.assign(new Error("injected unlink failure"), { code: "EPERM" });
      });
      expect(hardenedSecretPathCountForTests()).toBe(1);
    } finally {
      setIcaclsRunnerForTests(null);
      setPlatformForTests(null);
      resetHardenedStateForTests();
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
    }
  });

  test("stable-path cleanup drops only the success memo; temp cleanup releases all", () => {
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ocx-test-user";
    resetHardenedStateForTests();
    setPlatformForTests("win32");
    setIcaclsRunnerForTests(() => ({ success: false, exitCode: null, timedOut: true, stdout: "" }));
    const stable = join(testHome, "admin-api-token");
    const temp = join(testHome, ".admin-token.tmp");
    writeFileSync(stable, "x", { mode: 0o600 });
    writeFileSync(temp, "y", { mode: 0o600 });
    try {
      // Optional timeouts memoize by path (required:false soft-fails).
      expect(hardenSecretPath(stable, { required: false }).ok).toBe(false);
      expect(hardenSecretPath(temp, { required: false }).ok).toBe(false);
      expect(timedOutSecretPathCountForTests()).toBe(2);
      // Stable cleanup: success memo gone, timeout memos UNTOUCHED (anti-restall).
      removeManagementTokenPathBestEffort(stable);
      expect(timedOutSecretPathCountForTests()).toBe(2);
      // Temp cleanup with the ephemeral flag: only the temp's memo is released;
      // the stable destination memo still stands.
      removeManagementTokenPathBestEffort(temp, unlinkSync, { ephemeral: true });
      expect(timedOutSecretPathCountForTests()).toBe(1);
    } finally {
      setIcaclsRunnerForTests(null);
      setPlatformForTests(null);
      resetHardenedStateForTests();
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
    }
  });

  test("final-path timeout memo survives stable-path cleanup (anti-restall)", async () => {
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ocx-test-user";
    delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
    resetHardenedStateForTests();
    setPlatformForTests("win32");
    // The temp harden succeeds; the FINAL path harden times out.
    let calls = 0;
    setIcaclsRunnerForTests(() => {
      calls += 1;
      // Production runs 3 icacls per harden: directory (1-3), temp (4-6),
      // final token path (7-9) — the timeout must land on the FINAL path.
      return calls <= 6
        ? { success: true, exitCode: 0, timedOut: false, stdout: "" }
        : { success: false, exitCode: null, timedOut: true, stdout: "" };
    });
    try {
      initializeManagementAuthState(remoteConfig());
      expect(timedOutSecretPathCountForTests()).toBe(1);
    } finally {
      setIcaclsRunnerForTests(null);
      setPlatformForTests(null);
      resetHardenedStateForTests();
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
    }
  });

  test("data and management environment tokens authorize only their own planes", async () => {
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const managementWithDataToken = await fetch(new URL("/api/config", server.url), {
        headers: { "x-opencodex-api-key": "data-secret" },
      });
      expect(managementWithDataToken.status).toBe(401);

      const managementWithAdminToken = await fetch(new URL("/api/config", server.url), {
        headers: { "x-opencodex-api-key": "admin-secret" },
      });
      expect(managementWithAdminToken.status).toBe(200);

      const dataWithDataToken = await fetch(new URL("/v1/models", server.url), {
        headers: { "x-opencodex-api-key": "data-secret" },
      });
      expect(dataWithDataToken.status).toBe(200);

      const dataWithAdminToken = await fetch(new URL("/v1/models", server.url), {
        headers: { "x-opencodex-api-key": "admin-secret" },
      });
      expect(dataWithAdminToken.status).toBe(401);
    } finally {
      await server.stop(true);
    }
  });


  test("config salvage does not weaken the management auth boundary (#1785)", async () => {
    // Salvage keeps a config loading after dropping an invalid entry. That must not turn into
    // a way to reach the management plane: the credential separation is enforced before route
    // dispatch, and a partially-salvaged config has to behave exactly like a clean one.
    const salvageable = remoteConfig() as Record<string, unknown>;
    salvageable.routingProfiles = {
      good: { candidates: [{ provider: "test", model: "gpt-test" }] },
      bad:  { candidates: [{ provider: "not-configured", model: "gpt-test" }] },
    };
    writeFileSync(getConfigPath(), JSON.stringify(salvageable, null, 2), { mode: 0o600 });

    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const server = startServer(0);
    try {
      const anonymous = await fetch(new URL("/api/config", server.url));
      expect(anonymous.status).toBe(401);

      const withDataToken = await fetch(new URL("/api/config", server.url), {
        headers: { "x-opencodex-api-key": "data-secret" },
      });
      expect(withDataToken.status).toBe(401);

      const withWrongAdminToken = await fetch(new URL("/api/config", server.url), {
        headers: { "x-opencodex-api-key": "not-the-admin-secret" },
      });
      expect(withWrongAdminToken.status).toBe(401);

      const withAdminToken = await fetch(new URL("/api/config", server.url), {
        headers: { "x-opencodex-api-key": "admin-secret" },
      });
      expect(withAdminToken.status).toBe(200);

      // The salvaged config is what the authorized caller sees: the provider survives and only
      // the invalid profile is gone. A fallback here would hand back built-in defaults, which a
      // later write would persist over the operator's providers.
      const body = await withAdminToken.json() as Record<string, any>;
      expect(Object.keys(body.providers ?? {})).toContain("test");
      expect(Object.keys(body.routingProfiles ?? {})).not.toContain("bad");
    } finally {
      await server.stop(true);
      errorSpy.mockRestore();
    }
  });
  test("a management token that matches the data environment token closes only the management plane", async () => {
    process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "data-secret";
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const data = await fetch(new URL("/v1/models", server.url), {
        headers: { "x-opencodex-api-key": "data-secret" },
      });
      expect(data.status).toBe(200);

      const management = await fetch(new URL("/api/config", server.url), {
        headers: { "x-opencodex-api-key": "data-secret" },
      });
      expect(management.status).toBe(503);
    } finally {
      await server.stop(true);
    }
  });

  test("a management token that matches a configured data key closes only the management plane", async () => {
    delete process.env.OPENCODEX_API_AUTH_TOKEN;
    const config = remoteConfig();
    config.apiKeys = [{
      id: "conflict",
      name: "Conflicting data key",
      key: "admin-secret",
      createdAt: "2026-07-28T00:00:00.000Z",
    }];
    saveConfig(config);
    const server = startServer(0);
    try {
      const data = await fetch(new URL("/v1/models", server.url), {
        headers: { "x-opencodex-api-key": "admin-secret" },
      });
      expect(data.status).toBe(200);

      const management = await fetch(new URL("/api/config", server.url), {
        headers: { "x-opencodex-api-key": "admin-secret" },
      });
      expect(management.status).toBe(503);
    } finally {
      await server.stop(true);
    }
  });

  test("a protected management token file is generated and remains management-only", async () => {
    delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const adminToken = readFileSync(join(testHome, "admin-api-token"), "utf8").trim();
      expect(adminToken).toMatch(/^ocx_admin_[A-Za-z0-9_-]{43}$/);

      const management = await fetch(new URL("/api/config", server.url), {
        headers: { "x-opencodex-api-key": adminToken },
      });
      expect(management.status).toBe(200);

      const data = await fetch(new URL("/v1/models", server.url), {
        headers: { "x-opencodex-api-key": adminToken },
      });
      expect(data.status).toBe(401);
    } finally {
      await server.stop(true);
    }
  });

  test("an icacls timeout keeps the management plane closed without stopping the data plane", async () => {
    delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
    saveConfig(remoteConfig());
    setPlatformForTests("win32");
    setIcaclsRunnerForTests(args => {
      const target = args[0] ?? "";
      if (target.includes(".admin-token.tmp")) {
        return { success: false, exitCode: null, timedOut: true, stdout: "" };
      }
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });

    const server = startServer(0);
    try {
      const health = await fetch(new URL("/healthz", server.url));
      expect(health.status).toBe(200);

      const data = await fetch(new URL("/v1/models", server.url), {
        headers: { "x-opencodex-api-key": "data-secret" },
      });
      expect(data.status).toBe(200);

      const management = await fetch(new URL("/api/config", server.url), {
        headers: { "x-opencodex-api-key": "ocx_admin_unhardened" },
      });
      expect(management.status).toBe(503);
      const body = await management.json() as { error?: string; hint?: string; reason?: string };
      expect(body.error).toBe("management API unavailable");
      expect(body.hint).toContain("OPENCODEX_ADMIN_AUTH_TOKEN");
      expect(typeof body.reason).toBe("string");
      expect(body.reason!.length).toBeGreaterThan(0);
    } finally {
      await server.stop(true);
    }
  });

  test("a configured data key satisfies the remote data-plane startup requirement", async () => {
    delete process.env.OPENCODEX_API_AUTH_TOKEN;
    const config = remoteConfig();
    config.apiKeys = [{
      id: "configured",
      name: "Configured data key",
      key: "ocx_data_configured-secret",
      createdAt: "2026-07-28T00:00:00.000Z",
    }];
    saveConfig(config);

    const server = startServer(0);
    try {
      const data = await fetch(new URL("/v1/models", server.url), {
        headers: { "x-opencodex-api-key": "ocx_data_configured-secret" },
      });
      expect(data.status).toBe(200);

      const management = await fetch(new URL("/api/config", server.url), {
        headers: { "x-opencodex-api-key": "ocx_data_configured-secret" },
      });
      expect(management.status).toBe(401);
    } finally {
      await server.stop(true);
    }
  });

  test("management browser origins must match the request origin exactly", async () => {
    const config = remoteConfig();
    config.hostname = "127.0.0.1";
    saveConfig(config);
    const server = startServer(0);
    try {
      const crossPort = await fetch(new URL("/api/config", server.url), {
        headers: {
          "x-opencodex-api-key": "admin-secret",
          origin: "http://127.0.0.1:65534",
        },
      });
      expect(crossPort.status).toBe(403);

      const sameOrigin = await fetch(new URL("/api/config", server.url), {
        headers: {
          "x-opencodex-api-key": "admin-secret",
          origin: server.url.origin,
        },
      });
      expect(sameOrigin.status).toBe(200);
      expect(sameOrigin.headers.get("access-control-allow-origin")).toBe(server.url.origin);
    } finally {
      await server.stop(true);
    }
  });

  test("a local GUI page receives an origin-bound session with CSRF protection", async () => {
    const config = remoteConfig();
    config.hostname = "127.0.0.1";
    const state = initializeManagementAuthState(config);
    const pageRequest = new Request("http://localhost:10100/", {
      headers: { Host: "localhost:10100" },
    });
    const now = 1_800_000_000_000;
    const session = issueGuiSession(pageRequest, config, state, { trustedTailscaleIngress: false, now });
    expect(session).not.toBeNull();
    expect(session).toMatchObject({
      serverOrigin: "http://localhost:10100",
      browserOrigin: "http://localhost:10100",
      issuance: "loopback",
      expiresAt: now + LOOPBACK_GUI_SESSION_TTL_MS,
    });

    const guiDist = join(testHome, "gui");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(guiDist);
    writeFileSync(join(guiDist, "index.html"), "<!doctype html><html><head></head><body></body></html>");
    const page = serveGuiFile("/", guiDist, session ?? undefined);
    expect(page?.headers.get("cache-control")).toBe("no-store");
    const html = await page?.text();
    expect(html).toContain(`name="opencodex-session-token" content="${session?.token}"`);
    expect(html).toContain(`name="opencodex-session-csrf" content="${session?.csrfToken}"`);

    // The dev GUI fetches /opencodex-session through Vite so the app shell stays
    // Vite-owned. The backend answers that path without requiring gui/dist, so a fresh
    // source checkout (no packaged build) can still mint an origin-bound session.
    const bootstrapPage = serveSessionBootstrap(session!);
    const bootstrapHtml = await bootstrapPage.text();
    expect(bootstrapHtml).toContain(`name="opencodex-session-origin" content="${session?.browserOrigin}"`);
    expect(bootstrapHtml).toContain(`name="opencodex-session-server-origin" content="${session?.serverOrigin}"`);
    expect(bootstrapHtml).toContain(`name="opencodex-session-token" content="${session?.token}"`);

    const sameOriginRead = new Request("http://localhost:10100/api/config", {
      headers: {
        Host: "localhost:10100",
        "x-opencodex-api-key": session?.token ?? "",
        "x-opencodex-gui-origin": "http://localhost:10100",
      },
    });
    expect(requireManagementAuth(sameOriginRead, state, config)).toBeNull();

    const crossPortRead = new Request("http://localhost:10100/api/config", {
      headers: {
        Host: "localhost:10100",
        Origin: "http://localhost:20100",
        "x-opencodex-api-key": session?.token ?? "",
        "x-opencodex-gui-origin": "http://localhost:20100",
      },
    });
    expect(requireManagementAuth(crossPortRead, state, config)?.status).toBe(401);

    const mutationWithoutCsrf = new Request("http://localhost:10100/api/config", {
      method: "POST",
      headers: {
        Host: "localhost:10100",
        Origin: "http://localhost:10100",
        "x-opencodex-api-key": session?.token ?? "",
        "x-opencodex-gui-origin": "http://localhost:10100",
      },
    });
    expect(requireManagementAuth(mutationWithoutCsrf, state, config)?.status).toBe(401);

    const mutationWithCsrf = new Request("http://localhost:10100/api/config", {
      method: "POST",
      headers: {
        Host: "localhost:10100",
        Origin: "http://localhost:10100",
        "x-opencodex-api-key": session?.token ?? "",
        "x-opencodex-gui-origin": "http://localhost:10100",
        "x-opencodex-csrf-token": session?.csrfToken ?? "",
      },
    });
    expect(requireManagementAuth(mutationWithCsrf, state, config)).toBeNull();

    expect(issueGuiSession(new Request("http://attacker.test/", {
      headers: { Host: "attacker.test" },
    }), config, state)).toBeNull();
    expect(issueGuiSession(new Request("http://localhost:10100/"), config, state)).toBeNull();
  });

  test("GET /opencodex-session serves the bootstrap document from a live server", async () => {
    const config = remoteConfig();
    config.hostname = "127.0.0.1";
    saveConfig(config);
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/opencodex-session", server.url), {
        headers: { Host: server.url.host },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("pragma")).toBe("no-cache");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");

      const html = await response.text();
      expect(html).toContain('name="opencodex-session-token"');
      expect(html).toContain('name="opencodex-session-csrf"');
      expect(html).toContain('name="opencodex-session-origin"');
      expect(html).toContain('name="opencodex-session-server-origin"');
    } finally {
      await server.stop(true);
    }
  });

  test("session bootstrap escapes both browser and server origin attributes", async () => {
    const response = serveSessionBootstrap({
      token: "ocx_session_safe",
      csrfToken: "csrf-safe",
      browserOrigin: 'https://browser.example.test/\"><script>alert(1)</script>',
      serverOrigin: 'https://hub.example.test/\"><img src=x onerror=alert(1)>',
      expiresAt: Date.now() + 1_000,
      issuance: "pairing",
    });
    const html = await response.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
  });

  test("remote identity issuance requires trusted ingress, hub role, HTTPS, and an exact allowlisted login", () => {
    const config = hubConfig();
    const state = initializeManagementAuthState(config);
    if (!state.available) throw new Error("expected management auth state");
    const now = 1_800_000_000_000;
    const request = new Request("https://hub.example.test/", {
      headers: {
        Host: "hub.example.test",
        Origin: "https://dashboard.example.test",
        "Tailscale-User-Login": "alice@example.test",
      },
    });
    expect(issueGuiSession(request, config, state, { trustedTailscaleIngress: false, now })).toBeNull();
    expect(issueGuiSession(request, config, state, { trustedTailscaleIngress: true, now })).toMatchObject({
      serverOrigin: "https://hub.example.test",
      browserOrigin: "https://dashboard.example.test",
      issuance: "tailscale-identity",
      expiresAt: now + REMOTE_GUI_SESSION_TTL_MS,
    });
    expect(issueGuiSession(new Request(request, {
      headers: { ...Object.fromEntries(request.headers), "Tailscale-User-Login": "mallory@example.test" },
    }), config, state, { trustedTailscaleIngress: true, now })).toBeNull();
    expect(issueGuiSession(new Request(request, {
      headers: { ...Object.fromEntries(request.headers), "Tailscale-User-Login": " alice@example.test " },
    }), config, state, { trustedTailscaleIngress: true, now })).toBeNull();
    expect(issueGuiSession(request, { ...config, runtimeRole: "client" }, state, { trustedTailscaleIngress: true, now })).toBeNull();
    expect(issueGuiSession(request, { ...config, remoteGui: { allowedTailscaleUsers: [] } }, state, { trustedTailscaleIngress: true, now })).toBeNull();
    const httpConfig = hubConfig("http://hub.example.test");
    expect(issueGuiSession(new Request("http://hub.example.test/", {
      headers: { Host: "hub.example.test", "Tailscale-User-Login": "alice@example.test" },
    }), httpConfig, state, { trustedTailscaleIngress: true, now })).toBeNull();
  });

  test("the live listener trusts Tailscale identity only on hub management ingress", async () => {
    const managementPort = await findAvailablePort(0, "127.0.0.1");
    const publicPort = await findAvailablePort(0, "127.0.0.1", { reservedPort: managementPort });
    const config = hubConfig();
    config.hub = {
      ...config.hub,
      managementIngress: { enabled: true, port: managementPort },
    };
    saveConfig(config);
    const state = initializeManagementAuthState(config);
    if (!state.available) throw new Error("expected management auth state");
    const server = startServer(publicPort, { managementAuthState: state });
    const headers = { Host: "hub.example.test", "Tailscale-User-Login": "alice@example.test" };
    try {
      const spoofedPublic = await fetch(new URL("/opencodex-session", server.url), { headers });
      expect(spoofedPublic.status).toBe(401);

      const wrongUser = await fetch(`http://127.0.0.1:${managementPort}/opencodex-session`, {
        headers: { ...headers, "Tailscale-User-Login": "mallory@example.test" },
      });
      expect(wrongUser.status).toBe(401);

      const issued = await fetch(`http://127.0.0.1:${managementPort}/opencodex-session`, { headers });
      expect(issued.status).toBe(200);
      const html = await issued.text();
      const token = /name="opencodex-session-token" content="([^"]+)"/.exec(html)?.[1];
      expect(token).toBeDefined();
      const sessionHeaders = {
        Host: "hub.example.test",
        Origin: "https://hub.example.test",
        "x-opencodex-api-key": token!,
        "x-opencodex-gui-origin": "https://hub.example.test",
      };
      const management = await fetch(`http://127.0.0.1:${managementPort}/api/config`, {
        headers: sessionHeaders,
      });
      expect(management.status).toBe(200);

      // Connected GUI status/restart polling stays authenticated without widening the ingress:
      // raw liveness remains absent, while its bounded management counterpart is available.
      const rawHealth = await fetch(`http://127.0.0.1:${managementPort}/healthz`, {
        headers: sessionHeaders,
      });
      expect(rawHealth.status).toBe(404);
      const managementHealth = await fetch(`http://127.0.0.1:${managementPort}/api/system/health`, {
        headers: sessionHeaders,
      });
      expect(managementHealth.status).toBe(200);
      expect(await managementHealth.json()).toMatchObject({
        status: "ok",
        service: "opencodex",
        version: expect.any(String),
        uptime: expect.any(Number),
        pid: process.pid,
      });

      const adminConsent = await fetch(`http://127.0.0.1:${managementPort}/api/github/star`, {
        method: "POST",
        headers: {
          Host: "hub.example.test",
          Origin: "https://hub.example.test",
          "x-opencodex-api-key": "admin-secret",
        },
      });
      expect(adminConsent.status).toBe(403);
    } finally {
      await server.stop(true);
    }
  });

  test("pairing grants are digest-only, origin-bound, single-use, and never accept alternate credentials", () => {
    const config = hubConfig();
    const state = initializeManagementAuthState(config);
    if (!state.available) throw new Error("expected management auth state");
    const now = 1_800_000_000_000;
    const created = createGuiPairingGrant("https://dashboard.example.test", config, state, now);
    expect(created.expiresAt).toBe(now + GUI_PAIRING_GRANT_TTL_MS);
    expect(state.sessions.size).toBe(0);
    expect(state.pairingGrants.size).toBe(1);
    expect([...state.pairingGrants.keys()].join(" ")).not.toContain(created.grant);

    const exchange = (origin: string, host = "hub.example.test", headers: HeadersInit = {}) => new Request(
      "https://hub.example.test/opencodex-session",
      { method: "POST", headers: { Host: host, Origin: origin, ...headers } },
    );
    expect(consumeGuiPairingGrant(
      exchange("https://evil.example.test"), { grant: created.grant }, config, state, now + 1,
    )).toBeNull();
    expect(consumeGuiPairingGrant(
      exchange("https://dashboard.example.test", "localhost:10100"), { grant: created.grant }, config, state, now + 1,
    )).toBeNull();
    for (const alternateCredential of ["admin-secret", "data-secret", "ocx_session_not-a-grant"]) {
      expect(consumeGuiPairingGrant(
        exchange("https://dashboard.example.test", "hub.example.test", { "x-opencodex-api-key": alternateCredential }),
        { grant: created.grant }, config, state, now + 1,
      )).toBeNull();
    }
    const session = consumeGuiPairingGrant(
      exchange("https://dashboard.example.test"), { grant: created.grant }, config, state, now + 1,
    );
    expect(session).toMatchObject({
      serverOrigin: "https://hub.example.test",
      browserOrigin: "https://dashboard.example.test",
      issuance: "pairing",
      expiresAt: now + 1 + REMOTE_GUI_SESSION_TTL_MS,
    });
    expect(state.pairingGrants.size).toBe(0);
    expect(consumeGuiPairingGrant(
      exchange("https://dashboard.example.test"), { grant: created.grant }, config, state, now + 2,
    )).toBeNull();

    const expired = createGuiPairingGrant("https://dashboard.example.test", config, state, now + 10);
    expect(consumeGuiPairingGrant(
      exchange("https://dashboard.example.test"), { grant: expired.grant }, config, state, expired.expiresAt,
    )).toBeNull();
  });

  test("pairing burns a grant after five failures and rate-limits a source after ten guesses", () => {
    const config = hubConfig();
    const state = initializeManagementAuthState(config);
    if (!state.available) throw new Error("expected management auth state");
    const now = 1_800_000_000_000;
    const created = createGuiPairingGrant("https://dashboard.example.test", config, state, now);
    const context = {
      ingress: "public" as const,
      peerAddress: "192.0.2.10",
      tailscaleUser: null,
      browserOrigin: "https://evil.example.test",
    };
    const wrongOrigin = new Request("https://hub.example.test/opencodex-session", {
      method: "POST",
      headers: { Host: "hub.example.test", Origin: "https://evil.example.test" },
    });
    for (let attempt = 1; attempt <= 4; attempt++) {
      expect(consumeGuiPairingGrant(wrongOrigin, { grant: created.grant }, config, state, now + attempt, context)).toBeNull();
    }
    expect(consumeGuiPairingGrant(wrongOrigin, { grant: created.grant }, config, state, now + 5, context))
      .toMatchObject({ allowed: false, reason: "grant" });
    expect(state.pairingGrants.size).toBe(0);

    const guessContext = { ...context, peerAddress: "192.0.2.11" };
    const validOrigin = new Request("https://hub.example.test/opencodex-session", {
      method: "POST",
      headers: { Host: "hub.example.test", Origin: "https://dashboard.example.test" },
    });
    for (let attempt = 1; attempt <= 9; attempt++) {
      expect(consumeGuiPairingGrant(validOrigin, { grant: `ocx_pair_${String(attempt).padStart(43, "a")}` }, config, state, now + attempt, guessContext)).toBeNull();
    }
    expect(consumeGuiPairingGrant(validOrigin, { grant: `ocx_pair_${"z".repeat(43)}` }, config, state, now + 10, guessContext))
      .toMatchObject({ allowed: false, reason: "source" });
  });

  test("self logout revokes only the current GUI session and admin credentials get 403", async () => {
    const config = remoteConfig();
    saveConfig(config);
    const state = initializeManagementAuthState(config);
    if (!state.available) throw new Error("expected management auth state");
    const server = startServer(0, { managementAuthState: state });
    const origin = server.url.origin;
    const token = "ocx_session_logout_test";
    state.sessions.set(token, {
      serverOrigin: origin,
      browserOrigin: origin,
      csrfToken: "csrf-logout-test",
      expiresAt: Date.now() + 60_000,
      issuance: "loopback",
    });
    const sessionHeaders = {
      Origin: origin,
      "x-opencodex-api-key": token,
      "x-opencodex-gui-origin": origin,
      "x-opencodex-csrf-token": "csrf-logout-test",
    };
    try {
      expect((await fetch(new URL("/api/session/logout", server.url), { method: "POST", headers: sessionHeaders })).status).toBe(200);
      expect(state.sessions.has(token)).toBe(false);
      expect((await fetch(new URL("/api/session/logout", server.url), { method: "POST", headers: sessionHeaders })).status).toBe(401);
      expect((await fetch(new URL("/api/session/logout", server.url), {
        method: "POST",
        headers: { Origin: origin, "x-opencodex-api-key": "admin-secret" },
      })).status).toBe(403);
    } finally {
      await server.stop(true);
    }
  });

  test("the management ingress preserves the one-use pairing exchange contract", async () => {
    const managementPort = await findAvailablePort(0, "127.0.0.1");
    const publicPort = await findAvailablePort(0, "127.0.0.1", { reservedPort: managementPort });
    const config = hubConfig();
    config.hub = { ...config.hub, managementIngress: { enabled: true, port: managementPort } };
    saveConfig(config);
    const state = initializeManagementAuthState(config);
    if (!state.available) throw new Error("expected management auth state");
    const created = createGuiPairingGrant("https://dashboard.example.test", config, state);
    const server = startServer(publicPort, { managementAuthState: state });
    const url = `http://127.0.0.1:${managementPort}/opencodex-session`;
    const headers = {
      Host: "hub.example.test",
      Origin: "https://dashboard.example.test",
      "content-type": "application/json",
    };
    try {
      const adminAttempt = await fetch(url, {
        method: "POST",
        headers: { ...headers, "x-opencodex-api-key": "admin-secret" },
        body: JSON.stringify({ grant: created.grant }),
      });
      expect(adminAttempt.status).toBe(401);
      expect(state.pairingGrants.size).toBe(1);

      const exchanged = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ grant: created.grant }),
      });
      expect(exchanged.status).toBe(200);
      expect(state.pairingGrants.size).toBe(0);

      const replay = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ grant: created.grant }),
      });
      expect(replay.status).toBe(401);
    } finally {
      await server.stop(true);
    }
  });

  test("non-loopback plaintext HTTP cannot carry a pairing grant, and no opt-in re-opens it", () => {
    // An earlier revision let this exchange succeed when `remoteGui.allowInsecureHttp` was
    // true, and this test asserted exactly that. The flag is retired: a reusable grant on
    // plaintext HTTP is readable by anything on the path, and the session it mints is
    // reusable, so operator opt-in recorded a risk it could not bound.
    const config = hubConfig("http://hub.example.test");
    const state = initializeManagementAuthState(config);
    if (!state.available) throw new Error("expected management auth state");
    const now = 1_800_000_000_000;
    const created = createGuiPairingGrant("https://dashboard.example.test", config, state, now);
    const request = new Request("http://hub.example.test/opencodex-session", {
      method: "POST",
      headers: { Host: "hub.example.test", Origin: "https://dashboard.example.test" },
    });

    expect(consumeGuiPairingGrant(request, { grant: created.grant }, config, state, now + 1)).toBeNull();
    // The grant SURVIVES the refusal. Rejecting before the grant is read is what stops an
    // attacker who strips TLS from burning every code the operator prints.
    expect(state.pairingGrants.size).toBe(1);

    // The retired flag is still accepted by the schema so old configs load, and still grants
    // nothing.
    config.remoteGui = { ...config.remoteGui, allowInsecureHttp: true };
    expect(consumeGuiPairingGrant(request, { grant: created.grant }, config, state, now + 2)).toBeNull();
    expect(state.pairingGrants.size).toBe(1);

    // The same unspent grant still works over HTTPS, proving the refusal was about transport
    // rather than the grant being invalidated.
    const secureConfig = hubConfig("https://hub.example.test");
    const secureState = initializeManagementAuthState(secureConfig);
    if (!secureState.available) throw new Error("expected management auth state");
    const secureGrant = createGuiPairingGrant("https://dashboard.example.test", secureConfig, secureState, now);
    const secureRequest = new Request("https://hub.example.test/opencodex-session", {
      method: "POST",
      headers: { Host: "hub.example.test", Origin: "https://dashboard.example.test" },
    });
    expect(consumeGuiPairingGrant(secureRequest, { grant: secureGrant.grant }, secureConfig, secureState, now + 1)).toMatchObject({
      issuance: "pairing",
    });
    expect(secureState.pairingGrants.size).toBe(0);
  });

  test("pairing grant creation is bounded by a per-state rate limit", () => {
    const config = hubConfig();
    const state = initializeManagementAuthState(config);
    if (!state.available) throw new Error("expected management auth state");
    const now = 1_800_000_000_000;
    for (let index = 0; index < 8; index++) {
      createGuiPairingGrant("https://dashboard.example.test", config, state, now + index);
    }
    expect(() => createGuiPairingGrant("https://dashboard.example.test", config, state, now + 9)).toThrow("rate limit");
    expect(state.sessions.size).toBe(0);
  });

  test("remote session admission shares the full predicate and renews only after success", () => {
    const config = hubConfig();
    const state = initializeManagementAuthState(config);
    if (!state.available) throw new Error("expected management auth state");
    const issuedAt = 1_800_000_000_000;
    const created = createGuiPairingGrant("https://dashboard.example.test", config, state, issuedAt);
    const session = consumeGuiPairingGrant(new Request("https://hub.example.test/opencodex-session", {
      method: "POST",
      headers: { Host: "hub.example.test", Origin: "https://dashboard.example.test" },
    }), { grant: created.grant }, config, state, issuedAt + 1)!;
    const before = session.expiresAt;
    const request = (overrides: Record<string, string> = {}, method = "GET", host = "hub.example.test") => new Request(
      `https://${host}/api/config`,
      {
        method,
        headers: {
          Host: host,
          Origin: "https://dashboard.example.test",
          "x-opencodex-api-key": session.token,
          "x-opencodex-gui-origin": "https://dashboard.example.test",
          ...(method === "GET" ? {} : { "x-opencodex-csrf-token": session.csrfToken }),
          ...overrides,
        },
      },
    );
    expect(authorizeGuiSessionRequest(request({ "x-opencodex-gui-origin": "https://evil.example.test" }), config, state, issuedAt + 2)).toMatchObject({ ok: false, reason: "browser-origin" });
    expect(session.expiresAt).toBe(before);
    expect(authorizeGuiSessionRequest(request({}, "POST", "localhost:10100"), config, state, issuedAt + 3)).toMatchObject({ ok: false, reason: "server-origin" });
    expect(session.expiresAt).toBe(before);
    expect(authorizeGuiSessionRequest(request({ "x-opencodex-csrf-token": "wrong" }, "POST"), config, state, issuedAt + 4)).toMatchObject({ ok: false, reason: "csrf" });
    expect(session.expiresAt).toBe(before);
    const missingCsrf = new Request("https://hub.example.test/api/config", {
      method: "POST",
      headers: {
        Host: "hub.example.test",
        Origin: "https://dashboard.example.test",
        "x-opencodex-api-key": session.token,
        "x-opencodex-gui-origin": "https://dashboard.example.test",
      },
    });
    expect(authorizeGuiSessionRequest(missingCsrf, config, state, issuedAt + 4)).toMatchObject({ ok: false, reason: "csrf" });
    expect(session.expiresAt).toBe(before);
    expect(authorizeGuiSessionRequest(request({}, "POST"), config, state, issuedAt + 5)).toMatchObject({ ok: true, principal: "gui-session" });
    expect(session.expiresAt).toBe(issuedAt + 5 + REMOTE_GUI_SESSION_TTL_MS);
    session.expiresAt = issuedAt + 6;
    expect(authorizeGuiSessionRequest(request(), config, state, issuedAt + 7)).toMatchObject({ ok: false, reason: "expired" });
    expect(state.sessions.has(session.token)).toBe(false);
  });

  test("the live pairing route refuses admin authority and exchanges only a capability-created grant", async () => {
    const config = hubConfig();
    saveConfig(config);
    const state = initializeManagementAuthState(config);
    if (!state.available) throw new Error("expected management auth state");
    const secret = "G".repeat(43);
    const server = startServer(0, { managementAuthState: state, localAttestationSecret: secret });
    try {
      const adminAttempt = await fetch(new URL(GUI_PAIR_PATH, server.url), {
        method: "POST",
        headers: { "content-length": "0", "x-opencodex-api-key": "admin-secret" },
      });
      expect(adminAttempt.status).toBe(403);
      expect(state.pairingGrants.size).toBe(0);

      const nonce = "H".repeat(43);
      const expiresAt = Date.now() + GUI_PAIR_CAPABILITY_TTL_MS;
      const capability = createGuiPairCapability(
        secret, nonce, GUI_PAIR_METHOD, GUI_PAIR_PATH, "https://dashboard.example.test",
        process.pid, server.port, expiresAt,
      )!;
      const capabilityHeaders = {
        "content-length": "0",
        [GUI_PAIR_EXPECTED_PID_HEADER]: String(process.pid),
        [GUI_PAIR_NONCE_HEADER]: nonce,
        [GUI_PAIR_EXPIRES_AT_HEADER]: String(expiresAt),
        [GUI_PAIR_BROWSER_ORIGIN_HEADER]: "https://dashboard.example.test",
        [GUI_PAIR_CAPABILITY_HEADER]: capability,
      };
      const createdResponse = await fetch(new URL(GUI_PAIR_PATH, server.url), {
        method: "POST",
        headers: capabilityHeaders,
      });
      expect(createdResponse.status).toBe(201);
      expect(createdResponse.headers.get("cache-control")).toBe("no-store");
      const created = await createdResponse.json() as { grant: string };
      expect(state.pairingGrants.size).toBe(1);
      const replayedCapability = await fetch(new URL(GUI_PAIR_PATH, server.url), {
        method: "POST",
        headers: capabilityHeaders,
      });
      expect(replayedCapability.status).toBe(401);
      expect(state.pairingGrants.size).toBe(1);

      const adminExchange = await fetch(new URL("/opencodex-session", server.url), {
        method: "POST",
        headers: { Host: "hub.example.test", Origin: "https://dashboard.example.test", "content-type": "application/json" },
        body: JSON.stringify({ grant: "admin-secret" }),
      });
      expect(adminExchange.status).toBe(401);

      const exchanged = await fetch(new URL("/opencodex-session", server.url), {
        method: "POST",
        headers: { Host: "hub.example.test", Origin: "https://dashboard.example.test", "content-type": "application/json" },
        body: JSON.stringify({ grant: created.grant }),
      });
      expect(exchanged.status).toBe(200);
      expect(exchanged.headers.get("cache-control")).toBe("no-store");
      const html = await exchanged.text();
      expect(html).toContain('name="opencodex-session-origin" content="https://dashboard.example.test"');
      expect(html).toContain('name="opencodex-session-server-origin" content="https://hub.example.test"');
      expect(state.pairingGrants.size).toBe(0);
    } finally {
      await server.stop(true);
    }
  });

  test("a non-loopback binding never issues a GUI session from a forged loopback Host", () => {
    const config = remoteConfig();
    const state = initializeManagementAuthState(config);
    const request = new Request("http://localhost:10100/", {
      headers: { Host: "localhost:10100" },
    });
    expect(issueGuiSession(request, config, state)).toBeNull();
  });

  test("all local credential shapes are rejected by the upstream-forwarding guard", () => {
    const config = remoteConfig();
    config.apiKeys = [
      {
        id: "manual",
        name: "Manual data key",
        key: "manually-configured-data-secret",
        createdAt: "2026-07-28T00:00:00.000Z",
      },
      {
        id: "legacy",
        name: "Legacy data key",
        key: `ocx_${"a".repeat(40)}`,
        createdAt: "2026-07-28T00:00:00.000Z",
      },
    ];
    for (const secret of [
      "data-secret",
      "admin-secret",
      "manually-configured-data-secret",
      `ocx_${"a".repeat(40)}`,
      "ocx_data_generated",
      "ocx_admin_generated",
      "ocx_session_generated",
    ]) {
      expect(isProxyAdmissionSecret(secret, config)).toBe(true);
    }
    expect(isProxyAdmissionSecret("ocx_provider_upstream", config)).toBe(false);
  });

  test("Responses authentication and WebSocket handshakes accept data credentials only", async () => {
    const config = remoteConfig();
    config.websockets = true;
    saveConfig(config);
    const server = startServer(0);
    try {
      for (const rejected of ["admin-secret", "ocx_session_browser-secret"]) {
        const response = await fetch(new URL("/v1/responses", server.url), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-opencodex-api-key": rejected,
          },
          body: JSON.stringify({ model: "test/gpt-test", input: "hello" }),
        });
        expect(response.status).toBe(401);
        expect(await websocketHandshakeOpens(server.url, rejected)).toBe(false);
      }
      expect(await websocketHandshakeOpens(server.url, "data-secret")).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("an invalid existing management token file keeps management unavailable", async () => {
    delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
    saveConfig(remoteConfig());
    writeFileSync(join(testHome, "admin-api-token"), "corrupt-token\n", { mode: 0o600 });
    const server = startServer(0);
    try {
      const management = await fetch(new URL("/api/config", server.url), {
        headers: { "x-opencodex-api-key": "corrupt-token" },
      });
      expect(management.status).toBe(503);
      expect(readFileSync(join(testHome, "admin-api-token"), "utf8")).toBe("corrupt-token\n");
      expect((await fetch(new URL("/healthz", server.url))).status).toBe(200);
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS); // binds a real server + live fetches; windows runner measured ~5.04s against Bun's 5s default.

  test("an existing management token ACL hardening failure keeps management unavailable", async () => {
    delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
    saveConfig(remoteConfig());
    const adminToken = `ocx_admin_${"b".repeat(43)}`;
    writeFileSync(join(testHome, "admin-api-token"), `${adminToken}\n`, { mode: 0o600 });
    setPlatformForTests("win32");
    setIcaclsRunnerForTests(args => {
      const target = args[0] ?? "";
      if (target.endsWith("admin-api-token")) {
        return { success: false, exitCode: 5, timedOut: false, stdout: "" };
      }
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });
    const server = startServer(0);
    try {
      const management = await fetch(new URL("/api/config", server.url), {
        headers: { "x-opencodex-api-key": adminToken },
      });
      expect(management.status).toBe(503);
      expect((await fetch(new URL("/healthz", server.url))).status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("directory ACL timeout keeps management unavailable and names OPENCODEX_ADMIN_AUTH_TOKEN", () => {
    delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
    saveConfig(remoteConfig());
    const adminToken = `ocx_admin_${"d".repeat(43)}`;
    writeFileSync(join(testHome, "admin-api-token"), `${adminToken}\n`, { mode: 0o600 });
    process.env.USERNAME ??= "tester";
    setPlatformForTests("win32");
    // Timeout only the management-token directory. File hardens must succeed so
    // startServer → saveConfig can atomic-write on real win32; Linux CI skips
    // that path via process.platform and hid the blanket-timeout failure mode.
    setIcaclsRunnerForTests(args => {
      const target = args[0] ?? "";
      if (target === testHome) {
        return { success: false, exitCode: null, timedOut: true, stdout: "" };
      }
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });
    resetHardenedStateForTests();
    // Probe only: startServer would re-harden the same home for config mutation
    // and poison/conflict with this required directory timeout. HTTP 503 coverage
    // for ACL timeouts lives in "an icacls timeout keeps the management plane closed".
    const state = initializeManagementAuthState(remoteConfig());
    expect(state.available).toBe(false);
    if (state.available) return;
    expect(state.reason).toContain("OPENCODEX_ADMIN_AUTH_TOKEN");
  });

  test("required management harden retries after a soft loadConfig directory timeout", async () => {
    delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
    saveConfig(remoteConfig());
    const adminToken = `ocx_admin_${"f".repeat(43)}`;
    writeFileSync(join(testHome, "admin-api-token"), `${adminToken}\n`, { mode: 0o600 });
    process.env.USERNAME ??= "tester";
    setPlatformForTests("win32");

    let softPhase = true;
    let requiredPhaseCalls = 0;
    setIcaclsRunnerForTests(args => {
      const target = args[0] ?? "";
      if (target.endsWith("admin-api-token")) {
        return { success: true, exitCode: 0, timedOut: false, stdout: "" };
      }
      if (softPhase) {
        return { success: false, exitCode: null, timedOut: true, stdout: "" };
      }
      requiredPhaseCalls += 1;
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });
    resetHardenedStateForTests();

    const soft = hardenSecretDir(testHome, { required: false });
    expect(soft.ok).toBe(false);
    expect(soft.diagnostics).toMatch(/timed out|budget exhausted|previous attempt/i);

    softPhase = false;
    const state = initializeManagementAuthState(remoteConfig());
    expect(state.available).toBe(true);
    if (!state.available) return;
    expect(state.source).toBe("file");
    expect(requiredPhaseCalls).toBeGreaterThan(0);
  });

  test("OPENCODEX_ADMIN_AUTH_TOKEN bypasses file-backed ACL hardening", async () => {
    process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "env-admin-secret";
    saveConfig(remoteConfig());
    process.env.USERNAME ??= "tester";
    setPlatformForTests("win32");
    // Env-token init never needs file ACL. Time out management-token paths so a
    // broken file-backed ACL cannot be what made management available; allow
    // other file hardens so startServer → saveConfig works on real win32
    // (config-mutation directory harden soft-fails home timeouts).
    setIcaclsRunnerForTests(args => {
      const target = args[0] ?? "";
      if (target === testHome || target.endsWith("admin-api-token")) {
        return { success: false, exitCode: null, timedOut: true, stdout: "" };
      }
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });
    resetHardenedStateForTests();

    const state = initializeManagementAuthState(remoteConfig());
    expect(state.available).toBe(true);
    if (!state.available) return;
    expect(state.source).toBe("environment");

    const server = startServer(0);
    try {
      const management = await fetch(new URL("/api/config", server.url), {
        headers: { "x-opencodex-api-key": "env-admin-secret" },
      });
      expect(management.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });
});

describe("codex app-server restart routes ride the management gate", () => {
  // The service itself is unit-tested with injected seams
  // (tests/codex-app-server-restart-service.test.ts). These cases exist for one
  // reason: the route terminates the user's Codex app-servers, so it must be
  // unreachable without management credentials and from a foreign origin.
  test("both routes reject an unauthenticated caller and a cross-origin caller", async () => {
    const server = startServer(0);
    try {
      const stateUrl = new URL(CODEX_APP_SERVER_STATE_PATH, server.url);
      const restartUrl = new URL(CODEX_RESTART_PATH, server.url);

      const anonymousState = await fetch(stateUrl, { method: "GET" });
      expect(anonymousState.status).toBe(401);

      const anonymousRestart = await fetch(restartUrl, { method: "POST" });
      expect(anonymousRestart.status).toBe(401);

      // An admin token authenticates, but the shared management-origin gate runs
      // ahead of every route, so a foreign Origin is refused before dispatch.
      const foreignOrigin = await fetch(restartUrl, {
        method: "POST",
        headers: {
          Authorization: "Bearer admin-secret",
          Origin: "https://evil.example",
        },
      });
      expect(foreignOrigin.status).toBe(403);
    } finally {
      await server.stop(true);
    }
  });

  test("the data-plane token does not authorize the restart route", async () => {
    // The data token is handed to Codex itself. It must never be able to restart
    // the app-servers it belongs to.
    const server = startServer(0);
    try {
      const response = await fetch(new URL(CODEX_RESTART_PATH, server.url), {
        method: "POST",
        headers: { Authorization: "Bearer data-secret" },
      });
      expect(response.status).toBe(401);
    } finally {
      await server.stop(true);
    }
  });
});
