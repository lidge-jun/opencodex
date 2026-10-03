import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCrossHomeOwner, findCrossHomeOwnerDetailed, markCrossHomeSibling, markLiveHomeSibling } from "../../src/cli/cross-home-owner";
import { ownerRegistryDir, readOwnerRegistry, registerOwnerRegistryHome } from "../../src/config/owner-registry";
import { removeRuntimePort, writeRuntimePort } from "../../src/config/process-state";
import { directLocalHttpFetch } from "../../src/server/direct-local-http";
import { resetSiblingStartForTests, siblingOfLivePort } from "../../src/codex/sibling-start";
import { OCX_ROUTING_MARKER_LINE } from "../../src/codex/injected-marker";
import {
  LOCAL_ATTESTATION_CHALLENGE_HEADER,
  LOCAL_ATTESTATION_PROOF_HEADER,
  createLocalAttestationProof,
} from "../../src/lib/local-management-attestation";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";
import { captureStartupChildOutput, STARTUP_OUTPUT_TAIL_CHARS } from "../helpers/startup-child-output";

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
    // os.homedir() reads the passwd database, not $HOME, so the owner registry's
    // default-home anchor cannot be moved by the HOME rewrite above; point its
    // documented seam at this fixture's stand-in for the default ~/.opencodex.
    OCX_OWNER_REGISTRY_DIR: join(home, ".opencodex", "ocx-homes"),
  });
  return { root, home, ocx, codex, grok, claude };
}

