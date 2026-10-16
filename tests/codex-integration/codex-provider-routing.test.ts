import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

let root: string, codexHome: string, ocxHome: string;
const original = 'model_provider = "chatgpt-http"\n\n[model_providers."chatgpt-http"]\nname = "ChatGPT HTTP"\nbase_url = \'https://chatgpt.com/backend-api/codex\' # keep\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\n';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-provider-routing-"));
  codexHome = join(root, "codex"); ocxHome = join(root, "ocx");
  mkdirSync(codexHome); mkdirSync(ocxHome);
  writeFileSync(join(codexHome, "config.toml"), original);
  writeFileSync(join(codexHome, "history.jsonl"), "history sentinel\n");
});
afterEach(() => removeTreeWithRetry(root));

function run(script: string, home = codexHome) {
  const child = spawnSync(process.execPath, ["--eval", `
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { allowCodexProviderRouting, previewCodexProviderConsent, approvedCodexProviders, restoreApprovedCodexProviders } from "./src/codex/provider-routing";
    import { injectCodexConfig, restoreNativeCodex, restoreNativeCodexAsync } from "./src/codex/inject";
    import { handleCodexProviderCommand } from "./src/cli/codex-provider";
    const path = join(process.env.CODEX_HOME, "config.toml");
    const id = "chatgpt-http";
    const allow = () => allowCodexProviderRouting(id, previewCodexProviderConsent(id));
    ${script}
  `], { cwd: repoRoot(), env: { ...process.env, CODEX_HOME: home, OPENCODEX_HOME: ocxHome }, encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5000 });
  expect(child.status, child.stderr).toBe(0);
  return child.stdout;
}

test("unapproved providers and noninteractive implicit consent leave config untouched", () => {
  const output = run(`
    const result = await injectCodexConfig(10100, {});
    if (result.configApplied !== false) throw new Error("unapproved provider changed");
    if (await handleCodexProviderCommand(["allow", id]) !== 1) throw new Error("missing consent accepted");
    if (approvedCodexProviders().length) throw new Error("consent was saved");
    console.log("unchanged");
  `);
  expect(output).toContain("unchanged");
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
});

test.each(["sync", "async"])("approved provider follows port changes and restores exactly (%s)", kind => {
  run(`
    if (await handleCodexProviderCommand(["allow", id, "--yes"]) !== 0) throw new Error("consent failed");
    const journal = join(process.env.CODEX_HOME, "opencodex-journal.json");
    writeFileSync(journal, JSON.stringify({ version: 1, originalConfig: Buffer.from('model_provider = "openai"\\n').toString("base64"), originalProfile: null, opencodexHome: process.env.OPENCODEX_HOME }));
    for (const port of [10100, 10101]) {
      const result = await injectCodexConfig(port, {});
      if (!result.success || result.configApplied === false || result.configChanged !== true) throw new Error("approved routing skipped or change receipt missing");
      const noop = await injectCodexConfig(port, {});
      if (noop.configChanged !== false) throw new Error("unchanged approved routing claimed a config write");
      const config = Bun.TOML.parse(readFileSync(path, "utf8"));
      if (config.model_provider !== id || config.model_providers[id].supports_websockets !== false
        || config.model_providers[id].base_url !== "http://127.0.0.1:" + port + "/v1") throw new Error("settings changed");
    }
    if (existsSync(journal)) throw new Error("stale native journal survived approved routing");
    const result = ${kind === "async" ? "await restoreNativeCodexAsync()" : "restoreNativeCodex()"};
    if (!result.success || !result.artifacts.config.changed) throw new Error("restore did not report its write");
    if (!approvedCodexProviders().includes(id)) throw new Error("stop lost persistent consent");
  `);
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
  expect(readFileSync(join(codexHome, "history.jsonl"), "utf8")).toBe("history sentinel\n");
});

test("URL drift is refused and revocation preserves a user-owned replacement", () => {
  run(`
    allow(); await injectCodexConfig(10100, {});
    writeFileSync(path, readFileSync(path, "utf8").replace("http://127.0.0.1:10100/v1", "https://other.example/v1"));
    let refused = false;
    try { await injectCodexConfig(10101, {}); } catch { refused = true; }
    if (!refused) throw new Error("URL drift accepted");
    restoreApprovedCodexProviders(id);
    if (approvedCodexProviders().length) throw new Error("revocation failed");
  `);
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toContain("https://other.example/v1");
});

