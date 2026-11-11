/**
 * GET /api/claude-code must observe the macOS Keychain without blocking the serving event loop
 * (#8161). A synchronous `security` probe stalled every request, /healthz included, for up to its
 * 1.5 s deadline and then killed the child, which crashes securityd while an unlock prompt is open.
 *
 * The server runs in a separate process so this client can see a blocked event loop. The first
 * test holds a synthetic `security` child open on every platform; the darwin-only test holds a
 * real fake `security` executable from PATH open. Neither touches the native Keychain.
 *
 * Ported from the test proposed in #8450, rewritten for the asynchronous Keychain reader.
 */
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";

setDefaultTimeout(30_000);

/** The /healthz deadline a supervisor gives a live proxy. */
const HEALTHZ_DEADLINE_MS = 750;
const MARK = "keychain-healthz:";

let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ocx-keychain-healthz-")); });
afterEach(() => { if (root) removeTreeWithRetry(root); });

function fixtureEnv(): Record<string, string> {
  const home = join(root, "home");
  const ocxHome = join(root, "ocx");
  const codexHome = join(root, "codex");
  for (const dir of [home, ocxHome, codexHome]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "opencodex-catalog.json"\n');
  writeFileSync(join(ocxHome, "config.json"), JSON.stringify({
    port: 0,
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", allowPrivateNetwork: true, liveModels: false, models: ["test-model"] },
    },
  }));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // An exported Anthropic credential would answer detection before the Keychain source does.
    if (value !== undefined && !key.startsWith("ANTHROPIC_")) env[key] = value;
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    OPENCODEX_HOME: ocxHome,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: join(root, "claude-desktop"),
  };
}

test.each(["absent", "unavailable"] as const)("GET /healthz responds while Claude Keychain metadata is pending (%s)", async outcome => {
  const script = `
    import { EventEmitter } from "node:events";
    const { claudeKeychainReader, createClaudeKeychainReader } = await import(${JSON.stringify(repoPath("src/oauth/claude-keychain-read.ts"))});
    const { startServer } = await import(${JSON.stringify(repoPath("src/server/index.ts"))});
    const send = message => console.log(${JSON.stringify(MARK)} + JSON.stringify(message));
    const child = Object.assign(new EventEmitter(), {
      pid: 4242, stdout: null, signals: 0,
      unref() {}, kill() { this.signals++; return true; },
    });
    let expire;
    let invocation;
    const keychain = createClaudeKeychainReader({ platform: "darwin",
      now: () => Date.now(),
      schedule(ms, fn) { expire = fn; return () => {}; },
      spawn(command, args, captureStdout) { invocation = { command, args, captureStdout }; return child; },
    });
    claudeKeychainReader.probe = () => {
      send({ event: "probing" });
      return keychain.probe();
    };
    // Nothing in this fixture may reach the real Keychain.
    claudeKeychainReader.readAsync = async () => null;
    const server = startServer(0);
    send({ event: "listening", url: server.url.href });
    process.stdin.on("data", () => {
      if (${JSON.stringify(outcome)} === "unavailable") expire();
      else child.emit("close", 44, null);
      send({ event: "released", invocation, signals: child.signals });
    });
    process.stdin.on("end", async () => {
      child.emit("close", 44, null);
      await server.stop(true);
      process.exit(0);
    });
    process.stdin.resume();
  `;
  const env = fixtureEnv();
  const fixture = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
    cwd: root, env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const listening = Promise.withResolvers<string>();
  const probing = Promise.withResolvers<void>();
  const released = Promise.withResolvers<Record<string, unknown>>();
  const output = (async () => {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of fixture.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, end).trim();
        buffered = buffered.slice(end + 1);
        if (!line.startsWith(MARK)) continue;
        const message = JSON.parse(line.slice(MARK.length));
        if (message.event === "listening") listening.resolve(message.url);
        if (message.event === "probing") probing.resolve();
        if (message.event === "released") released.resolve(message);
      }
    }
  })();
  const errors = new Response(fixture.stderr).text();
  const exited = fixture.exited.then(async code => {
    throw new Error(`Keychain HTTP fixture exited early (${code}): ${await errors}`);
  });
  // Attach immediately; the exit is intentionally awaited separately during cleanup.
  void exited.catch(() => {});
  let settings: Promise<Response> | undefined;
  try {
    const base = await Promise.race([listening.promise, exited]);
    const headers = { "x-opencodex-api-key": readFileSync(join(env.OPENCODEX_HOME!, "admin-api-token"), "utf8").trim() };
    // Warm the health route so the timed request below measures only the event loop.
    expect((await fetch(new URL("/healthz", base), { signal: AbortSignal.timeout(10_000) })).status).toBe(200);

    let settingsFinished = false;
    settings = fetch(new URL("/api/claude-code", base), { headers, signal: AbortSignal.timeout(20_000) })
      .then(response => { settingsFinished = true; return response; });
    await Promise.race([probing.promise, settings.then(() => { throw new Error("Claude settings skipped the Keychain observation"); }), exited]);

    const started = performance.now();
    const health = await fetch(new URL("/healthz", base), { signal: AbortSignal.timeout(HEALTHZ_DEADLINE_MS) });
    expect(health.status).toBe(200);
    expect(performance.now() - started).toBeLessThan(HEALTHZ_DEADLINE_MS);
    expect(await health.json()).toMatchObject({ service: "opencodex", status: "ok" });
    // The settings request is still waiting on the Keychain while health answered.
    expect(settingsFinished).toBe(false);

    fixture.stdin.write("release\n");
    await fixture.stdin.flush();
    const observation = await Promise.race([released.promise, exited]);
    // Metadata only, output discarded, and the child is never signalled, even past its deadline.
    expect(observation).toEqual({ event: "released", invocation: {
      command: "security", args: ["find-generic-password", "-s", "Claude Code-credentials"], captureStdout: false,
    }, signals: 0 });
    const response = await settings;
    expect(response.status).toBe(200);
    // A Keychain that did not answer is unknown (subscription), never absent (proxy).
    expect(await response.json()).toMatchObject({ authDetectionUnknown: outcome === "unavailable" });
  } finally {
    // Terminate only our synthetic HTTP fixture, never a real security process.
    fixture.stdin.end();
    const done = await Promise.race([fixture.exited, Bun.sleep(5_000).then(() => null)]);
    if (done === null) fixture.kill();
    await fixture.exited;
    await settings?.catch(() => {});
    await output;
    await errors;
  }
});

