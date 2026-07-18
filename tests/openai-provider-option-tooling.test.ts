import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceDenyFindings, scanEvidence } from "../scripts/openai-provider-option-evidence-scan";
import { runGateSequence, type GateResult, type GateSpec } from "../scripts/openai-provider-option-final-gates";
import { evaluateLivePolicy, type LiveOutcome } from "../scripts/openai-hardening-live-policy";
import { buildSanitizedRuntimeEnv } from "../scripts/openai-hardening-runtime-env";
import { buildUnixCodexShim } from "../src/codex/shim";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function validArtifacts(): { root: string; paths: string[] } {
  const root = mkdtempSync(join(tmpdir(), "ocx-provider-option-evidence-"));
  roots.push(root);
  writeJson(join(root, "030_e2e.json"), {
    schemaVersion: 1,
    verdict: "PASS",
    publicNetworkFallback: false,
    poolDefault: "PASS",
    directIsolation: "PASS",
    http: "PASS",
    websocket: "PASS",
    compact: "PASS",
    apiProIsolation: "PASS",
    migrationRestore: "PASS",
    oneOpenAiModelGroup: "PASS",
    realClaudeStateUnchanged: true,
  });
  writeJson(join(root, "030_client_history.json"), {
    schemaVersion: 1,
    verdict: "PASS",
    selectedModel: "openai-apikey/gpt-5.6-sol-pro",
    modelProvider: "openai",
    resolvedModel: "gpt-5.6-sol",
    reasoningMode: "pro",
    rolloutCount: 1,
    attempts: 1,
  });
  writeJson(join(root, "030_runtime_smoke.json"), {
    schemaVersion: 1,
    verdict: "PASS",
    instances: [{ pid: 101, version: "test", port: 45001 }, { pid: 102, version: "test", port: 45002 }],
    distinctPids: true,
    catalogReady: true,
    poolDefault: {
      providerName: "openai",
      accountMode: "pool",
      selectedModel: "gpt-5.6-sol",
      wireModel: "gpt-5.6-sol",
      upstream: "chatgpt.com/backend-api/codex",
      credentialOwner: "added",
      safeAccountOwner: "added",
    },
    direct: {
      providerName: "openai",
      accountMode: "direct",
      selectedModel: "gpt-5.6-terra",
      wireModel: "gpt-5.6-terra",
      upstream: "chatgpt.com/backend-api/codex",
      credentialOwner: "caller",
      safeAccountOwner: null,
    },
    apiPro: {
      providerName: "openai-apikey",
      accountMode: null,
      selectedModel: "openai-apikey/gpt-5.6-sol-pro",
      wireModel: "gpt-5.6-sol",
      upstream: "api.openai.com/v1",
      credentialOwner: "api-key",
      safeAccountOwner: null,
      reasoningMode: "pro",
    },
    oneOpenAiModelGroup: true,
    clientHistoryVerified: true,
    codexVersion: "test",
    userStateUnchanged: true,
    live10100Unchanged: true,
    liveKey: { status: "NOT RUN (credential unavailable)", liveCalls: 0, outcomes: [] },
  });
  writeFileSync(join(root, "030_gate_summary.txt"), "schemaVersion=1\nverdict=PASS\ncommand[0]=tests|exit=0|pass=3|fail=0|build=na\n");
  return {
    root,
    paths: ["030_e2e.json", "030_client_history.json", "030_runtime_smoke.json", "030_gate_summary.txt"]
      .map(name => join(root, name)),
  };
}

function liveOutcome(selectedId: string, status = 200, resolvedId = "gpt-5.6-sol"): LiveOutcome {
  return { status, requestId: null, selectedId, resolvedId };
}