function healthServer(pid: number | null, service = "opencodex", listen: { hostname?: string; port?: number } = {}) {
  let port = 0;
  const server = Bun.serve({
    hostname: listen.hostname ?? "127.0.0.1", port: listen.port ?? 0,
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

const capturedChildren = new Map<ReturnType<typeof Bun.spawn>, ReturnType<typeof captureStartupChildOutput>>();
function trackChild(child: ReturnType<typeof Bun.spawn>) {
  children.push(child);
  capturedChildren.set(child, captureStartupChildOutput(child.stdout, child.stderr));
}
function childDiagnostics(child: ReturnType<typeof Bun.spawn>): string {
  return JSON.stringify({ pid: child.pid, exitCode: child.exitCode, ...capturedChildren.get(child)!.snapshot() });
}
async function finishChildOutput(child: ReturnType<typeof Bun.spawn>) {
  await child.exited;
  return capturedChildren.get(child)!.finish();
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
    if (child.exitCode !== null) {
      await finishChildOutput(child);
      throw new Error(`secondary exited before runtime publication: ${childDiagnostics(child)}`);
    }
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for secondary runtime record: ${childDiagnostics(child)}`);
}

async function waitForClientStartup(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (capturedChildren.get(child)!.snapshot().startupComplete) return;
    if (child.exitCode !== null) {
      const output = await finishChildOutput(child);
      if (output.startupComplete) return;
      throw new Error(`secondary exited before client startup: ${childDiagnostics(child)}`);
    }
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for client startup: ${childDiagnostics(child)}`);
}

afterEach(async () => {
  resetSiblingStartForTests();
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  for (const child of children.splice(0)) await child.exited;
  for (const capture of capturedChildren.values()) await capture.finish();
  capturedChildren.clear();
  for (const pid of detachedPids.splice(0)) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ }
  }
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
  for (const key of ["HOME", "USERPROFILE", "OPENCODEX_HOME", "CODEX_HOME", "GROK_HOME", "CLAUDE_CONFIG_DIR", "OCX_OWNER_REGISTRY_DIR"]) {
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

test("the recorded ::1 owner is found beside an IPv4 listener on the same port", async () => {
  const fx = fixture();
  const ownerPid = process.pid + 1;
  let v6: ReturnType<typeof Bun.serve>;
  try {
    v6 = Bun.serve({
      hostname: "::1", port: 0,
      fetch: req => {
        const headers = new Headers();
        const challenge = req.headers.get(LOCAL_ATTESTATION_CHALLENGE_HEADER);
        const proof = challenge
          ? createLocalAttestationProof(TEST_ATTESTATION_SECRET, challenge, ownerPid, v6.port)
          : null;
        if (proof) headers.set(LOCAL_ATTESTATION_PROOF_HEADER, proof);
        return Response.json({ service: "opencodex", status: "ok", version: "0.0.0", uptime: 1, pid: ownerPid }, { headers });
      },
    });
  } catch {
    return; // IPv6 loopback is unavailable on this host.
  }
  servers.push(v6);
  const port = v6.port;
  // A different opencodex-looking process holds only the IPv4 loopback of the same
  // port. Its pid mismatch must not mask the recorded ::1 owner.
  try {
    healthServer(ownerPid + 1, "opencodex", { hostname: "127.0.0.1", port });
  } catch { /* the IPv6 bind is dual-stack on this host; the owner still answers */ }
  const record = join(fx.home, ".opencodex", "runtime-port.json");
  const writeRecord = (hostname?: string) => writeFileSync(record, JSON.stringify({
    pid: ownerPid, port, attestationSecret: TEST_ATTESTATION_SECRET,
    ...(hostname === undefined ? {} : { hostname }),
  }));
  writeRecord("::1");
  expect(await findCrossHomeOwner({ homeDir: fx.home })).toBe(port);
  // A record without a hostname keeps trying every loopback family instead of
  // stopping at the first IPv4 answer.
  writeRecord();
  expect(await findCrossHomeOwner({ homeDir: fx.home })).toBe(port);
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
  trackChild(child);
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
  trackChild(ensure);
  const captured = await finishChildOutput(ensure);
  const output = captured.stdout.tail;
  const error = captured.stderr.tail;
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
  trackChild(again);
  await finishChildOutput(again);
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
  trackChild(child);
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
  trackChild(ensure);
  await finishChildOutput(ensure);
  expect(await ensure.exited).toBe(0);
  expect(existsSync(claudePath)).toBe(false);
}, 30_000);

test("a registered custom-home owner is proven through its own runtime record", async () => {
  const fx = fixture();
  const ownerPid = process.pid + 1;
  const port = healthServer(ownerPid);
  const homeA = join(fx.root, "homeA", ".opencodex");
  mkdirSync(homeA, { recursive: true });
  writeFileSync(join(homeA, "runtime-port.json"), JSON.stringify({
    pid: ownerPid, port, attestationSecret: TEST_ATTESTATION_SECRET,
  }));
  writeFileSync(join(fx.grok, "config.toml"), grokFence(port));

  // Before registration no record names the listener: unverifiable is not absent.
  const verdict = await findCrossHomeOwnerDetailed({ homeDir: fx.home });
  expect(verdict.kind).toBe("indeterminate");
  expect(verdict.kind === "indeterminate" ? verdict.port : null).toBe(port);
  expect(await markCrossHomeSibling()).toBe(true);
  resetSiblingStartForTests();

  registerOwnerRegistryHome(homeA);
  expect(readOwnerRegistry().homes).toContain(homeA);
  expect(await findCrossHomeOwner({ homeDir: fx.home })).toBe(port);
});

test("a live legacy record without an attestation secret fails closed", async () => {
  const fx = fixture();
  const ownerPid = process.pid + 1;
  const port = healthServer(ownerPid);
  writeFileSync(join(fx.home, ".opencodex", "runtime-port.json"), JSON.stringify({
    pid: ownerPid, port,
  }));
  writeFileSync(join(fx.grok, "config.toml"), grokFence(port));
  const verdict = await findCrossHomeOwnerDetailed({ homeDir: fx.home });
  expect(verdict.kind).toBe("indeterminate");
  expect(await markCrossHomeSibling()).toBe(true);
  expect(siblingOfLivePort()).toBe(port);
});

test("a dropped attestation probe retries inside the shared deadline", async () => {
  const fx = fixture();
  const ownerPid = process.pid + 1;
  const port = healthServer(ownerPid);
  defaultRuntime(fx, ownerPid, port);
  writeFileSync(join(fx.grok, "config.toml"), grokFence(port));
  let calls = 0;
  const flakyFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    // The identity probe answers; the first attestation is lost, the retry wins.
    if (calls === 2) throw new TypeError("fetch failed");
    return directLocalHttpFetch(input, init);
  }) as typeof fetch;
  const verdict = await findCrossHomeOwnerDetailed({
    homeDir: fx.home,
    io: { fetchFn: flakyFetch, sleepFn: () => Promise.resolve() },
  });
  expect(verdict).toEqual({ kind: "owner", port });
  expect(calls).toBe(3);
});

test("one shared deadline bounds every candidate probe", async () => {
  const fx = fixture();
  const port = healthServer(process.pid + 1);
  defaultRuntime(fx, process.pid + 1, port);
  writeFileSync(join(fx.grok, "config.toml"), grokFence(port));
  let calls = 0;
  const countingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    return directLocalHttpFetch(input, init);
  }) as typeof fetch;
  const verdict = await findCrossHomeOwnerDetailed({
    homeDir: fx.home,
    io: { fetchFn: countingFetch, deadlineAt: 0, nowFn: () => 0 },
  });
  expect(verdict.kind).toBe("indeterminate");
  expect(calls).toBe(0);
});

