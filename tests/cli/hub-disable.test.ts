import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disableHubConfig, parseHubDisableArgs, runHubDisable } from "../../src/cli/hub-disable";
import type { OcxConfig } from "../../src/types";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

const key = (id: string, name = "ocx connect fixture") => ({
  id, name, key: ["ocx", "data", "a".repeat(40)].join("_"), createdAt: "2026-01-01T00:00:00.000Z",
  pendingRotation: { id: "rotate", key: ["ocx", "data", "b".repeat(40)].join("_"), createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-02T00:00:00.000Z" },
});
const config = (): OcxConfig => ({
  port: 10100, runtimeRole: "hub", hostname: "100.64.0.10",
  providers: { fixture: { adapter: "openai-chat", baseUrl: "https://fixture.example.test" } }, defaultProvider: "fixture",
  hub: { managementIngress: { enabled: true, port: 10102 }, managementPublicOrigin: "https://hub.example.test" },
  unauthenticatedLoopbackListener: { enabled: true, port: 10103 },
  apiKeys: [key("client"), key("integration", "existing integration")],
  logLevel: "debug",
} as OcxConfig);

test("disable argument grammar requires explicit revocation and exact unique IDs", () => {
  expect(parseHubDisableArgs([])).toEqual({ json: false, revokeClients: false, clientKeys: [] });
  expect(parseHubDisableArgs(["--client-key", "client", "--revoke-clients", "--json"])).toMatchObject({ clientKeys: ["client"], revokeClients: true, json: true });
  for (const args of [["--client-key", "client"], ["--revoke-clients", "--client-key"], ["--json", "--json"], ["--yes"], ["--revoke-clients", "--client-key", "client", "--client-key", "client"]]) {
    expect(() => parseHubDisableArgs(args)).toThrow();
  }
});

test("hub disable retains saved keys by default and removes all interdependent bindings together", () => {
  const cfg = config();
  const beforeKeys = structuredClone(cfg.apiKeys);
  const result = disableHubConfig(cfg, parseHubDisableArgs([]));
  expect(result.removed).toEqual(["hub", "unauthenticatedLoopbackListener", "runtimeRole", "hostname"]);
  for (const field of result.removed) expect(cfg).not.toHaveProperty(field);
  expect(cfg.apiKeys).toEqual(beforeKeys);
  expect(cfg.port).toBe(10100);
  expect(cfg.logLevel).toBe("debug");
  expect(result.keys).toEqual([
    { id: "client", name: "ocx connect fixture", createdAt: "2026-01-01T00:00:00.000Z", revoked: false },
    { id: "integration", name: "existing integration", createdAt: "2026-01-01T00:00:00.000Z", revoked: false },
  ]);
  expect(result.revoked).toEqual([]);
  expect(JSON.stringify(result)).not.toContain(beforeKeys![0]!.key);
  expect(JSON.stringify(result)).not.toContain(beforeKeys![0]!.pendingRotation!.key);
});

test("explicit revocation removes only the selected IDs, even when names collide", () => {
  const cfg = config(); cfg.apiKeys![1]!.name = cfg.apiKeys![0]!.name;
  expect(disableHubConfig(cfg, parseHubDisableArgs(["--revoke-clients", "--client-key", "client"])).revoked).toEqual(["client"]);
  expect(cfg.apiKeys!.map(entry => entry.id)).toEqual(["integration"]);
});

test("metadata containing an actual data key or pending rotation never exposes it", () => {
  const cfg = config();
  const secret = cfg.apiKeys![0]!.key, pending = cfg.apiKeys![0]!.pendingRotation!.key;
  cfg.apiKeys![0]!.name = "client " + secret;
  cfg.apiKeys![0]!.createdAt = pending;
  const result = disableHubConfig(cfg, parseHubDisableArgs([]));
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain(pending);
  expect(result.keys[0]).toMatchObject({ name: "client [REDACTED]", createdAt: "[REDACTED]" });
});

test("ambiguous origin, stale IDs and non-hub modes refuse before changes", () => {
  for (const args of [["--revoke-clients"], ["--revoke-clients", "--client-key", "missing"]]) {
    const cfg = config(); const before = structuredClone(cfg);
    expect(() => disableHubConfig(cfg, parseHubDisableArgs(args))).toThrow();
    expect(cfg).toEqual(before);
  }
  for (const role of [undefined, "standalone", "client"] as const) {
    const cfg = config(); cfg.runtimeRole = role; const before = structuredClone(cfg);
    expect(() => disableHubConfig(cfg, parseHubDisableArgs([]))).toThrow();
    expect(cfg).toEqual(before);
  }
});

test("post-removal schema failure never publishes partial changes", () => {
  const cfg = config(); cfg.client = {} as NonNullable<OcxConfig["client"]>;
  const before = structuredClone(cfg);
  expect(() => disableHubConfig(cfg, parseHubDisableArgs([]))).toThrow();
  expect(cfg).toEqual(before);
});

test("a hub without client keys accepts the explicit revoke flag", () => {
  const cfg = config(); delete cfg.apiKeys;
  expect(disableHubConfig(cfg, parseHubDisableArgs(["--revoke-clients"]))).toMatchObject({ keys: [], revoked: [] });
});

test("unavailable persisted config produces nonzero without restart or output success", async () => {
  let hints = 0;
  const error = console.error; console.error = () => {};
  try {
    expect(await runHubDisable([], { mutateConfig: () => ({ status: "unavailable", reason: "conflict" }), restartHint: () => { hints++; return "restart"; } })).not.toBe(0);
    expect(hints).toBe(0);
  } finally { console.error = error; }
});

test("CLI writes one valid standalone snapshot with selected revocation and deletion provenance", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-hub-disable-"));
  const path = join(dir, "config.json");
  try {
    const original = config(); writeFileSync(path, JSON.stringify(original));
    const env = { ...process.env, HOME: dir, USERPROFILE: dir, OPENCODEX_HOME: dir, CODEX_HOME: join(dir, "codex") };
    const result = spawnSync(process.execPath, [repoPath("src", "cli", "index.ts"), "hub", "disable", "--revoke-clients", "--client-key", "client", "--json"], {
      cwd: repoRoot(), env, encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5000,
    });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({ ok: true, revoked: ["client"], keyOrigin: "unverified", effectiveAfterRestart: true });
    expect(result.stdout + result.stderr).not.toContain(original.apiKeys![0]!.key);
    expect(result.stdout + result.stderr).not.toContain(original.apiKeys![0]!.pendingRotation!.key);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    for (const field of ["hub", "unauthenticatedLoopbackListener", "runtimeRole", "hostname"]) expect(saved).not.toHaveProperty(field);
    expect(saved.configRebaseProvenance.deletedTopLevelKeys).toEqual(["hostname", "hub", "runtimeRole", "unauthenticatedLoopbackListener"]);
    expect(saved.apiKeys.map((entry: { id: string }) => entry.id)).toEqual(["integration"]);
    expect(saved.logLevel).toBe("debug");
    const beforeRetry = readFileSync(path, "utf8");
    const retry = spawnSync(process.execPath, [repoPath("src", "cli", "index.ts"), "hub", "disable", "--json"], { cwd: repoRoot(), env, encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5000 });
    expect(retry.status).not.toBe(0);
    expect(readFileSync(path, "utf8")).toBe(beforeRetry);
  } finally { removeTreeWithRetry(dir); }
}, SPAWN_BUDGET_MS);

