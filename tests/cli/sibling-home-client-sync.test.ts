import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCrossHomeOwner, markLiveHomeSibling } from "../../src/cli/cross-home-owner";
import { resetSiblingStartForTests, siblingOfLivePort } from "../../src/codex/sibling-start";
import { OCX_ROUTING_MARKER_LINE } from "../../src/codex/injected-marker";
import {
  LOCAL_ATTESTATION_CHALLENGE_HEADER,
  LOCAL_ATTESTATION_PROOF_HEADER,
  createLocalAttestationProof,
} from "../../src/lib/local-management-attestation";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

const originalEnv = { ...process.env };
const roots: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const children: Array<ReturnType<typeof Bun.spawn>> = [];
const detachedPids: number[] = [];
const TEST_ATTESTATION_SECRET = "A".repeat(43);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ocx-cross-home-"));
  roots.push(root);
  const home = join(root, "home");
  const ocx = join(root, "secondary");
  const codex = join(root, "codex");
  const grok = join(root, "grok");
  const claude = join(root, "claude");
  for (const dir of [home, ocx, codex, grok, claude, join(home, ".opencodex"), join(claude, "agents")]) {
    mkdirSync(dir, { recursive: true });
  }
  Object.assign(process.env, {
    HOME: home, USERPROFILE: home, OPENCODEX_HOME: ocx, CODEX_HOME: codex,
    GROK_HOME: grok, CLAUDE_CONFIG_DIR: claude,
  });
  return { root, home, ocx, codex, grok, claude };
}

function healthServer(pid: number | null, service = "opencodex") {
  let port = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: req => {
      const headers = new Headers();
      const challenge = req.headers.get(LOCAL_ATTESTATION_CHALLENGE_HEADER);
      const proof = challenge && pid !== null
        ? createLocalAttestationProof(TEST_ATTESTATION_SECRET, challenge, pid, port)
        : null;
      if (proof) headers.set(LOCAL_ATTESTATION_PROOF_HEADER, proof);
      return Response.json({ service, status: "ok", version: "0.0.0", uptime: 1, pid }, { headers });
    },
  });
  port = server.port;
  servers.push(server);
  return server.port;
}

function defaultRuntime(fx: ReturnType<typeof fixture>, pid: number, port: number) {
  writeFileSync(join(fx.home, ".opencodex", "runtime-port.json"), JSON.stringify({
    pid, port, attestationSecret: TEST_ATTESTATION_SECRET,
  }));
}

function grokFence(port: number | string) {
  return `# user content\n# >>> opencodex managed block — do not edit (removed by \`ocx stop\`) >>>\n[model_providers.opencodex]\nbase_url = "http://127.0.0.1:${port}/v1"\n# <<< opencodex managed block <<<\n`;
}

function codexRouting(port: number | string) {
  return `model_provider = "opencodex"\n[model_providers.opencodex]\nbase_url = "http://127.0.0.1:${port}/v1"\n`;
}

async function waitForRuntime(path: string, child: ReturnType<typeof Bun.spawn>) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        const record = JSON.parse(readFileSync(path, "utf8")) as { pid: number; port: number; siblingOfPort?: number };
        if (record.pid === child.pid) return record;
      } catch { /* publication in progress */ }
    }
    if (child.exitCode !== null) throw new Error(`secondary exited ${child.exitCode}: ${await new Response(child.stderr).text()}`);
    await Bun.sleep(20);
  }
  throw new Error("timed out waiting for secondary runtime record");
}

async function waitForClientStartup(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out waiting for client startup")), 15_000);
  });
  try {
    while (!output.includes("Client startup work complete.")) {
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk.done) throw new Error(`secondary exited before client startup: ${output}`);
      output += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

afterEach(async () => {
  resetSiblingStartForTests();
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  for (const child of children.splice(0)) await child.exited;
  for (const pid of detachedPids.splice(0)) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ }
  }
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
  for (const key of ["HOME", "USERPROFILE", "OPENCODEX_HOME", "CODEX_HOME", "GROK_HOME", "CLAUDE_CONFIG_DIR"]) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

test("cross-home discovery marks only a live other-process owner", async () => {
  const fx = fixture();
  const path = join(fx.grok, "config.toml");
  const probe = async () => {
    // A fresh process makes node:os resolve the fixture HOME before importing the CLI.
    const script = `const { markCrossHomeSibling } = await import(${JSON.stringify(repoPath("src/cli/cross-home-owner.ts"))});
      const { siblingOfLivePort } = await import(${JSON.stringify(repoPath("src/codex/sibling-start.ts"))});
      console.log(JSON.stringify({ marked: await markCrossHomeSibling(), port: siblingOfLivePort() }));`;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: fx.root, env: { ...process.env, NO_PROXY: "127.0.0.1,localhost" }, stdout: "pipe", stderr: "pipe",
    });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    return JSON.parse(output.trim()) as { marked: boolean; port: number | null };
  };
  expect(await probe()).toEqual({ marked: false, port: null });
  const ownerPort = healthServer(process.pid);
  defaultRuntime(fx, process.pid, ownerPort);
  writeFileSync(path, grokFence(ownerPort));
  expect(await probe()).toEqual({ marked: true, port: ownerPort });
});