test("prompt snapshot drift, credential-bearing providers and non-loopback targets are refused", () => {
  run(`
    const expected = previewCodexProviderConsent(id);
    writeFileSync(path, readFileSync(path, "utf8").replace("https://chatgpt.com/backend-api/codex", "https://changed.example/v1"));
    let refused = false;
    try { allowCodexProviderRouting(id, expected); } catch { refused = true; }
    if (!refused || approvedCodexProviders().length) throw new Error("stale confirmation accepted");
    const clean = readFileSync(path, "utf8");
    writeFileSync(path, clean + 'env_key = "PROVIDER_KEY"\\n');
    refused = false;
    try { allow(); } catch { refused = true; }
    if (!refused) throw new Error("separate credential accepted");
    writeFileSync(path, clean); allow();
    refused = false;
    try { await injectCodexConfig(10100, { hostname: "0.0.0.0" }); } catch { refused = true; }
    if (!refused || readFileSync(path, "utf8") !== clean) throw new Error("non-loopback target changed config");
  `);
});

test("validation is read-only, revocation restores managed URL and removes future permission", () => {
  run(`
    allow();
    const before = readFileSync(path, "utf8");
    const { readdirSync } = await import("node:fs");
    const entries = JSON.stringify(readdirSync(process.env.OPENCODEX_HOME).sort());
    await injectCodexConfig(10100, {}, { validateOnly: true });
    if (readFileSync(path, "utf8") !== before) throw new Error("validation wrote config");
    if (JSON.stringify(readdirSync(process.env.OPENCODEX_HOME).sort()) !== entries) throw new Error("validation created mutation metadata");
    await injectCodexConfig(10100, {});
    if (await handleCodexProviderCommand(["revoke", id]) !== 0) throw new Error("revoke failed");
    const result = await injectCodexConfig(10100, {});
    if (result.configApplied !== false) throw new Error("revoked provider changed");
  `);
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
});


test("explicit sync applies an approved provider instead of taking the external catalog-only path", () => {
  run(`
    allow();
    const { syncModelsToCodex } = await import("./src/codex/sync");
    const result = await syncModelsToCodex(10103, { providers: {} }, null, {
      admitCodexWrite: () => ({ kind: "admitted" }),
      injectCodexConfig,
      currentExternalCodexModelProvider: () => id,
      refreshCodexModelCatalog: async () => ({ added: 0, path: join(process.env.CODEX_HOME, "opencodex-catalog.json"), catalogExists: false, catalogWritten: false, cacheSynced: false, comboOmissions: [] }),
    }, { catalogEvenWhenNotInjected: true });
    if (!result.ok || result.status === "catalog-only") throw new Error("approved sync skipped injection");
    if (Bun.TOML.parse(readFileSync(path, "utf8")).model_providers[id].base_url !== "http://127.0.0.1:10103/v1") throw new Error("sync did not publish URL");
  `);
});


test("approving a provider in one Codex home does not approve the same ID in another", () => {
  run("allow();");
  const other = join(root, "other-codex");
  mkdirSync(other); writeFileSync(join(other, "config.toml"), original);
  run(`
    if (approvedCodexProviders().length) throw new Error("consent leaked across homes");
    const result = await injectCodexConfig(10100, {});
    if (result.configApplied !== false) throw new Error("another home was routed");
  `, other);
  expect(readFileSync(join(other, "config.toml"), "utf8")).toBe(original);
});


test("a new process restores URL-only recovery after abrupt process exit", () => {
  run("allow(); await injectCodexConfig(18272, {}); process.exit(0);");
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toContain("http://127.0.0.1:18272/v1");
  run(`
    const result = await restoreNativeCodexAsync();
    if (!result.success || !result.artifacts.config.changed) throw new Error("crash recovery failed");
    if (!approvedCodexProviders().includes(id)) throw new Error("recovery lost consent");
  `);
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
  expect(readFileSync(join(codexHome, "history.jsonl"), "utf8")).toBe("history sentinel\n");
});

