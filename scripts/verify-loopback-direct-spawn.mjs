#!/usr/bin/env node
/**
 * Activation evidence for the unauthenticated loopback listener (#1102).
 *
 * The server-level tests prove admission, the route allowlist, CORS, the bind scope and the
 * injected port independently. None of them prove the thing the feature exists for: that a real
 * `codex app-server`, spawned the way a third-party host spawns it, reaches the proxy without a
 * credential. That seam is between two processes, so no in-process test can stand in for it.
 *
 * This is deliberately not a `bun test` file. The repository does not depend on `@openai/codex`,
 * so a test that silently skips when it is absent would be worse than no test — it would report
 * green on machines that never ran it. This script fails loudly instead, and its output is the
 * evidence attached to the PR.
 *
 * The oracle is a routed model whose id is generated at run time. Codex caches model lists and
 * falls back to a bundled catalog when a refresh fails, so asking "did model/list succeed" proves
 * nothing — a broken `/v1/models` looks identical to a working one. A name no bundled catalog can
 * contain can only have come through our listener.
 *
 * Usage: node scripts/verify-loopback-direct-spawn.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const UNIQUE_MODEL = `ocx-direct-spawn-${randomUUID()}`;
const steps = [];
function record(name, ok, detail) {
  steps.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function resolveCodexEntrypoint() {
  // The resolved entrypoint, never `codex` from PATH: the whole defect is that PATH may hold the
  // generated shim, which exports the token and would make this pass for the wrong reason.
  const probe = spawnSync(process.execPath, [
    "-e",
    "process.stdout.write(require.resolve('@openai/codex/bin/codex.js'))",
  ], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim();
  const which = spawnSync("readlink", ["-f", spawnSync("which", ["codex"], { encoding: "utf8" }).stdout.trim()], { encoding: "utf8" });
  const path = which.stdout.trim();
  if (!path) throw new Error("cannot resolve @openai/codex/bin/codex.js");
  return path;
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.once("listening", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.listen({ port: 0, host: "127.0.0.1" });
  });
}

/** A stand-in proxy: serves the loopback listener's four routes and records what Codex asked for. */
function startFakeProxy(port, seen) {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      if (req.url.startsWith("/v1/responses")) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "stub upstream" } }));
        return;
      }
      if (req.url.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          object: "list",
          data: [{ id: UNIQUE_MODEL, object: "model", created: 0, owned_by: "opencodex" }],
        }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
    });
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