describe("OpenAI provider-option evidence scanner", () => {
  test("accepts the four strict artifacts by path list or evidence directory", () => {
    const fixture = validArtifacts();
    expect(scanEvidence(fixture.paths)).toEqual([]);
    expect(scanEvidence([fixture.root])).toEqual([]);
  });

  test("detects every denied evidence class", () => {
    const rows: Array<[string, string]> = [
      ["absolute-home", "/Users/test/private"],
      ["temporary-path", "/private/var/folders/aa/private"],
      ["email", "owner@example.test"],
      ["bearer", "Bearer bad"],
      ["api-key", "sk-abcdefghijkl"],
      ["jwt", "eyJa.eyJb.sig"],
      ["prompt", "Reply exactly"],
      ["fixture-secret", "fixture-refresh-token"],
    ];
    for (const [kind, value] of rows) expect(evidenceDenyFindings(value)).toContain(kind);
  });

  test("rejects missing fields, secret leaks, stale absolute paths, and unknown keys", () => {
    const missing = validArtifacts();
    const e2e = JSON.parse(readFileSync(missing.paths[0]!, "utf8")) as Record<string, unknown>;
    delete e2e.poolDefault;
    writeJson(missing.paths[0]!, e2e);
    expect(scanEvidence(missing.paths).some(error => error.includes("unknown or missing keys"))).toBe(true);

    const secret = validArtifacts();
    const runtimeSecret = JSON.parse(readFileSync(secret.paths[2]!, "utf8")) as Record<string, unknown>;
    (runtimeSecret.poolDefault as Record<string, unknown>).credentialOwner = "fixture-pool-access";
    writeJson(secret.paths[2]!, runtimeSecret);
    expect(scanEvidence(secret.paths).some(error => error.includes("fixture-secret"))).toBe(true);

    const pathLeak = validArtifacts();
    const client = JSON.parse(readFileSync(pathLeak.paths[1]!, "utf8")) as Record<string, unknown>;
    client.selectedModel = "/Users/test/private/model";
    writeJson(pathLeak.paths[1]!, client);
    expect(scanEvidence(pathLeak.paths).some(error => error.includes("absolute-home"))).toBe(true);

    const unknown = validArtifacts();
    const unknownE2e = JSON.parse(readFileSync(unknown.paths[0]!, "utf8")) as Record<string, unknown>;
    unknownE2e.unexpected = true;
    writeJson(unknown.paths[0]!, unknownE2e);
    expect(scanEvidence(unknown.paths).some(error => error.includes("unknown or missing keys"))).toBe(true);
  });

  test("rejects the wrong live-key policy and a failed gate summary", () => {
    const policy = validArtifacts();
    const runtime = JSON.parse(readFileSync(policy.paths[2]!, "utf8")) as Record<string, unknown>;
    (runtime.liveKey as Record<string, unknown>).liveCalls = 2;
    writeJson(policy.paths[2]!, runtime);
    expect(scanEvidence(policy.paths).some(error => error.includes("wrong live-key policy"))).toBe(true);

    const summary = validArtifacts();
    writeFileSync(summary.paths[3]!, "schemaVersion=1\nverdict=FAIL\ncommand[0]=tests|exit=1|pass=0|fail=1|build=na\n");
    expect(scanEvidence(summary.paths).some(error => error.includes("invalid summary schema"))).toBe(true);
  });
});

describe("OpenAI provider-option final gate runner", () => {
  test("runs once in order, writes one sanitized summary, then scans", async () => {
    const order: string[] = [];
    const writes: string[] = [];
    const plan: GateSpec[] = [{ name: "one", command: ["one"] }, { name: "two", command: ["two"] }];
    const results: Record<string, GateResult> = {
      one: { exitCode: 0, output: "3 pass\nraw-private-output" },
      two: { exitCode: 0, output: "built in 1ms\n" },
    };
    const summary = await runGateSequence(plan, {
      run: async gate => { order.push(`run:${gate.name}`); return results[gate.name]!; },
      writeSummary: text => { order.push("write"); writes.push(text); },
      scan: () => { order.push("scan"); return []; },
    });
    expect(order).toEqual(["run:one", "run:two", "write", "scan"]);
    expect(writes).toHaveLength(1);
    expect(summary).not.toContain("raw-private-output");
    expect(summary).toContain("command[0]=one|exit=0|pass=3|fail=na|build=na");
    expect(summary).toContain("command[1]=two|exit=0|pass=na|fail=na|build=pass");
  });

  test("stops on the first failure without publishing or scanning", async () => {
    const order: string[] = [];
    await expect(runGateSequence([
      { name: "one", command: ["one"] },
      { name: "broken", command: ["broken"] },
      { name: "never", command: ["never"] },
    ], {
      run: async gate => {
        order.push(gate.name);
        return { exitCode: gate.name === "broken" ? 7 : 0, output: "" };
      },
      writeSummary: () => order.push("write"),
      scan: () => { order.push("scan"); return []; },
    })).rejects.toThrow("gate failed: broken (7)");
    expect(order).toEqual(["one", "broken"]);
  });
});