test("an attested sibling record defers to the owner port it names", async () => {
  const fx = fixture();
  const siblingPid = process.pid + 1;
  const ownerPid = process.pid + 2;
  const siblingPort = healthServer(siblingPid);
  const ownerPort = healthServer(ownerPid);
  const homeA = join(fx.root, "homeA", ".opencodex");
  mkdirSync(homeA, { recursive: true });
  writeFileSync(join(homeA, "runtime-port.json"), JSON.stringify({
    pid: siblingPid, port: siblingPort, siblingOfPort: ownerPort,
  }));
  const homeB = join(fx.root, "homeB", ".opencodex");
  mkdirSync(homeB, { recursive: true });
  writeFileSync(join(homeB, "runtime-port.json"), JSON.stringify({
    pid: ownerPid, port: ownerPort, attestationSecret: TEST_ATTESTATION_SECRET,
  }));
  registerOwnerRegistryHome(homeA);
  registerOwnerRegistryHome(homeB);
  expect(await findCrossHomeOwner({ homeDir: fx.home })).toBe(ownerPort);
});

test("publishing a runtime record registers the home for cross-home discovery", () => {
  const fx = fixture();
  writeRuntimePort({ pid: process.pid, port: 0 });
  expect(readOwnerRegistry().homes).toContain(fx.ocx);
});

test("registry publication hardens its directory and replaces entry symlinks without following", () => {
  if (process.platform === "win32") return;
  const fx = fixture();
  const registryDir = ownerRegistryDir();
  mkdirSync(registryDir, { recursive: true });
  chmodSync(registryDir, 0o777);
  writeFileSync(join(fx.ocx, "runtime-port.json"), "{}\n");
  registerOwnerRegistryHome(fx.ocx);
  expect(lstatSync(registryDir).mode & 0o777).toBe(0o700);

  const entry = join(registryDir, readdirSync(registryDir)[0]!);
  const canary = join(fx.ocx, "credential-canary");
  writeFileSync(canary, "private bytes\n", { mode: 0o600 });
  unlinkSync(entry);
  symlinkSync(canary, entry);
  registerOwnerRegistryHome(fx.ocx);

  expect(readFileSync(canary, "utf8")).toBe("private bytes\n");
  expect(lstatSync(entry).isSymbolicLink()).toBe(false);
  expect(readOwnerRegistry().homes).toContain(fx.ocx);
});

test("removing a runtime record retires its registry pointer", () => {
  const fx = fixture();
  writeRuntimePort({ pid: process.pid, port: 42101 });
  expect(readOwnerRegistry().homes).toContain(fx.ocx);
  removeRuntimePort(process.pid);
  expect(readOwnerRegistry().homes).not.toContain(fx.ocx);
});