test("large managed configs do not hide an attested default-home owner", async () => {
  const fx = fixture();
  const ownerPid = process.pid + 1;
  const port = healthServer(ownerPid);
  defaultRuntime(fx, ownerPid, port);
  const grokPath = join(fx.grok, "config.toml");
  const codexPath = join(fx.codex, "config.toml");
  writeFileSync(grokPath, `${"# padding\n".repeat(30_000)}${grokFence(port)}`);
  expect(await findCrossHomeOwner({ homeDir: fx.home })).toBe(port);
  writeFileSync(grokPath, `${grokFence(port)}${"#".repeat(16 * 1024 * 1024)}`);
  expect(await findCrossHomeOwner({ homeDir: fx.home })).toBe(port);
  writeFileSync(grokPath, "# no managed fence\n");
  writeFileSync(codexPath, `${"# padding\n".repeat(30_000)}${codexRouting(port)}`);
  expect(await findCrossHomeOwner({ homeDir: fx.home })).toBe(port);
});

test("Design B marker-owned root routing reveals the owner port", async () => {
  const fx = fixture();
  const ownerPid = process.pid + 1;
  const port = healthServer(ownerPid);
  defaultRuntime(fx, ownerPid, port);
  writeFileSync(join(fx.codex, "config.toml"), [
    OCX_ROUTING_MARKER_LINE,
    `openai_base_url = "http://127.0.0.1:${port}/v1"`,
    OCX_ROUTING_MARKER_LINE,
    `experimental_realtime_ws_base_url = "http://127.0.0.1:${port}/v1"`,
    'model = "gpt-5.5"',
    "",
  ].join("\n"));
  expect(await findCrossHomeOwner({ homeDir: fx.home })).toBe(port);
});

test("live local sibling record marks a fresh ensure decision during primary downtime", async () => {
  const fx = fixture();
  const secondaryPort = healthServer(process.pid + 1);
  const primaryPort = secondaryPort === 10100 ? 10101 : 10100;
  writeFileSync(join(fx.ocx, "runtime-port.json"), JSON.stringify({
    pid: process.pid + 1, port: secondaryPort, siblingOfPort: primaryPort,
  }));
  expect(await findCrossHomeOwner({ homeDir: fx.home })).toBeNull();
  expect(await markLiveHomeSibling({ pid: process.pid + 1, port: secondaryPort })).toBe(true);
  expect(siblingOfLivePort()).toBe(primaryPort);
});

test("only a distinct live identity in the default-home record counts", async () => {
  const fx = fixture();
  const port = healthServer(process.pid + 1);
  const record = join(fx.home, ".opencodex", "runtime-port.json");
  writeFileSync(record, JSON.stringify({ pid: process.pid + 1, port, attestationSecret: TEST_ATTESTATION_SECRET }));
  expect(await findCrossHomeOwner({ homeDir: fx.home })).toBe(port);
  writeFileSync(record, JSON.stringify({ pid: process.pid, port, attestationSecret: TEST_ATTESTATION_SECRET }));
  expect(await findCrossHomeOwner({ homeDir: fx.home })).toBeNull();
});

test.skipIf(process.platform === "win32")("a FIFO in place of a hint file cannot stall discovery", async () => {
  const fx = fixture();
  const record = join(fx.home, ".opencodex", "runtime-port.json");
  expect(Bun.spawnSync(["mkfifo", record]).exitCode).toBe(0);
  expect(Bun.spawnSync(["mkfifo", join(fx.grok, "config.toml")]).exitCode).toBe(0);
  const started = performance.now();
  expect(await findCrossHomeOwner({ homeDir: fx.home })).toBeNull();
  expect(performance.now() - started).toBeLessThan(2_000);
}, 5_000);