test("a racing key deletion is revalidated without publishing hub removal", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-hub-disable-race-"));
  const path = join(dir, "config.json");
  try {
    writeFileSync(path, JSON.stringify(config()));
    const script = `
      import { readFileSync, writeFileSync } from "node:fs";
      import { getConfigPath } from "./src/config";
      import { setPersistedConfigMutationBeforeCommitForTests } from "./src/config/persisted-mutation";
      import { runHubDisable } from "./src/cli/hub-disable";
      setPersistedConfigMutationBeforeCommitForTests(() => {
        const path = getConfigPath(), fresh = JSON.parse(readFileSync(path, "utf8"));
        fresh.apiKeys = fresh.apiKeys.filter(key => key.id !== "client");
        fresh.logLevel = "info";
        writeFileSync(path, JSON.stringify(fresh));
      });
      process.exitCode = await runHubDisable(["--revoke-clients", "--client-key", "client", "--json"]);
    `;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: repoRoot(), encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5000,
      env: { ...process.env, OPENCODEX_HOME: dir, CODEX_HOME: join(dir, "codex") },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("selected client key ID is not in the current config");
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.runtimeRole).toBe("hub");
    expect(saved.hub.managementIngress.enabled).toBe(true);
    expect(saved.apiKeys.map((entry: { id: string }) => entry.id)).toEqual(["integration"]);
    expect(saved.logLevel).toBe("info");
  } finally { removeTreeWithRetry(dir); }
}, SPAWN_BUDGET_MS);