async function main() {
  const entrypoint = resolveCodexEntrypoint();
  record("resolved the real Codex entrypoint, not PATH", true, entrypoint);

  const version = spawnSync(process.execPath, [entrypoint, "--version"], { encoding: "utf8" });
  record("entrypoint runs", version.status === 0, version.stdout.trim() || version.stderr.trim());

  const home = mkdtempSync(join(tmpdir(), "ocx-direct-spawn-"));
  const codexHome = join(home, ".codex");
  const port = await freePort();
  const seen = [];
  const proxy = await startFakeProxy(port, seen);

  try {
    // The provider block `ocx sync` writes when the loopback listener is enabled: loopback host,
    // the listener's port, and NO env_http_headers — the app-server has no token to put in one.
    //
    // The catalog file matters and is easy to get wrong. `model/list` reads `model_catalog_json`;
    // it does not call the provider's `/v1/models`. A first version of this script omitted the
    // catalog and watched Codex return its five bundled ids while never touching the listener —
    // which is exactly the false-negative shape the unique-id oracle exists to expose, just
    // pointed at the harness instead of the feature.
    mkdirSync(codexHome, { recursive: true });
    // Build the catalog with OUR OWN serializer rather than a hand-written object. Codex rejects
    // the whole file on any schema mismatch and silently falls back to its bundled list, so a
    // hand-rolled fixture drifts into a false negative the moment the schema moves. Using
    // `buildCatalogEntries` also means this script exercises the same bytes `ocx sync` writes.
    const catalogPath = join(codexHome, "opencodex-models.json");
    const build = spawnSync("bun", ["-e", `
      const { buildCatalogEntries } = await import("./src/codex/catalog/sync.ts");
      const entries = buildCatalogEntries(null, [], [{
        provider: "opencodex",
        id: ${JSON.stringify(UNIQUE_MODEL)},
        contextWindow: 128000,
      }]);
      process.stdout.write(JSON.stringify({ models: entries }));
    `], { cwd: process.cwd(), encoding: "utf8" });
    if (build.status !== 0 || !build.stdout.trim()) {
      record("built the catalog with our own serializer", false, (build.stderr || "").slice(0, 400));
      throw new Error("catalog build failed");
    }
    writeFileSync(catalogPath, build.stdout, "utf-8");
    record("built the catalog with our own serializer", true, `${JSON.parse(build.stdout).models.length} entries`);
    writeFileSync(join(codexHome, "config.toml"), [
      `model = "${UNIQUE_MODEL}"`,
      'model_provider = "opencodex"',
      `model_catalog_json = ${JSON.stringify(catalogPath)}`,
      "",
      "[model_providers.opencodex]",
      'name = "OpenCodex Proxy"',
      `base_url = "http://127.0.0.1:${port}/v1"`,
      'wire_api = "responses"',
      "requires_openai_auth = true",
      "",
    ].join("\n"), "utf-8");
    record("wrote an isolated CODEX_HOME with no models_cache.json", true, codexHome);

    const env = { ...process.env, CODEX_HOME: codexHome };
    // The credential must be absent, or this would prove nothing about the shim-less path.
    delete env.OPENCODEX_API_AUTH_TOKEN;
    record("stripped OPENCODEX_API_AUTH_TOKEN from the child environment", true);

    const child = spawn(process.execPath, [entrypoint, "app-server"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buffered = "";
    const responses = new Map();
    child.stdout.on("data", chunk => {
      buffered += chunk.toString();
      let index;
      while ((index = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, index).trim();
        buffered = buffered.slice(index + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          if (message.id !== undefined) responses.set(message.id, message);
        } catch { /* notifications and logs are not our concern */ }
      }
    });
    const stderr = [];
    child.stderr.on("data", chunk => stderr.push(chunk.toString()));

    const send = payload => child.stdin.write(`${JSON.stringify(payload)}\n`);
    const await_ = async (id, timeoutMs = 30_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (responses.has(id)) return responses.get(id);
        await new Promise(r => setTimeout(r, 50));
      }
      return null;
    };

    send({ id: 1, method: "initialize", params: { clientInfo: { name: "ocx-verify", version: "1", title: "OpenCodex verification" } } });
    const init = await await_(1);
    record("app-server initialized", !!init && !init.error, init?.error ? JSON.stringify(init.error) : "ok");

    send({ id: 2, method: "model/list", params: {} });
    const list = await await_(2, 45_000);
    const models = list?.result?.items ?? list?.result?.models ?? list?.result?.data ?? [];
    const ids = models.map(m => m?.id ?? m?.model ?? m?.slug).filter(Boolean);
    // Routed models are namespaced `<provider>/<id>` in the catalog, so match on the unique
    // suffix rather than a bare equality that would fail for a correct result.
    const sawUnique = ids.some(id => id === UNIQUE_MODEL || id.endsWith(`/${UNIQUE_MODEL}`));
    record(
      "model/list contains the unique routed model that only our listener can supply",
      sawUnique,
      sawUnique ? UNIQUE_MODEL : `saw ${ids.length} ids, none matching (${ids.slice(0, 6).join(", ")})`,
    );

    const hitModels = seen.some(entry => entry.includes("/v1/models"));
    // `model/list` reads the catalog file, so it does NOT prove a network hop. The turn does:
    // it opens `/v1/responses` against the injected base_url, and reaching our listener there
    // without a credential is the whole claim of #1102.
    send({
      id: 3,
      method: "thread/start",
      params: { cwd: home, model: UNIQUE_MODEL, provider: "opencodex" },
    });
    const started = await await_(3, 30_000);
    const threadId = started?.result?.threadId ?? started?.result?.thread?.id;
    record("thread/start accepted", !!threadId, threadId ? String(threadId) : JSON.stringify(started?.error ?? started).slice(0, 200));

    if (threadId) {
      send({
        id: 4,
        method: "turn/start",
        params: { threadId, input: [{ type: "text", text: "ping" }] },
      });
      // The upstream is a stub, so the turn is expected to FAIL. What matters is that the
      // request arrived at all: a 401 at admission would never reach the handler.
      await await_(4, 25_000);
    }

    const hitResponses = seen.some(entry => entry.includes("/v1/responses"));
    record(
      "the app-server reached the loopback listener without a credential",
      hitModels || hitResponses,
      seen.slice(0, 8).join(" | ") || "no requests observed",
    );

    child.kill();
    if (stderr.length && !sawUnique) console.log("\nchild stderr:\n" + stderr.join("").slice(0, 2000));
  } finally {
    proxy.close();
    rmSync(home, { recursive: true, force: true });
  }

  const failed = steps.filter(step => !step.ok);
  console.log(`\n${steps.length - failed.length}/${steps.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