test("malformed managed hints do not override an attested default-home owner", async () => {
  const fx = fixture();
  const ownerPid = process.pid + 1;
  const port = healthServer(ownerPid);
  defaultRuntime(fx, ownerPid, port);
  const grokPath = join(fx.grok, "config.toml");
  const codexPath = join(fx.codex, "config.toml");
  writeFileSync(grokPath, grokFence(port));
  expect(await findCrossHomeOwner({ homeDir: fx.home })).toBe(port);
  writeFileSync(grokPath, "# no managed fence\n");
  writeFileSync(codexPath, codexRouting(port));
  expect(await findCrossHomeOwner({ homeDir: fx.home })).toBe(port);
  writeFileSync(codexPath, codexRouting("invalid"));
  expect(await findCrossHomeOwner({ homeDir: fx.home })).toBe(port);
});

test("same PID, null PID, foreign, stale and remote hints grant no sibling ownership", async () => {
  const fx = fixture();
  const grokPath = join(fx.grok, "config.toml");
  for (const pid of [process.pid, null]) {
    const port = healthServer(pid);
    writeFileSync(grokPath, grokFence(port));
    expect(await findCrossHomeOwner({ homeDir: fx.home })).toBeNull();
  }
  const foreign = healthServer(process.pid + 1, "another-service");
  writeFileSync(grokPath, grokFence(foreign));
  expect(await findCrossHomeOwner({ homeDir: fx.home })).toBeNull();
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("closed") });
  const stale = closed.port;
  closed.stop(true);
  writeFileSync(grokPath, grokFence(stale));
  expect(await findCrossHomeOwner({ homeDir: fx.home })).toBeNull();
  writeFileSync(grokPath, grokFence("not-a-port"));
  expect(await findCrossHomeOwner({ homeDir: fx.home })).toBeNull();
  writeFileSync(grokPath, grokFence(foreign).replace("127.0.0.1", "example.com"));
  expect(await findCrossHomeOwner({ homeDir: fx.home })).toBeNull();
  writeFileSync(join(fx.codex, "config.toml"), codexRouting(foreign).replace("127.0.0.1", "example.com"));
  expect(await findCrossHomeOwner({ homeDir: fx.home })).toBeNull();
});

test("a forged health identity without the default home's attestation grants no ownership", async () => {
  const fx = fixture();
  const forgedPid = 1_000_000_000;
  const port = healthServer(forgedPid);
  writeFileSync(join(fx.grok, "config.toml"), grokFence(port));
  writeFileSync(join(fx.home, ".opencodex", "runtime-port.json"), JSON.stringify({
    pid: forgedPid, port, attestationSecret: "B".repeat(43),
  }));
  expect(await findCrossHomeOwner({ homeDir: fx.home })).toBeNull();
});

test("a secondary start preserves shared client bytes and records the sibling owner", async () => {
  const fx = fixture();
  const fakeOwnerPid = 1_000_000_000;
  const ownerPort = healthServer(fakeOwnerPid);
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
  const secondaryPort = reservation.port;
  reservation.stop(true);
  defaultRuntime(fx, fakeOwnerPid, ownerPort);
  const grokPath = join(fx.grok, "config.toml");
  const codexPath = join(fx.codex, "config.toml");
  const claudePath = join(fx.claude, "agents", "ocx-existing.md");
  writeFileSync(grokPath, grokFence(ownerPort));
  writeFileSync(codexPath, codexRouting(ownerPort));
  writeFileSync(claudePath, "owned roster bytes\n");
  const before = [grokPath, codexPath, claudePath].map(path => readFileSync(path));
  writeFileSync(join(fx.ocx, "config.json"), JSON.stringify({
    port: secondaryPort, hostname: "127.0.0.1", codexAutoStart: false, syncResumeHistory: false,
    checkForUpdates: false, clientIntegrations: { codex: true, grok: true, "claude-desktop": false },
    claudeCode: { injectAgents: false, systemEnv: false }, providers: {}, defaultProvider: "openai",
  }));
  const child = Bun.spawn([process.execPath, repoPath("src/cli/index.ts"), "start", "--port", String(secondaryPort)], {
    cwd: fx.root, env: { ...process.env, NO_PROXY: "127.0.0.1,localhost" }, stdout: "pipe", stderr: "pipe",
  });
  children.push(child);
  const runtime = await waitForRuntime(join(fx.ocx, "runtime-port.json"), child);
  expect(runtime.siblingOfPort).toBe(ownerPort);
  await waitForClientStartup(child);
  expect([grokPath, codexPath, claudePath].map(path => readFileSync(path))).toEqual(before);
  child.kill("SIGTERM");
  await child.exited;
  expect([grokPath, codexPath, claudePath].map(path => readFileSync(path))).toEqual(before);
}, 30_000);