test("stale registry pointers are pruned before they can crowd out a live owner", async () => {
  const fx = fixture();
  // More dead pointers than the entry cap, each naming a home that no longer
  // publishes a record - the pile must not hide the registered live owner.
  // Pointer files are written directly: the production register call pays an
  // atomic fsync per entry, which alone would blow the test's own budget here.
  mkdirSync(ownerRegistryDir(), { recursive: true });
  for (let i = 0; i < 70; i++) {
    writeFileSync(join(ownerRegistryDir(), "dead-" + i + ".json"), JSON.stringify({ home: join(fx.root, "dead" + i, ".opencodex") }));
  }
  const ownerPid = process.pid + 1;
  const port = healthServer(ownerPid);
  const homeA = join(fx.root, "homeA", ".opencodex");
  mkdirSync(homeA, { recursive: true });
  writeFileSync(join(homeA, "runtime-port.json"), JSON.stringify({
    pid: ownerPid, port, attestationSecret: TEST_ATTESTATION_SECRET,
  }));
  registerOwnerRegistryHome(homeA);
  const registry = readOwnerRegistry();
  expect(registry.homes).toContain(homeA);
  expect(registry.truncated).toBe(false);
  expect(await findCrossHomeOwner({ homeDir: fx.home })).toBe(port);
});

test("a registry listing too deep to scan fully reports truncation instead of a false none", async () => {
  const fx = fixture();
  // Entries whose homes still publish records pass the existence prune, so the
  // result cap is the bound that actually cuts off the owner - truncation, not
  // a confident none, is the only honest answer left.
  mkdirSync(ownerRegistryDir(), { recursive: true });
  for (let i = 0; i < 70; i++) {
    const deadHome = join(fx.root, "full" + i, ".opencodex");
    mkdirSync(deadHome, { recursive: true });
    writeFileSync(join(deadHome, "runtime-port.json"), JSON.stringify({ pid: process.pid + 1000 + i, port: 1 }));
    writeFileSync(join(ownerRegistryDir(), "full-" + i + ".json"), JSON.stringify({ home: deadHome }));
  }
  const registry = readOwnerRegistry();
  expect(registry.truncated).toBe(true);
  expect(registry.homes.length).toBe(64);
  const verdict = await findCrossHomeOwnerDetailed({ homeDir: fx.home });
  expect(verdict.kind).toBe("indeterminate");
});

test("an unlocated owner refuses start and ensure rather than claiming an unmarked sibling", async () => {
  const fx = fixture();
  mkdirSync(ownerRegistryDir(), { recursive: true });
  // Existing but malformed records pass the registry's existence check without
  // supplying a port to probe. Its result cap leaves ownership indeterminate.
  for (let i = 0; i < 65; i++) {
    const home = join(fx.root, "unlocated-" + i);
    mkdirSync(home);
    writeFileSync(join(home, "runtime-port.json"), "{}\n");
    writeFileSync(join(ownerRegistryDir(), "unlocated-" + i + ".json"), JSON.stringify({ home }));
  }
  expect(readOwnerRegistry().truncated).toBe(true);
  expect(await findCrossHomeOwnerDetailed({ homeDir: fx.home })).toMatchObject({ kind: "indeterminate", port: null });
  await expect(markCrossHomeSibling()).rejects.toThrow("refusing startup");
  expect(siblingOfLivePort()).toBeNull();
  await expect(markLiveHomeSibling({ pid: process.pid, port: 42101 })).rejects.toThrow("refusing startup");
  expect(siblingOfLivePort()).toBeNull();
});

/**
 * Shared start-to-shutdown acceptance for the ownership topologies that must veto
 * shared-client writes: the managed Grok/Codex routing and the Claude roster keep
 * their exact bytes across the secondary's whole lifecycle.
 */
async function secondaryStartPreservesBytes(
  fx: ReturnType<typeof fixture>,
  ownerPort: number,
  expectedSiblingPort: number,
): Promise<void> {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
  const secondaryPort = reservation.port;
  reservation.stop(true);
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
  trackChild(child);
  const runtime = await waitForRuntime(join(fx.ocx, "runtime-port.json"), child);
  expect(runtime.siblingOfPort).toBe(expectedSiblingPort);
  await waitForClientStartup(child);
  expect([grokPath, codexPath, claudePath].map(path => readFileSync(path))).toEqual(before);
  child.kill("SIGTERM");
  await child.exited;
  expect([grokPath, codexPath, claudePath].map(path => readFileSync(path))).toEqual(before);
}

