import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REPLIT_GATEWAY_KEY_ENV,
  postReplitPairInstall,
  resolveReplitGatewayKey,
  runInstallReplit,
  type InstallReplitCliDeps,
} from "../src/cli/provider-replit";
import {
  GATEWAY_KEY_MAX_READ_BYTES,
  readBoundedGatewayKeyFile,
  readBoundedGatewayKeyStdin,
} from "../src/cli/replit-gateway-key-input";
import type { CliStdin } from "../src/cli/runtime-api";
import { RuntimeApiError } from "../src/cli/runtime-api";
import {
  REPLIT_ANTHROPIC_PROVIDER_ID,
  REPLIT_OPENAI_PROVIDER_ID,
} from "../src/providers/replit/constants";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli", "index.ts");
const ORIGIN = "https://my-app.replit.app";
const GATEWAY_KEY = "gateway-key-01234567890123456789012";
const SECRET_FILE = "replit-gateway-key.txt";

function freshHome() {
  const dir = mkdtempSync(join(tmpdir(), "ocx-cli-replit-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    port: 10100,
    defaultProvider: "openai",
    providers: {
      openai: { adapter: "openai-chat", baseUrl: "https://api.example.test/v1", apiKey: "sk-test" },
    },
  }), "utf8");
  return dir;
}

function runCli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_HOME: mkdtempSync(join(tmpdir(), "ocx-codex-")), ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
}