test("a secondary ensure parent preserves shared Grok, Codex and Claude agent bytes", async () => {
  const fx = fixture();
  const ownerPort = healthServer(process.pid);
  defaultRuntime(fx, process.pid, ownerPort);
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
  const secondaryPort = reservation.port;
  reservation.stop(true);
  const grokPath = join(fx.grok, "config.toml");
  const codexPath = join(fx.codex, "config.toml");
  const claudePath = join(fx.claude, "agents", "ocx-existing.md");
  writeFileSync(grokPath, grokFence(ownerPort));
  writeFileSync(codexPath, codexRouting(ownerPort));
  writeFileSync(claudePath, "---\ngenerated-by: opencodex\n---\nowner roster\n");
  const before = [grokPath, codexPath, claudePath].map(path => readFileSync(path));
  writeFileSync(join(fx.ocx, "config.json"), JSON.stringify({
    port: secondaryPort, hostname: "127.0.0.1", codexAutoStart: true, syncResumeHistory: false,
    checkForUpdates: false, clientIntegrations: { codex: true, grok: true, "claude-desktop": false },
    claudeCode: { injectAgents: false, systemEnv: false }, providers: {}, defaultProvider: "openai",
  }));
  const ensure = Bun.spawn([process.execPath, repoPath("src/cli/index.ts"), "ensure"], {
    cwd: fx.root, env: { ...process.env, NO_PROXY: "127.0.0.1,localhost" }, stdout: "pipe", stderr: "pipe",
  });
  children.push(ensure);
  const output = await new Response(ensure.stdout).text();
  const error = await new Response(ensure.stderr).text();
  expect(await ensure.exited).toBe(0);
  expect(output + error).toContain(`Proxy running on port ${secondaryPort}`);
  const runtime = JSON.parse(readFileSync(join(fx.ocx, "runtime-port.json"), "utf8")) as {
    pid: number; port: number; siblingOfPort?: number;
  };
  detachedPids.push(runtime.pid);
  expect(runtime.siblingOfPort).toBe(ownerPort);
  expect([grokPath, codexPath, claudePath].map(path => readFileSync(path))).toEqual(before);

  // A fresh ensure parent sees this home's live sibling after the primary goes down.
  servers.pop()?.stop(true);
  const again = Bun.spawn([process.execPath, repoPath("src/cli/index.ts"), "ensure"], {
    cwd: fx.root, env: { ...process.env, NO_PROXY: "127.0.0.1,localhost" }, stdout: "pipe", stderr: "pipe",
  });
  children.push(again);
  await new Response(again.stdout).text();
  await new Response(again.stderr).text();
  expect(await again.exited).toBe(0);
  expect([grokPath, codexPath, claudePath].map(path => readFileSync(path))).toEqual(before);
}, 30_000);

test("a lone custom-home start still syncs Grok and prunes its own Claude roster", async () => {
  const fx = fixture();
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
  const port = reservation.port;
  reservation.stop(true);
  const grokPath = join(fx.grok, "config.toml");
  const claudePath = join(fx.claude, "agents", "ocx-existing.md");
  writeFileSync(grokPath, grokFence(12345));
  writeFileSync(claudePath, "---\ngenerated-by: opencodex\n---\nold roster\n");
  writeFileSync(join(fx.ocx, "config.json"), JSON.stringify({
    port, hostname: "127.0.0.1", codexAutoStart: true, syncResumeHistory: false,
    checkForUpdates: false, clientIntegrations: { codex: false, grok: true, "claude-desktop": false },
    claudeCode: { injectAgents: false, systemEnv: false }, providers: {}, defaultProvider: "openai",
  }));
  const child = Bun.spawn([process.execPath, repoPath("src/cli/index.ts"), "start", "--port", String(port)], {
    cwd: fx.root, env: { ...process.env, NO_PROXY: "127.0.0.1,localhost" }, stdout: "pipe", stderr: "pipe",
  });
  children.push(child);
  const runtime = await waitForRuntime(join(fx.ocx, "runtime-port.json"), child);
  expect(runtime.siblingOfPort).toBeUndefined();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && readFileSync(grokPath, "utf8").includes("127.0.0.1:12345")) await Bun.sleep(20);
  expect(readFileSync(grokPath, "utf8")).toContain(`127.0.0.1:${port}`);
  expect(existsSync(claudePath)).toBe(false);
  writeFileSync(claudePath, "---\ngenerated-by: opencodex\n---\nstale roster\n");
  const ensure = Bun.spawn([process.execPath, repoPath("src/cli/index.ts"), "ensure"], {
    cwd: fx.root, env: { ...process.env, NO_PROXY: "127.0.0.1,localhost" }, stdout: "pipe", stderr: "pipe",
  });
  children.push(ensure);
  await new Response(ensure.stdout).text();
  await new Response(ensure.stderr).text();
  expect(await ensure.exited).toBe(0);
  expect(existsSync(claudePath)).toBe(false);
}, 30_000);
