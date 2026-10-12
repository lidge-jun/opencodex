import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { handleRoutePolicyWriteCommand } from "../../src/cli/route-policy-write";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath, repoRoot } from "../helpers/repo-root";

const sentinel = "synthetic-private-profile-value";
const committed = { status: "committed", changed: true, degraded: false, notices: [] };
let home: string, previousHome: string | undefined, codexHome: IsolatedCodexHome;
let stdout: string[], stderr: string[], calls: { url: string; init: RequestInit }[], probes: number;
let response: unknown, status: number;
let logSpy: ReturnType<typeof spyOn>, errorSpy: ReturnType<typeof spyOn>, networkSpy: ReturnType<typeof spyOn>;
function editable() { return { candidates: [{ provider: "alpha", model: "model/raw" }] }; }
function receipt() {
  return { success: true, id: "balanced", model: "policy/balanced", profile: {
    id: "balanced", model: "policy/balanced", revision: "opaque-next-revision", alias: null,
    ...editable(), require: {}, optimize: { latency: 0.55, health: 0.25, cost: 0.1, quota: 0.1 },
    limits: {}, unknownEvidence: { capability: "exclude", health: "penalize", quota: "penalize", cost: "penalize" },
  }, catalogRefresh: committed };
}
function file(value: unknown = editable()) {
  const path = join(home, "profile.json"); writeFileSync(path, JSON.stringify(value)); return path;
}
function deps(extra: Partial<RuntimeApiDeps> = {}): RuntimeApiDeps {
  return {
    findLiveProxy: async () => {
      probes++; return { pid: 42, port: probes === 1 ? 19481 : 19482, hostname: "127.0.0.1", source: "runtime" };
    },
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} }); return Response.json(response, { status });
    }) as typeof fetch, ...extra,
  };
}
function noEcho() { expect(stdout.join("\n") + stderr.join("\n")).not.toContain(sentinel); }
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-cli-policy-write-")); process.env.OPENCODEX_HOME = home;
  codexHome = installIsolatedCodexHome("ocx-cli-policy-write-codex-");
  stdout = []; stderr = []; calls = []; probes = 0; status = 200; response = receipt();
  logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => { stdout.push(args.join(" ")); });
  errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => { stderr.push(args.join(" ")); });
  networkSpy = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network denied by policy test"); });
});
afterEach(() => {
  logSpy.mockRestore(); errorSpy.mockRestore(); networkSpy.mockRestore(); codexHome.restore();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

describe("routing profile write input", () => {
  const invalidArgs: ["create" | "update" | "remove", string[]][] = [
    ["create", []], ["create", [" ", "--file", "-"]], ["create", ["policy/balanced", "--file", "-"]],
    ["create", ["balanced"]], ["create", ["balanced", "--file"]], ["create", ["balanced", "--file", " "]],
    ["create", ["balanced", "--file", "-", "--file=-"]],
    ["create", ["balanced", "--file", "-", "--json", "--json"]],
    ["create", ["balanced", "--file", "-", "--yes"]],
    ["create", ["balanced", "--file", "-", "--expected-revision", "old"]],
    ["update", ["balanced", "--file", "-"]],
    ["update", ["balanced", "--file", "-", "--expected-revision"]],
    ["update", ["balanced", "--file", "-", "--expected-revision", " "]],
    ["update", ["balanced", "--file", "-", "--expected-revision", "one", "--expected-revision=two"]],
    ["remove", ["balanced"]], ["remove", ["balanced", "--yes", "--yes"]],
    ["remove", ["balanced", "--yes", "--file", "-"]],
    ["remove", ["balanced", "--yes", "--expected-revision", "old"]],
    ["create", ["balanced", "--file", "-", "--unknown", sentinel]],
  ];
  for (const [index, [sub, args]] of invalidArgs.entries()) {
    test(`rejects conflicting or missing arguments before input and discovery (${index})`, async () => {
      const stdin = new Readable({ read() { throw new Error("stdin must not be read"); } });
      expect(await handleRoutePolicyWriteCommand(sub, args, deps({ stdinImpl: stdin }))).toBe(2);
      expect(calls).toEqual([]); expect(probes).toBe(0); expect(stdout).toEqual([]);
      expect(stdin.listenerCount("data")).toBe(0); noEcho(); stdin.destroy();
    });
  }
  const badProfiles: unknown[] = [
    null, [], {}, { candidates: [] }, { candidates: [null] }, { candidates: [{ provider: "alpha" }] },
    { ...editable(), id: sentinel }, { ...editable(), model: sentinel }, { ...editable(), revision: sentinel },
    { ...editable(), unexpected: sentinel }, { ...editable(), alias: null },
    { candidates: [{ provider: "alpha", model: "m", apiKey: sentinel }] },
    { ...editable(), require: [] }, { ...editable(), require: { typo: sentinel } },
    { ...editable(), require: { tools: "false" } }, { ...editable(), require: { minContextWindow: 0 } },
    { ...editable(), require: { minQuotaHeadroom: 1.01 } }, { ...editable(), require: { serviceTier: 1 } },
    { ...editable(), optimize: { latency: -1 } }, { ...editable(), optimize: { other: sentinel } },
    { ...editable(), limits: { onUnknownCost: "penalize" } }, { ...editable(), limits: { maxEstimatedCostUsd: -1 } },
    { ...editable(), limits: { secret: sentinel } }, { ...editable(), unknownEvidence: { latency: "allow" } },
    { ...editable(), unknownEvidence: { cost: "ignore" } }, { ...editable(), compatibility: { extra: sentinel } },
    { ...editable(), compatibility: { requiredSuites: [{ suiteId: "s", evidenceLayer: "unsupported" }] } },
    { ...editable(), compatibility: { requiredSuites: [{ suiteId: "s", evidenceLayer: "protocol_conformance", key: sentinel }] } },
    { ...editable(), compatibility: { minStatus: "UNVERIFIED" } }, { ...editable(), compatibility: { maxEvidenceAgeMs: -1 } },
  ];
  for (const [index, profile] of badProfiles.entries()) {
    test(`refuses noneditable fields and wrong nested shape (${index})`, async () => {
      expect(await handleRoutePolicyWriteCommand("create", ["balanced", "--file", file(profile), "--json"], deps())).toBe(2);
      expect(calls).toEqual([]); expect(probes).toBe(0); expect(stdout).toEqual([]); noEcho();
    });
  }
  test("uses bounded JSON input and static parse errors", async () => {
    const path = join(home, "bad.json"); writeFileSync(path, `{${sentinel}`);
    expect(await handleRoutePolicyWriteCommand("create", ["balanced", "--file", path], deps())).toBe(2);
    expect(calls).toEqual([]); expect(probes).toBe(0); noEcho();
  });
});

describe("routing profile wire contract and output", () => {
  test("sends the complete editable document in one pinned create without config reads", async () => {
    const profile = { ...editable(), alias: "", require: { tools: false, imageInput: true, structuredOutput: false,
      minContextWindow: 64000, minQuotaHeadroom: 0.25, localOnly: false, remoteAllowed: true,
      encryptedCodexTasks: true, reasoningEffort: "high", serviceTier: "default" },
      optimize: { latency: 2, health: 1, cost: 0, quota: 0 }, limits: { maxEstimatedCostUsd: 0.1, onUnknownCost: "exclude" },
      unknownEvidence: { capability: "exclude", health: "penalize", quota: "allow", cost: "penalize" },
      compatibility: { requiredSuites: [{ suiteId: "responses-core", evidenceLayer: "protocol_conformance" }],
        minStatus: "VERIFIED", maxEvidenceAgeMs: 0, unknownEvidence: "exclude", degradedEvidence: "allow" },
    };
    const args = ["balanced", `--file=${file(profile)}`, "--json"];
    expect(await handleRoutePolicyWriteCommand("create", args, deps())).toBe(0);
    expect(args).toHaveLength(3); expect(calls).toHaveLength(1); expect(probes).toBe(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:19481/api/routing-profiles");
    expect(calls[0]?.init.method).toBe("PUT"); expect(calls[0]?.init.redirect).toBe("error");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ id: "balanced", mode: "create", profile });
    expect(JSON.parse(stdout.join("\n"))).toEqual(receipt()); expect(stderr).toEqual([]);
  });
  test("sends the caller's opaque revision unchanged; stdin is explicit", async () => {
    const revision = "  opaque caller revision/+?  ";
    const stdin = Readable.from([Buffer.from(JSON.stringify(editable()))]);
    expect(await handleRoutePolicyWriteCommand("update", ["balanced", "--file", "-", "--expected-revision", revision, "--json"], deps({ stdinImpl: stdin }))).toBe(0);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ id: "balanced", mode: "update", expectedRevision: revision, profile: editable() });
    expect(calls).toHaveLength(1); expect(probes).toBe(1); expect(stdin.listenerCount("data")).toBe(0);
  });
  test("confirmed deletion sends one exact id query and no revision or body", async () => {
    response = { success: true, id: "balanced", catalogRefresh: committed };
    expect(await handleRoutePolicyWriteCommand("remove", ["balanced", "--yes", "--json"], deps())).toBe(0);
    expect(calls).toHaveLength(1); expect(probes).toBe(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:19481/api/routing-profiles?id=balanced");
    expect(calls[0]?.init).toMatchObject({ method: "DELETE", redirect: "error" }); expect(calls[0]?.init.body).toBeUndefined();
    expect(JSON.parse(stdout.join("\n"))).toEqual(response);
  });
  for (const [http, code, exit] of [[409, "profile_exists", 5], [409, "profile_revision_conflict", 5], [404, "unknown_profile", 4],
    [400, "invalid_profile", 1], [409, "alias_reference_conflict", 5], [400, "invalid_shadow_call_target", 1], [503, "private_code", 1]] as const) {
    test(`maps ${code} to fixed diagnostics/exit ${exit} without retry`, async () => {
      status = http; response = { error: { code, message: sentinel, issues: [{ message: sentinel }], currentRevision: sentinel } };
      expect(await handleRoutePolicyWriteCommand("update", ["balanced", "--file", file(), "--expected-revision", "stale", "--json"], deps())).toBe(exit);
      expect(calls).toHaveLength(1); expect(stdout).toEqual([]); expect(stderr.length).toBeGreaterThan(0); noEcho();
    });
  }
  test("transport failure cannot expose response details or trigger retries", async () => {
    expect(await handleRoutePolicyWriteCommand("create", ["balanced", "--file", file()], deps({
      fetchImpl: (async () => { throw new Error(sentinel); }) as typeof fetch,
    }))).toBe(1); expect(stdout).toEqual([]); expect(probes).toBe(1); noEcho();
  });
  for (const refresh of [{ ...committed, degraded: true }, { status: "failed", reason: "internal", phase: "gather", retryable: true, partialWrite: false },
    { status: "skipped", reason: "not-requested", retryable: false }]) {
    test(`preserves saved profile and returns nonzero for ${refresh.status}/${refresh.degraded ?? false}`, async () => {
      response = { ...receipt(), catalogRefresh: refresh };
      expect(await handleRoutePolicyWriteCommand("create", ["balanced", "--file", file(), "--json"], deps())).toBe(1);
      expect(JSON.parse(stdout.join("\n"))).toMatchObject({ success: true, id: "balanced", profile: { revision: "opaque-next-revision" } });
      expect(calls).toHaveLength(1);
    });
  }
  const malformed: unknown[] = [null, {}, { ...receipt(), success: false }, { ...receipt(), id: "other" },
    { ...receipt(), model: "other" }, { ...receipt(), profile: { ...receipt().profile, id: "other" } },
    { ...receipt(), profile: { ...receipt().profile, revision: "" } },
    { ...receipt(), profile: { ...receipt().profile, require: { raw: sentinel } } },
    { ...receipt(), profile: { ...receipt().profile, candidates: [{ provider: "alpha", model: "m", key: sentinel }] } },
    { ...receipt(), profile: { ...receipt().profile, unknownEvidence: {} } },
    { ...receipt(), catalogRefresh: null }, { ...receipt(), catalogRefresh: undefined },
    { ...receipt(), catalogRefresh: { status: "unexpected", raw: sentinel } }, { ...receipt(), raw: sentinel }];
  for (const [index, value] of malformed.entries()) {
    test(`refuses malformed or unexpected success body (${index})`, async () => {
      response = value;
      expect(await handleRoutePolicyWriteCommand("create", ["balanced", "--file", file(), "--json"], deps())).toBe(1);
      expect(stdout).toEqual([]); expect(calls).toHaveLength(1); noEcho();
    });
  }
  test("human output escapes control characters from admitted model fields", async () => {
    const result = receipt(); result.profile.revision = "revision\u001b[2J"; response = result;
    expect(await handleRoutePolicyWriteCommand("create", ["balanced", "--file", file()], deps())).toBe(0);
    expect(stdout.join("\n")).not.toContain("\u001b"); expect(stdout.join("\n")).toContain("Catalog committed");
  });
});