describe("resolveReplitGatewayKey", () => {
  test("reads from REPLIT_GATEWAY_KEY when no explicit source flags are set", async () => {
    const key = await resolveReplitGatewayKey([], {
      env: { [REPLIT_GATEWAY_KEY_ENV]: GATEWAY_KEY },
    });
    expect(key).toBe(GATEWAY_KEY);
  });

  test("reads one line from stdin when --stdin is set", async () => {
    let dataHandler: ((chunk: unknown) => void) | undefined;
    const stdin = {
      isTTY: false,
      readableEnded: false,
      on(event: string, handler: (chunk: unknown) => void) {
        if (event === "data") dataHandler = handler;
      },
      removeListener: () => {},
    } as unknown as CliStdin;
    const pending = resolveReplitGatewayKey(["--stdin"], { stdinImpl: stdin });
    dataHandler?.(`${GATEWAY_KEY}\n`);
    await expect(pending).resolves.toBe(GATEWAY_KEY);
  });

  test("reads bounded content from --gateway-key-file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-replit-key-"));
    const path = join(dir, SECRET_FILE);
    writeFileSync(path, `${GATEWAY_KEY}\n`, { mode: 0o600 });
    try {
      const key = await resolveReplitGatewayKey(["--gateway-key-file", path], { env: {} });
      expect(key).toBe(GATEWAY_KEY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects argv gateway key flags without echoing a supplied secret", async () => {
    const leaked = "super-secret-gateway-key-012345678901";
    await expect(resolveReplitGatewayKey(["--gateway-key", leaked], { env: {} }))
      .rejects.toThrow("must not be passed on the command line");
    try {
      await resolveReplitGatewayKey(["--gateway-key", leaked], { env: {} });
    } catch (error) {
      expect(String(error)).not.toContain(leaked);
    }
  });

  test("rejects mixing stdin and file sources", async () => {
    await expect(resolveReplitGatewayKey(["--stdin", "--gateway-key-file", "/tmp/key"], { env: {} }))
      .rejects.toThrow("choose exactly one gateway key source");
  });

  test("rejects overlong REPLIT_GATEWAY_KEY without echoing the secret", async () => {
    const secret = `x${"y".repeat(512)}`;
    await expect(resolveReplitGatewayKey([], { env: { [REPLIT_GATEWAY_KEY_ENV]: secret } }))
      .rejects.toThrow("too large");
    try {
      await resolveReplitGatewayKey([], { env: { [REPLIT_GATEWAY_KEY_ENV]: secret } });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  test("rejects non-printable REPLIT_GATEWAY_KEY without echoing the secret", async () => {
    const secret = `${GATEWAY_KEY}\u007f`;
    await expect(resolveReplitGatewayKey([], { env: { [REPLIT_GATEWAY_KEY_ENV]: secret } }))
      .rejects.toThrow("invalid characters");
    try {
      await resolveReplitGatewayKey([], { env: { [REPLIT_GATEWAY_KEY_ENV]: secret } });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});

describe("bounded gateway key input", () => {
  test("rejects oversized file without echoing path or secret content", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-replit-oversize-"));
    const path = join(dir, SECRET_FILE);
    writeFileSync(path, `${"x".repeat(GATEWAY_KEY_MAX_READ_BYTES + 1)}\n`, { mode: 0o600 });
    try {
      expect(() => readBoundedGatewayKeyFile(path)).toThrow("too large");
      try {
        readBoundedGatewayKeyFile(path);
      } catch (error) {
        const message = String(error);
        expect(message).not.toContain(path);
        expect(message).not.toContain("xxx");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects world-readable key files on POSIX without echoing the path", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "ocx-replit-perms-"));
    const path = join(dir, SECRET_FILE);
    writeFileSync(path, `${GATEWAY_KEY}\n`);
    chmodSync(path, 0o644);
    try {
      expect(() => readBoundedGatewayKeyFile(path)).toThrow("insecure permissions");
      try {
        readBoundedGatewayKeyFile(path);
      } catch (error) {
        expect(String(error)).not.toContain(path);
        expect(String(error)).not.toContain(GATEWAY_KEY);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects oversized stdin before accepting the full line", async () => {
    let dataHandler: ((chunk: unknown) => void) | undefined;
    const stdin = {
      isTTY: false,
      readableEnded: false,
      on(event: string, handler: (chunk: unknown) => void) {
        if (event === "data") dataHandler = handler;
      },
      removeListener: () => {},
    } as unknown as CliStdin;
    const pending = readBoundedGatewayKeyStdin({ stdinImpl: stdin, stdinTimeoutMs: 5_000 });
    dataHandler?.(`${"y".repeat(GATEWAY_KEY_MAX_READ_BYTES + 1)}`);
    await expect(pending).rejects.toThrow("too large");
  });
});

describe("postReplitPairInstall", () => {
  test("posts to /api/providers/replit-pair with admin auth headers", async () => {
    const previousAdmin = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
    const previousData = process.env.OPENCODEX_API_AUTH_TOKEN;
    process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "admin-secret";
    process.env.OPENCODEX_API_AUTH_TOKEN = "data-secret";
    let capturedPath = "";
    let capturedInit: RequestInit | undefined;
    let capturedToken: string | null = null;
    try {
      const result = await postReplitPairInstall({
        origin: ORIGIN,
        gatewayKey: GATEWAY_KEY,
        allowCustomDomain: true,
        replace: false,
        setDefault: true,
      }, {
        baseUrl: "http://127.0.0.1:10100",
        fetchImpl: async (input, init) => {
          capturedPath = new URL(String(input)).pathname;
          capturedInit = init;
          capturedToken = new Headers(init?.headers).get("X-OpenCodex-API-Key");
          return Response.json({
            success: true,
            providers: [REPLIT_OPENAI_PROVIDER_ID, REPLIT_ANTHROPIC_PROVIDER_ID],
            probe: {
              ok: true,
              healthz: { status: 200, latencyMs: 12 },
              models: { status: 200, modelCount: 2, latencyMs: 34 },
            },
          });
        },
      });
      expect(result.ok).toBe(true);
      expect(capturedPath).toBe("/api/providers/replit-pair");
      expect(capturedInit?.method).toBe("POST");
      expect(JSON.parse(String(capturedInit?.body))).toEqual({
        origin: ORIGIN,
        gatewayKey: GATEWAY_KEY,
        allowCustomDomain: true,
        replace: false,
        setDefault: true,
      });
      expect(new Headers(capturedInit?.headers).get("Content-Type")).toBe("application/json");
      expect(capturedToken).toBe("admin-secret");
    } finally {
      if (previousAdmin === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
      else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdmin;
      if (previousData === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
      else process.env.OPENCODEX_API_AUTH_TOKEN = previousData;
    }
  });

  test("maps RuntimeApiError collision and busy bodies without leaking secrets", async () => {
    const collision = await postReplitPairInstall({
      origin: ORIGIN,
      gatewayKey: GATEWAY_KEY,
      allowCustomDomain: false,
      replace: false,
      setDefault: false,
    }, {
      runtimeRequest: async () => {
        throw new RuntimeApiError("replit provider pair already exists", 409, {
          error: "replit provider pair already exists",
          code: "provider_collision",
          collisions: [REPLIT_OPENAI_PROVIDER_ID],
        });
      },
    });
    expect(collision.ok).toBe(false);
    if (!collision.ok) {
      expect(collision.code).toBe("provider_collision");
      expect(collision.error).toContain("already exists");
      expect(JSON.stringify(collision)).not.toContain(GATEWAY_KEY);
    }

    const busy = await postReplitPairInstall({
      origin: ORIGIN,
      gatewayKey: GATEWAY_KEY,
      allowCustomDomain: false,
      replace: false,
      setDefault: false,
    }, {
      runtimeRequest: async () => {
        throw new RuntimeApiError("Configuration is busy", 503, { error: "Configuration is busy", code: "config_busy" });
      },
    });
    expect(busy.ok).toBe(false);
    if (!busy.ok) {
      expect(busy.code).toBe("config_busy");
      expect(busy.error).toContain("busy");
    }
  });

  test("rejects bare {success:true} without treating it as installed", async () => {
    const result = await postReplitPairInstall({
      origin: ORIGIN,
      gatewayKey: GATEWAY_KEY,
      allowCustomDomain: false,
      replace: false,
      setDefault: false,
    }, {
      runtimeRequest: async () => ({ success: true }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("unexpected management response");
  });

  test("rejects success payloads with missing probe fields", async () => {
    const result = await postReplitPairInstall({
      origin: ORIGIN,
      gatewayKey: GATEWAY_KEY,
      allowCustomDomain: false,
      replace: false,
      setDefault: false,
    }, {
      runtimeRequest: async () => ({
        success: true,
        providers: [REPLIT_OPENAI_PROVIDER_ID, REPLIT_ANTHROPIC_PROVIDER_ID],
      }),
    });
    expect(result.ok).toBe(false);
  });

  test("rejects success payloads with wrong probe numeric types", async () => {
    const result = await postReplitPairInstall({
      origin: ORIGIN,
      gatewayKey: GATEWAY_KEY,
      allowCustomDomain: false,
      replace: false,
      setDefault: false,
    }, {
      runtimeRequest: async () => ({
        success: true,
        providers: [REPLIT_OPENAI_PROVIDER_ID, REPLIT_ANTHROPIC_PROVIDER_ID],
        probe: {
          ok: true,
          healthz: { status: 200, latencyMs: "10" },
          models: { status: 200, modelCount: 2, latencyMs: 20 },
        },
      }),
    });
    expect(result.ok).toBe(false);
  });
});

describe("runInstallReplit", () => {
  let home = "";
  const logs: string[] = [];
  const errors: string[] = [];
  let requestBody: Record<string, unknown> | null = null;

  const deps = (): InstallReplitCliDeps => ({
    env: { OPENCODEX_HOME: home, [REPLIT_GATEWAY_KEY_ENV]: GATEWAY_KEY, OPENCODEX_ADMIN_AUTH_TOKEN: "admin-secret" },
    log: line => { logs.push(line); },
    error: line => { errors.push(line); },
    runtimeRequest: async (_path, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return {
        success: true,
        providers: [REPLIT_OPENAI_PROVIDER_ID, REPLIT_ANTHROPIC_PROVIDER_ID],
        probe: {
          ok: true,
          healthz: { status: 200, latencyMs: 12 },
          models: { status: 200, modelCount: 2, latencyMs: 34 },
        },
      };
    },
  });

  beforeEach(() => {
    home = freshHome();
    logs.length = 0;
    errors.length = 0;
    requestBody = null;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("installs the pair through runtimeRequest with origin and env-based gateway key", async () => {
    const code = await runInstallReplit(["--origin", ORIGIN, "--json"], deps());
    expect(code).toBe(0);
    expect(requestBody).toEqual({
      origin: ORIGIN,
      gatewayKey: GATEWAY_KEY,
      allowCustomDomain: false,
      replace: false,
      setDefault: false,
    });
    const payload = JSON.parse(logs[0]!);
    expect(payload.success).toBe(true);
    expect(payload.providers).toEqual([REPLIT_OPENAI_PROVIDER_ID, REPLIT_ANTHROPIC_PROVIDER_ID]);
    expect(payload.probe.healthz.status).toBe(200);
    expect(JSON.stringify(payload)).not.toContain(GATEWAY_KEY);
  });

  test("maps provider_collision without echoing the gateway key", async () => {
    const code = await runInstallReplit(["--origin", ORIGIN], {
      ...deps(),
      runtimeRequest: async () => {
        throw new RuntimeApiError("replit provider pair already exists", 409, {
          error: "replit provider pair already exists",
          code: "provider_collision",
          collisions: [REPLIT_OPENAI_PROVIDER_ID, REPLIT_ANTHROPIC_PROVIDER_ID],
        });
      },
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("already exists");
    expect(errors.join("\n")).toContain("--replace");
    expect(errors.join("\n")).not.toContain(GATEWAY_KEY);
  });

  test("passes replace and allowCustomDomain flags through to the management API", async () => {
    const code = await runInstallReplit([
      "--origin", "https://gateway.example.com",
      "--allow-custom-domain",
      "--replace",
      "--set-default",
    ], deps());
    expect(code).toBe(0);
    expect(requestBody).toMatchObject({
      origin: "https://gateway.example.com",
      allowCustomDomain: true,
      replace: true,
      setDefault: true,
    });
  });

  test("maps config_busy to a retry hint without secrets", async () => {
    const code = await runInstallReplit(["--origin", ORIGIN], {
      ...deps(),
      runtimeRequest: async () => {
        throw new RuntimeApiError("Configuration is busy; retry shortly", 503, { error: "Configuration is busy; retry shortly", code: "config_busy" });
      },
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("busy");
    expect(errors.join("\n")).not.toContain(GATEWAY_KEY);
  });

  test("survives malformed success DTO without throwing or echoing secrets", async () => {
    const code = await runInstallReplit(["--origin", ORIGIN], {
      ...deps(),
      runtimeRequest: async () => ({ success: true }),
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("unexpected management response");
    expect(errors.join("\n")).not.toContain(GATEWAY_KEY);
  });
});

describe("ocx provider install-replit spawn guards", () => {
  test("rejects --gateway-key without echoing the secret", () => {
    const secret = "argv-secret-gateway-key-012345678901";
    const result = runCli([
      "provider", "install-replit",
      "--origin", ORIGIN,
      "--gateway-key", secret,
    ], { OPENCODEX_HOME: freshHome() });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(secret);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/command line|argv/i);
  });

  test("help mentions install-replit and safe secret input", () => {
    const registryHelp = runCli(["provider", "help"]);
    expect(registryHelp.status).toBe(0);
    expect(registryHelp.stdout).toContain("install-replit");
    expect(registryHelp.stdout).toMatch(/REPLIT_GATEWAY_KEY|--stdin|--gateway-key-file/);

    const fullHelp = runCli(["provider"]);
    expect(fullHelp.status).toBe(0);
    expect(fullHelp.stdout).toContain("install-replit");
    expect(fullHelp.stdout).toMatch(/REPLIT_GATEWAY_KEY|--stdin|--gateway-key-file/);
  });
});