test("a custom-home owner discovered through the registry vetoes shared writes end to end", async () => {
  const fx = fixture();
  const ownerPid = process.pid + 1;
  const ownerPort = healthServer(ownerPid);
  const homeA = join(fx.root, "homeA", ".opencodex");
  mkdirSync(homeA, { recursive: true });
  writeFileSync(join(homeA, "runtime-port.json"), JSON.stringify({
    pid: ownerPid, port: ownerPort, attestationSecret: TEST_ATTESTATION_SECRET,
  }));
  registerOwnerRegistryHome(homeA);
  await secondaryStartPreservesBytes(fx, ownerPort, ownerPort);
}, 30_000);

test("an unreadable listener on a managed port vetoes shared writes end to end", async () => {
  const fx = fixture();
  // HTTP 500 is neither a connection refusal nor an opencodex identity: the
  // classification is unknown, so ownership is indeterminate and must fail closed.
  const managed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unreadable", { status: 500 }) });
  servers.push(managed);
  const ownerPort = managed.port;
  await secondaryStartPreservesBytes(fx, ownerPort, ownerPort);
}, 30_000);

test("a live legacy record without an attestation secret vetoes shared writes end to end", async () => {
  const fx = fixture();
  const ownerPid = process.pid + 1;
  const ownerPort = healthServer(ownerPid);
  const homeA = join(fx.root, "homeA", ".opencodex");
  mkdirSync(homeA, { recursive: true });
  writeFileSync(join(homeA, "runtime-port.json"), JSON.stringify({
    pid: ownerPid, port: ownerPort,
  }));
  registerOwnerRegistryHome(homeA);
  await secondaryStartPreservesBytes(fx, ownerPort, ownerPort);
}, 30_000);

test("a registry-only discovered owner vetoes shared writes end to end", async () => {
  const fx = fixture();
  // No managed URL in any shared client: the registry pointer is the only way a
  // secondary can find this owner, so the e2e proves registry discovery rather
  // than the URL-hint path the other end-to-end cases already cover.
  const ownerPid = process.pid + 1;
  const ownerPort = healthServer(ownerPid);
  const homeA = join(fx.root, "homeA", ".opencodex");
  mkdirSync(homeA, { recursive: true });
  writeFileSync(join(homeA, "runtime-port.json"), JSON.stringify({
    pid: ownerPid, port: ownerPort, attestationSecret: TEST_ATTESTATION_SECRET,
  }));
  registerOwnerRegistryHome(homeA);
  const grokPath = join(fx.grok, "config.toml");
  const codexPath = join(fx.codex, "config.toml");
  const claudePath = join(fx.claude, "agents", "ocx-existing.md");
  writeFileSync(grokPath, "# user content\n");
  writeFileSync(codexPath, "model = \"gpt-6\"\n");
  writeFileSync(claudePath, "owned roster bytes\n");
  const before = [grokPath, codexPath, claudePath].map(path => readFileSync(path));
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
  const secondaryPort = reservation.port;
  reservation.stop(true);
  writeFileSync(join(fx.ocx, "config.json"), JSON.stringify({
    port: secondaryPort, hostname: "127.0.0.1", codexAutoStart: false, syncResumeHistory: false,
    checkForUpdates: false, clientIntegrations: { codex: true, grok: true, "claude-desktop": false },
    claudeCode: { injectAgents: false, systemEnv: false }, providers: {}, defaultProvider: "openai",
  }));
  const child = Bun.spawn([process.execPath, repoPath("src/cli/index.ts"), "start", "--port", String(secondaryPort)], {
    cwd: fx.root, env: { ...process.env, NO_PROXY: "127.0.0.1,localhost" }, stdout: "pipe", stderr: "pipe",
  });
  trackChild(child);
  const runtime = await waitForRuntime(join(fx.ocx, "runtime-port.json"), child);
  expect(runtime.siblingOfPort).toBe(ownerPort);
  await waitForClientStartup(child);
  expect([grokPath, codexPath, claudePath].map(path => readFileSync(path))).toEqual(before);
  child.kill("SIGTERM");
  await child.exited;
  expect([grokPath, codexPath, claudePath].map(path => readFileSync(path))).toEqual(before);
}, 30_000);