test("reserved provider IDs cannot claim consent", () => {
  run(`
    const clean = readFileSync(path, "utf8");
    for (const reserved of ["__proto__", "constructor", "prototype", "openai", "opencodex", "ollama", "lmstudio"]) {
      writeFileSync(path, clean.replaceAll("chatgpt-http", reserved));
      let refused = false;
      try { allowCodexProviderRouting(reserved, previewCodexProviderConsent(reserved)); } catch (error) { refused = error.message.includes("Select a custom provider ID"); }
      if (!refused || approvedCodexProviders().length) throw new Error("reserved ID admitted: " + reserved);
      writeFileSync(path, clean);
    }
  `);
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
});

test("concurrent sync processes leave a complete restorable config", () => {
  run(`
    allow();
    const before = readFileSync(path, "utf8");
    const jobs = [18273, 18274, 18275].map(port => Bun.spawn([process.execPath, "--eval",
      'import { injectCodexConfig } from "./src/codex/inject"; const result = await injectCodexConfig(' + port + ', {}); process.stdout.write(JSON.stringify(result)); if (!result.success && !result.retryable) process.exit(2);'
    ], { cwd: process.cwd(), env: process.env, stdout: "pipe", stderr: "pipe" }));
    const outcomes = await Promise.all(jobs.map(async job => ({ code: await job.exited, error: await new Response(job.stderr).text(), output: await new Response(job.stdout).text() })));
    if (outcomes.some(result => result.code !== 0)) throw new Error("concurrent sync failed: " + JSON.stringify(outcomes));
    const results = outcomes.map(outcome => JSON.parse(outcome.output));
    if (results.some(result => !result.success && result.retryable !== true)) throw new Error("non-retryable concurrent result");
    if (results.every(result => !result.success)) {
      if (readFileSync(path, "utf8") !== before) throw new Error("retry-only syncs mutated config");
      const converged = await injectCodexConfig(18273, {});
      if (!converged.success || converged.configChanged !== true) throw new Error("uncontended sync did not converge: " + JSON.stringify(converged));
    }
    const config = Bun.TOML.parse(readFileSync(path, "utf8"));
    if (![18273, 18274, 18275].some(port => config.model_providers[id].base_url === "http://127.0.0.1:" + port + "/v1")) throw new Error("no sync published: " + JSON.stringify(outcomes));
  `);
  run("restoreApprovedCodexProviders();");
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
});


test("approved restore preserves partial native outcome and reports recovery failures structurally", () => {
  run(`
    const { finishApprovedProviderRestore, skippedRestoreEnvelope } = await import("./src/codex/inject/restore");
    allow(); await injectCodexConfig(18278, {});
    const native = skippedRestoreEnvelope(true, "Native restore kept a provider table.");
    native.artifacts.config = { state: "partial", changed: true, action: "routing-restored-provider-retained", message: "History-backed provider table retained." };
    const restored = finishApprovedProviderRestore(native);
    if (!restored.success || restored.artifacts.config.state !== "partial" || !restored.artifacts.config.message.includes("History-backed provider table retained")) throw new Error("partial outcome erased");
    const { readdirSync } = await import("node:fs");
    const record = readdirSync(process.env.OPENCODEX_HOME).find(name => name.startsWith("codex-provider-routing-") && name.endsWith(".json"));
    writeFileSync(join(process.env.OPENCODEX_HOME, record), "broken record");
    const failed = finishApprovedProviderRestore(native);
    if (failed.success || failed.artifacts.config.state !== "failed" || !failed.artifacts.config.changed || !failed.message.includes("Approved Codex provider URL restoration failed")) throw new Error("recovery failure lost its artifact outcome");
  `);
});


