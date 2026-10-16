import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

test("compiled PAC policy embeds its worker and WASM, fails closed, and exits after close (#5947)", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "ocx-packaged-pac-"));
  try {
    const buildDir = join(scratch, "build");
    const emptyCwd = join(scratch, "empty");
    mkdirSync(buildDir);
    mkdirSync(emptyCwd);
    const executable = join(scratch, process.platform === "win32" ? "pac-policy.exe" : "pac-policy");
    const entry = join(buildDir, "entry.ts");

    // Keep this isolated build tied to the production worker registry. Updating
    // worker-bundles.gen.ts on disk would race other source-mode tests.
    const buildScript = readFileSync(repoPath("scripts", "build-standalone.ts"), "utf8");
    expect(buildScript).toMatch(/"pac-worker":\s*join\(repoRoot,\s*"src",\s*"chatgpt",\s*"desktop-unblock",\s*"pac-worker\.ts"\)/);
    const worker = await Bun.build({
      entrypoints: [repoPath("src", "chatgpt", "desktop-unblock", "pac-worker.ts")],
      target: "bun",
    });
    expect(worker.success, worker.logs.map(log => log.message).join("\n")).toBe(true);
    expect(worker.outputs).toHaveLength(1);
    const workerSource = await worker.outputs[0]!.text();

    writeFileSync(entry, `
      import assert from "node:assert/strict";
      import { readdirSync } from "node:fs";
      import { createRuntimePacPolicy } from ${JSON.stringify(repoPath("src", "chatgpt", "desktop-unblock", "pac-policy.ts"))};
      import { WORKER_BUNDLES } from ${JSON.stringify(repoPath("src", "generated", "worker-bundles.gen.ts"))};

      assert.deepEqual(readdirSync(process.cwd()), []);
      assert.ok(WORKER_BUNDLES["pac-worker"], "PAC worker must be embedded");
      const wasm = Bun.embeddedFiles.find(file => file.name.endsWith(".wasm"));
      assert.ok(wasm, "QuickJS WASM must be embedded, not loaded from node_modules");
      assert.deepEqual([...new Uint8Array(await wasm.slice(0, 4).arrayBuffer())], [0, 97, 115, 109]);

      const policy = await createRuntimePacPolicy(
        'function FindProxyForURL(url, host) {' +
        '  if (dnsDomainIs(host, ".example.test") && shExpMatch(url, "https://*.example.test/"))' +
        '    return "PROXY proxy.example.test:8080; HTTPS secure.example.test:443; SOCKS5 [::1]:1080; DIRECT";' +
        '  return "DIRECT";' +
        '}'
      );
      let routes;
      try {
        routes = await policy.resolve("https://service.example.test/private?secret=redacted");
        assert.deepEqual(routes, ["http://proxy.example.test:8080", "https://secure.example.test:443", "socks5://[::1]:1080", null]);
        assert.deepEqual(await policy.resolve("https://other.test/"), [null]);
      } finally { policy.close(); }
      await assert.rejects(policy.resolve("https://service.example.test/"), /closed/i);

      await assert.rejects(createRuntimePacPolicy("function FindProxyForURL("), /PAC/);
      for (const source of [
        'function FindProxyForURL() { try { var x = "x".repeat(1e9); } catch (error) { return "DIRECT"; } }',
        'function FindProxyForURL() { try { var x = "x".repeat(1e9); } finally { return "DIRECT"; } }',
      ]) {
        await assert.rejects(async () => {
          const suppressed = await createRuntimePacPolicy(source);
          suppressed.close();
        }, /PAC/);
      }
      for (const source of [
        'function FindProxyForURL() { return "PROXY proxy.example.test:8080; INVALID; DIRECT"; }',
        'function FindProxyForURL() { myIpAddress(); return "DIRECT"; }',
      ]) {
        const rejected = await createRuntimePacPolicy(source);
        try {
          await assert.rejects(rejected.resolve("https://service.example.test/"), /PAC/);
          await assert.rejects(rejected.resolve("https://other.test/"), /PAC/);
        } finally { rejected.close(); }
      }
      assert.deepEqual(readdirSync(process.cwd()), []);
      console.log(JSON.stringify({ routes, invalidSourceRejected: true, suppressedOomRejected: true, invalidRoutesRejected: true, unsupportedRejected: true, closed: true }));
      // Do not force process.exit(): an unclosed worker must fail the parent timeout.
    `);

    let injected = 0;
    const compiled = await Bun.build({
      entrypoints: [entry],
      compile: { outfile: executable },
      plugins: [{
        name: "isolated-pac-worker-bundle",
        setup(build) {
          build.onLoad({ filter: /[/\\]worker-bundles\.gen\.ts$/ }, () => {
            injected++;
            return {
              loader: "ts",
              contents: `export const WORKER_BUNDLES: Record<string, string> = ${JSON.stringify({ "pac-worker": workerSource })};`,
            };
          });
        },
      }],
    });
    expect(compiled.success, compiled.logs.map(log => log.message).join("\n")).toBe(true);
    expect(injected).toBe(1);
    if (process.platform === "darwin") {
      // Match build-standalone: the linker signature may omit Bun's embedded payload.
      const signed = Bun.spawnSync(["/usr/bin/codesign", "--force", "--sign", "-", executable], {
        stdout: "pipe", stderr: "pipe", timeout: SPAWN_BUDGET_MS,
      });
      expect(signed.exitCode, signed.stderr.toString()).toBe(0);
    }
    removeTreeWithRetry(buildDir);
    expect(readdirSync(scratch).sort()).toEqual(["empty", process.platform === "win32" ? "pac-policy.exe" : "pac-policy"].sort());

    const result = Bun.spawnSync([executable], {
      cwd: emptyCwd,
      env: {
        HOME: emptyCwd, USERPROFILE: emptyCwd, PATH: "", NODE_PATH: "",
        ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}),
      },
      stdout: "pipe", stderr: "pipe", timeout: SPAWN_BUDGET_MS,
    });
    expect(result.exitCode, JSON.stringify({ signal: result.signalCode, error: result.error?.message, stderr: result.stderr.toString() })).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      routes: ["http://proxy.example.test:8080", "https://secure.example.test:443", "socks5://[::1]:1080", null],
      invalidSourceRejected: true, suppressedOomRejected: true, invalidRoutesRejected: true, unsupportedRejected: true, closed: true,
    });
    expect(readdirSync(emptyCwd)).toEqual([]);
  } finally {
    removeTreeWithRetry(scratch);
  }
}, SPAWN_BUDGET_MS * 3);