test("startup diagnostics drain both pipes before runtime publication", async () => {
  const fx = fixture();
  const runtimePath = join(fx.ocx, "runtime-port.json");
  const script = `
    import { writeFileSync } from "node:fs";
    const write = (stream, text) => new Promise((resolve, reject) => stream.write(text, error => error ? reject(error) : resolve()));
    await write(process.stdout, "Client startup work complete.\\n");
    await Promise.all([process.stdout, process.stderr].map(async stream => {
      for (let i = 0; i < 128; i++) await write(stream, "x".repeat(65536));
    }));
    await write(process.stdout, "stdout-tail\\n");
    await write(process.stderr, "stderr-tail\\n");
    writeFileSync(${JSON.stringify(runtimePath)}, JSON.stringify({ pid: process.pid, port: 1 }));
    setInterval(() => {}, 1000);
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: fx.root, env: { ...process.env }, stdout: "pipe", stderr: "pipe",
  });
  trackChild(child);
  expect((await waitForRuntime(runtimePath, child)).pid).toBe(child.pid);
  await waitForClientStartup(child);
  child.kill("SIGTERM");
  const captured = await finishChildOutput(child);
  expect(captured.stdout.tail.length).toBeLessThanOrEqual(STARTUP_OUTPUT_TAIL_CHARS);
  expect(captured.stderr.tail.length).toBeLessThanOrEqual(STARTUP_OUTPUT_TAIL_CHARS);
  expect(captured.stdout.tail).toContain("stdout-tail");
  expect(captured.stderr.tail).toContain("stderr-tail");
  expect(captured.stdout.tail).not.toContain("Client startup work complete.");
  expect(captured.startupComplete).toBe(true);
}, 30_000);

test("startup diagnostics include both child tails and exit state on publication failure", async () => {
  const fx = fixture();
  const child = Bun.spawn([process.execPath, "-e", 'console.log("before-publication"); console.error("fixture-start-failure"); process.exitCode = 2;'], {
    cwd: fx.root, env: { ...process.env }, stdout: "pipe", stderr: "pipe",
  });
  trackChild(child);
  await child.exited;
  let failure = "";
  try { await waitForRuntime(join(fx.ocx, "runtime-port.json"), child); }
  catch (error) { failure = String(error); }
  expect(failure).toContain("before-publication");
  expect(failure).toContain("fixture-start-failure");
  expect(failure).toContain('"exitCode":2');
  expect(failure).toContain(`"pid":${child.pid}`);
  expect(failure).toContain("lastOutputAgoMs");
});

test("startup diagnostics preserve split UTF-8 and startup markers before tail eviction", async () => {
  const bytes = new TextEncoder().encode("한글 Client startup work complete.");
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.enqueue(new TextEncoder().encode("z".repeat(10000)));
      controller.close();
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of new TextEncoder().encode("오류")) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  const output = await captureStartupChildOutput(stdout, stderr).finish();
  expect(output.startupComplete).toBe(true);
  expect(output.stdout.tail).toBe("z".repeat(8192));
  expect(output.stderr.tail).toBe("오류");
  expect(output.stdout.complete && output.stderr.complete).toBe(true);
});

for (const cancellation of ["pending", "rejected"] as const) {
  test(`startup diagnostics bound ${cancellation} pipe cancellation`, async () => {
    let cancelled = 0;
    const open = () => new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("partial")); },
      cancel() {
        cancelled++;
        return cancellation === "pending" ? new Promise<void>(() => {}) : Promise.reject(new Error("fixture cancel failure"));
      },
    });
    const output = await captureStartupChildOutput(open(), open()).finish(20);
    expect(output.stdout.tail).toBe("partial");
    expect(output.stderr.tail).toBe("partial");
    expect(output.stdout.complete || output.stderr.complete).toBe(false);
    expect(cancelled).toBe(2);
  }, 2000);
}