test("a crash between recovery publication and URL publication preserves both recovery candidates", () => {
  run(`
    allow(); await injectCodexConfig(18279, {});
    const { setBeforeProviderRoutingPublishForTests } = await import("./src/codex/provider-routing");
    setBeforeProviderRoutingPublishForTests(() => process.exit(0));
    await injectCodexConfig(18280, {});
    throw new Error("publication seam was not reached");
  `);
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toContain("http://127.0.0.1:18279/v1");
  run(`
    const { readdirSync } = await import("node:fs");
    const record = readdirSync(process.env.OPENCODEX_HOME).find(name => name.startsWith("codex-provider-routing-") && name.endsWith(".json"));
    const saved = JSON.parse(readFileSync(join(process.env.OPENCODEX_HOME, record), "utf8")).providers[id];
    if (!saved.managedUrls.includes("http://127.0.0.1:18279/v1") || !saved.managedUrls.includes("http://127.0.0.1:18280/v1")) throw new Error("crash recovery candidates lost");
    let busy = false;
    try { restoreNativeCodex(); } catch (error) { busy = error.retryable === true; }
    if (!busy) throw new Error("fresh crashed lock was not respected");
    const { STALE_AFTER_MS } = await import("./src/codex/prompt-lock");
    await Bun.sleep(STALE_AFTER_MS + 100);
    const result = restoreNativeCodex();
    if (!result.success) throw new Error(result.message);
  `);
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
}, SPAWN_BUDGET_MS);


test("startup health recognizes only the exact managed URL of an approved provider", () => {
  run(`
    const { getCodexRoutingKind } = await import("./src/codex/inject/routing-classify");
    const before = readFileSync(path, "utf8");
    writeFileSync(path, before.replace("https://chatgpt.com/backend-api/codex", "http://127.0.0.1:10100/v1"));
    if (getCodexRoutingKind() !== "custom-local") throw new Error("unapproved URL was claimed");
    writeFileSync(path, before); allow(); await injectCodexConfig(10100, {});
    if (getCodexRoutingKind() !== "opencodex-local") throw new Error("managed route was not recognized");
    writeFileSync(path, readFileSync(path, "utf8").replace("http://127.0.0.1:10100/v1", "http://127.0.0.1:19999/v1"));
    if (getCodexRoutingKind() !== "custom-local") throw new Error("unrecorded URL was claimed");
  `);
});


test.each(["already-off", "late-off"])("approved routing respects integration OFF at publication (%s)", timing => {
  run(`
    const { readdirSync } = await import("node:fs");
    const { getDefaultConfig, saveConfig } = await import("./src/config");
    const { injectApprovedCodexProvider } = await import("./src/codex/provider-routing");
    const { standaloneCodexRoutingTarget } = await import("./src/codex/inject/routing-target");
    const config = getDefaultConfig();
    saveConfig(config); allow();
    const record = join(process.env.OPENCODEX_HOME, readdirSync(process.env.OPENCODEX_HOME).find(name => name.startsWith("codex-provider-routing-") && name.endsWith(".json")));
    const evidence = readFileSync(record, "utf8");
    const disable = () => {
      config.clientIntegrations = { codex: false };
      writeFileSync(join(process.env.OPENCODEX_HOME, "config.json"), JSON.stringify(config));
    };
    if (${JSON.stringify(timing)} === "already-off") disable();
    const result = injectApprovedCodexProvider(id, standaloneCodexRoutingTarget(18281, {}), () => {
      if (${JSON.stringify(timing)} === "late-off") disable();
    });
    if (result !== false) throw new Error("integration OFF was not skipped");
    if (readFileSync(record, "utf8") !== evidence) throw new Error("skipped injection changed recovery evidence");
    if (!approvedCodexProviders().includes(id)) throw new Error("skip revoked consent");
  `);
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
  expect(readFileSync(join(codexHome, "history.jsonl"), "utf8")).toBe("history sentinel\n");
});


test("concurrent approval replacement cannot escape injection as an unhandled read failure", () => {
  run(`
    const fs = await import("node:fs");
    const { spyOn } = await import("bun:test");
    allow();
    const record = join(process.env.OPENCODEX_HOME, fs.readdirSync(process.env.OPENCODEX_HOME).find(name => name.startsWith("codex-provider-routing-") && name.endsWith(".json")));
    const stat = fs.statSync;
    // Reproduce a cooperating writer's atomic rename between the reader's stat and open.
    const observation = spyOn(fs, "statSync").mockImplementation((file, ...options) => {
      const result = stat(file, ...options);
      if (file === record && !existsSync(path + ".ocx-write.lock")) {
        writeFileSync(record + ".replacement", readFileSync(record));
        fs.renameSync(record + ".replacement", record);
      }
      return result;
    });
    try {
      const result = await injectCodexConfig(18282, {});
      if (!result.success && !result.retryable) throw new Error("concurrent injection was not success-or-retryable");
    } finally { observation.mockRestore(); }
  `);
});