describe("OpenAI provider-option live policy and runtime isolation", () => {
  const base = liveOutcome("openai-apikey/gpt-5.6-sol");
  const pro = liveOutcome("openai-apikey/gpt-5.6-sol-pro");

  test("covers unavailable, unauthorized, successful, failed, and mismatched live decisions", () => {
    expect(evaluateLivePolicy(false, false, [])).toEqual({ status: "NOT RUN (credential unavailable)", liveCalls: 0, failed: false });
    expect(evaluateLivePolicy(true, false, [])).toEqual({ status: "NOT RUN (live spend not authorized)", liveCalls: 0, failed: false });
    expect(evaluateLivePolicy(true, true, [base, pro])).toEqual({ status: "LIVE PASS", liveCalls: 2, failed: false });
    expect(evaluateLivePolicy(true, true, [{ ...base, status: 500 }, pro]).failed).toBe(true);
    expect(evaluateLivePolicy(true, true, [base, { ...pro, status: 500 }]).failed).toBe(true);
    expect(evaluateLivePolicy(true, true, [base, { ...pro, resolvedId: "wrong" }]).failed).toBe(true);
    expect(evaluateLivePolicy(true, true, [{ ...base, selectedId: "wrong" }, pro]).failed).toBe(true);
  });

  test("removes credential and proxy sentinels while preserving safe process state", () => {
    const source = {
      PATH: "/bin",
      OPENAI_API_KEY: "sentinel",
      openai_base_url: "sentinel",
      CODEX_HOME: "sentinel",
      codex_api_key: "sentinel",
      OPENCODEX_HOME: "sentinel",
      opencodex_base_url: "sentinel",
      HTTP_PROXY: "sentinel",
      https_proxy: "sentinel",
      ALL_PROXY: "sentinel",
      all_proxy: "sentinel",
    };
    const env = buildSanitizedRuntimeEnv(source, "/tmp/ocx", "/tmp/codex");
    expect(env.PATH).toBe("/bin");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.openai_base_url).toBeUndefined();
    expect(env.codex_api_key).toBeUndefined();
    expect(env.opencodex_base_url).toBeUndefined();
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.https_proxy).toBeUndefined();
    expect(env.ALL_PROXY).toBeUndefined();
    expect(env.all_proxy).toBeUndefined();
    expect(env.OPENCODEX_HOME).toBe("/tmp/ocx");
    expect(env.CODEX_HOME).toBe("/tmp/codex");
    expect(env.NO_PROXY).toBe("127.0.0.1,localhost,::1");
    expect(env.no_proxy).toBe("127.0.0.1,localhost,::1");
    expect(env.OCX_SHIM_BYPASS).toBe("1");
  });

  test("keeps the fixture admission token through an installed Unix shim without reading its token file", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "ocx-runtime-shim-isolation-"));
    roots.push(root);
    const tokenFile = join(root, "service-token");
    const realCodex = join(root, "codex-real");
    const shim = join(root, "codex");
    writeFileSync(tokenFile, "real-state-sentinel\n", { mode: 0o600 });
    writeFileSync(realCodex, "#!/bin/sh\nprintf '%s\\n' \"$OPENCODEX_API_AUTH_TOKEN\"\n", { mode: 0o700 });
    writeFileSync(shim, buildUnixCodexShim(realCodex, process.execPath, "/fixture/cli.ts", tokenFile), { mode: 0o700 });
    chmodSync(realCodex, 0o700);
    chmodSync(shim, 0o700);

    const env = buildSanitizedRuntimeEnv({ PATH: process.env.PATH }, "/tmp/ocx", "/tmp/codex");
    const result = Bun.spawnSync([shim, "--version"], { env, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout).trim()).toBe("fixture-admission");
    expect(new TextDecoder().decode(result.stdout)).not.toContain("real-state-sentinel");
  });
});