// The same contract against a real child process: the server's own reader spawns a fake `security`
// from PATH that waits for the test. A synchronous probe would block the serving thread for its
// whole deadline and then signal this child, which is the #8161 crash on a real keychain.
test.skipIf(process.platform !== "darwin")("GET /healthz responds while a real security child is held open, and that child is never signalled", async () => {
  const env = fixtureEnv();
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "security.log");
  const release = join(root, "security.release");
  writeFileSync(join(bin, "security"), [
    "#!/bin/sh",
    `trap 'echo signalled >> "${log}"; exit 143' TERM INT HUP`,
    `echo "args:$*" >> "${log}"`,
    `while [ ! -f "${release}" ]; do sleep 0.02; done`,
    "exit 44",
    "",
  ].join("\n"));
  chmodSync(join(bin, "security"), 0o755);
  const script = `
    const { startServer } = await import(${JSON.stringify(repoPath("src/server/index.ts"))});
    const server = startServer(0);
    console.log(${JSON.stringify(MARK)} + server.url.href);
    process.stdin.on("end", async () => { await server.stop(true); process.exit(0); });
    process.stdin.resume();
  `;
  const fixture = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
    cwd: root, env: { ...env, PATH: `${bin}:${env.PATH ?? ""}` }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const errors = new Response(fixture.stderr).text();
  let settings: Promise<Response> | undefined;
  try {
    const base = await (async () => {
      const decoder = new TextDecoder();
      let buffered = "";
      for await (const chunk of fixture.stdout) {
        buffered += decoder.decode(chunk, { stream: true });
        const line = buffered.split("\n").find(entry => entry.startsWith(MARK));
        if (line) return line.slice(MARK.length).trim();
      }
      throw new Error(`Keychain HTTP fixture exited early: ${await errors}`);
    })();
    const headers = { "x-opencodex-api-key": readFileSync(join(env.OPENCODEX_HOME!, "admin-api-token"), "utf8").trim() };
    expect((await fetch(new URL("/healthz", base), { signal: AbortSignal.timeout(10_000) })).status).toBe(200);

    settings = fetch(new URL("/api/claude-code", base), { headers, signal: AbortSignal.timeout(20_000) });
    const deadline = Date.now() + 10_000;
    while (!existsSync(log) || !readFileSync(log, "utf8").includes("args:")) {
      if (Date.now() > deadline) throw new Error("Claude settings never started the security probe");
      await Bun.sleep(10);
    }
    const started = performance.now();
    const health = await fetch(new URL("/healthz", base), { signal: AbortSignal.timeout(HEALTHZ_DEADLINE_MS) });
    expect(health.status).toBe(200);
    expect(performance.now() - started).toBeLessThan(HEALTHZ_DEADLINE_MS);

    writeFileSync(release, "");
    expect((await settings).status).toBe(200);
  } finally {
    writeFileSync(release, "");
    fixture.stdin.end();
    const done = await Promise.race([fixture.exited, Bun.sleep(5_000).then(() => null)]);
    if (done === null) fixture.kill();
    await fixture.exited;
    await settings?.catch(() => {});
    await errors;
  }
  // Metadata only, and the held child was left to exit on its own.
  const lines = readFileSync(log, "utf8").trim().split("\n");
  expect(lines).toContain("args:find-generic-password -s Claude Code-credentials");
  expect(lines).not.toContain("signalled");
});