// A separate process contains Lab's process-global slots and all server imports.
// Its empty homes keep automation disabled; injected transports never open a listener.
test("actual routing editor preserves stale/create/update/alias/delete authority", async () => {
  const script = `
    import assert from "node:assert/strict";
    import { writeFileSync, mkdirSync } from "node:fs";
    import { join } from "node:path";
    mkdirSync(process.env.CODEX_HOME, { recursive: true });
    globalThis.fetch = () => { throw new Error("network prohibited"); };
    const { handleRoutePolicyWriteCommand: command } = await import(${JSON.stringify(repoPath("src/cli/route-policy-write.ts"))});
    const { handleManagementAPI } = await import(${JSON.stringify(repoPath("src/server/management-api.ts"))});
    const { ManagementRequest } = await import(${JSON.stringify(repoPath("tests/helpers/management-auth.ts"))});
    const { getRoutingProfile } = await import(${JSON.stringify(repoPath("src/routing/profile.ts"))});
    const { isLabActivated, labAutomationEnabledOnDisk, resetLabActivationForTests } = await import(${JSON.stringify(repoPath("src/lib/lab-activation.ts"))});
    const home = process.env.OPENCODEX_HOME;
    mkdirSync(home, { recursive: true });
    const config = { port: 19481, defaultProvider: "alpha", providers: {
      alpha: { adapter: "openai-chat", baseUrl: "https://alpha.example.test/v1", models: ["m1", "m2"] },
    }, routingProfiles: { fast: { alias: "ocx/fast", candidates: [{ provider: "alpha", model: "m1" }] } } };
    let saves = 0, refreshes = 0, requests = [];
    const saved = [], logs = [], errors = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    console.error = (...args) => errors.push(args.join(" "));
    const deps = { baseUrl: "http://127.0.0.1:19481", fetchImpl: async (url, init) => {
      assert.equal(init.redirect, "error"); requests.push({ url, init });
      const req = new ManagementRequest(url, init);
      const res = await handleManagementAPI(req, new URL(url), config, {
        saveConfigPreservingClaudeCode: value => { saves++; saved.push(structuredClone(value)); },
        claudeAgentConfigDir: join(home, "claude-agents"),
        createManagementConvergeCodex: () => async () => { refreshes++; return { kind: "catalog-only", catalogRefresh: ${JSON.stringify(committed)} }; },
      });
      assert.ok(res); return res;
    } };
    function input(profile) { const path = join(home, "editable.json"); writeFileSync(path, JSON.stringify(profile)); return path; }
    const next = { candidates: [{ provider: "alpha", model: "m2" }] };
    const run = async (mode, args) => { const before = requests.length; logs.length = 0; errors.length = 0;
      const exit = await command(mode, [...args, "--json"], deps); assert.equal(requests.length - before, 1); return exit; };
    try {
      assert.equal(labAutomationEnabledOnDisk(home), false);
      assert.equal(await run("create", ["fast", "--file", input(next)]), 5);
      assert.equal(saves, 0); assert.equal(config.routingProfiles.fast.candidates[0].model, "m1");
      assert.equal(await run("update", ["missing", "--file", input(next), "--expected-revision", "old"]), 4);
      assert.equal(saves, 0); assert.ok(!config.routingProfiles.missing);
      assert.equal(await run("update", ["fast", "--file", input(next), "--expected-revision", "stale"]), 5);
      assert.equal(saves, 0); assert.equal(config.routingProfiles.fast.candidates[0].model, "m1");
      assert.equal(await run("create", ["invalid", "--file", input({ candidates: [{ provider: "missing", model: "m" }] })]), 1);
      assert.equal(saves, 0); assert.ok(!config.routingProfiles.invalid);
      assert.equal(await run("create", ["alias-collision", "--file", input({ ...next, alias: "alpha/m1" })]), 1);
      assert.equal(saves, 0);
      assert.equal(await run("create", ["new-profile", "--file", input({ ...next, optimize: { latency: 2, health: 1, cost: 1, quota: 0 } })]), 0);
      assert.equal(saves, 1); assert.equal(refreshes, 1); assert.equal(isLabActivated(home), true);
      assert.equal(labAutomationEnabledOnDisk(home), false);
      assert.deepEqual(JSON.parse(logs[0]).profile.optimize, { latency: 0.5, health: 0.25, cost: 0.25, quota: 0 });
      config.injectionModel = "ocx/fast"; config.disabledModels = ["ocx/fast"];
      const revision = getRoutingProfile(config, "fast").revision;
      assert.equal(await run("update", ["fast", "--file", input({ ...next, alias: "ocx/faster" }), "--expected-revision", revision]), 0);
      assert.equal(saves, 2); assert.equal(refreshes, 2);
      assert.equal(config.injectionModel, "ocx/faster"); assert.deepEqual(config.disabledModels, ["ocx/faster"]);
      const changed = JSON.parse(logs[0]); assert.equal(changed.model, "ocx/faster");
      assert.notEqual(changed.profile.revision, revision); assert.equal(changed.profile.alias, "ocx/faster");
      assert.equal(await run("remove", ["fast", "--yes"]), 0);
      assert.equal(saves, 3); assert.equal(refreshes, 3); assert.ok(!config.routingProfiles.fast);
      assert.ok(saved.at(-1).routingProfiles["new-profile"]);
      assert.equal(await run("remove", ["fast", "--yes"]), 4); assert.equal(saves, 3);
      originalLog(JSON.stringify({ scenarios: 9, saves, refreshes, requests: requests.length, automationEnabled: false }));
    } finally { resetLabActivationForTests(); }
  `;
  const childHome = join(home, "real-handler");
  const child = Bun.spawn([process.execPath, "--eval", script], { cwd: repoRoot(), stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: "test", HOME: childHome,
      USERPROFILE: childHome, APPDATA: childHome, XDG_CONFIG_HOME: childHome, OPENCODEX_HOME: childHome,
      CODEX_HOME: join(childHome, "codex"), NO_COLOR: "1" },
  });
  const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, err }).toEqual({ exit: 0, err: "" });
  expect(JSON.parse(out.trim())).toEqual({ scenarios: 9, saves: 3, refreshes: 3, requests: 9, automationEnabled: false });
}, 20_000);
