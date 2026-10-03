import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAvailablePort } from "../../src/server/ports";
import { watchdogMs } from "../helpers/ci-watchdog";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

const DEADLINE = watchdogMs(30_000);

// Never pass credential-bearing bodies to expect(), or expose JSON parser errors.
function parseObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* Only the fixed diagnostic below may leave this boundary. */ }
  throw new Error("Expected a JSON object (body withheld)");
}

async function bootstrap(response: Response, origin: string) {
  expect(response.status, "session bootstrap HTTP status").toBe(200);
  const html = await response.text();
  const meta = (name: string) => html.match(new RegExp(`<meta name="opencodex-session-${name}" content="([^"]+)">`))?.[1];
  const token = meta("token"), csrf = meta("csrf");
  expect(typeof token === "string" && token.startsWith("ocx_session_"), "bootstrap session token present").toBe(true);
  expect(typeof csrf === "string" && csrf.length > 0, "bootstrap CSRF token present").toBe(true);
  expect(meta("origin") === origin && meta("server-origin") === origin, "exact bootstrap origins").toBe(true);
  return { token: token!, csrf: csrf! };
}

test("standalone CLI pairing crosses real HTTP admission once and stops before SSH", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-gui-pair-http-"));
  const home = join(root, "home"), ocxHome = join(root, "ocx");
  const env: Record<string, string> = {
    HOME: home, USERPROFILE: home, OPENCODEX_HOME: ocxHome, CODEX_HOME: join(root, "codex"),
    XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_DATA_HOME: join(root, "xdg-data"), XDG_STATE_HOME: join(root, "xdg-state"),
    XDG_RUNTIME_DIR: join(root, "xdg-runtime"), APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"), TMPDIR: join(root, "tmp"),
    TMP: join(root, "tmp"), TEMP: join(root, "tmp"), PATH: join(root, "empty-bin"),
    OCX_OWNER_REGISTRY_DIR: join(root, "owner-registry"), NO_PROXY: "127.0.0.1,localhost",
    OCX_TEST_HOME_GUARD: "1", OCX_DISABLE_UPDATE_CHECK: "1", OPENCODEX_KIRO_MODEL_DISCOVERY: "0",
    CODEX_CI: "1",
  };
  // Preserve only the guard's deny-list and Windows OS locator, never the parent environment.
  if (process.env.OCX_REAL_HOME) env.OCX_REAL_HOME = process.env.OCX_REAL_HOME;
  if (process.platform === "win32" && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const children = new Set<Bun.Subprocess>();
  const controller = new AbortController();
  const deadline = setTimeout(() => {
    controller.abort();
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  }, DEADLINE);
  try {
    for (const name of ["HOME", "OPENCODEX_HOME", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME",
      "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "APPDATA", "LOCALAPPDATA", "TMPDIR",
      "PATH", "OCX_OWNER_REGISTRY_DIR"]) mkdirSync(env[name]!, { recursive: true, mode: 0o700 });
    const port = await findAvailablePort(0, "127.0.0.1");
    const origin = `http://127.0.0.1:${port}`;
    writeFileSync(join(ocxHome, "config.json"), JSON.stringify({
      port, hostname: "127.0.0.1", runtimeRole: "standalone", providers: {}, defaultProvider: "openai",
      codexAutoStart: false, syncResumeHistory: false,
      clientIntegrations: { codex: false, grok: false, "claude-desktop": false },
      claudeCode: { enabled: false, systemEnv: false },
    }));
    const server = Bun.spawn([process.execPath, repoPath("src/cli/index.ts"), "start", "--port", String(port)], {
      cwd: root, env, stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    children.add(server);
    const request = (path: string, init: RequestInit = {}) => fetch(`${origin}${path}`, {
      ...init, redirect: "error", proxy: null, signal: controller.signal,
    });
    // Health must identify our child, and the runtime publication must agree before CLI discovery.
    let ready = false;
    while (!controller.signal.aborted && server.exitCode === null) {
      try {
        const health = await request("/healthz");
        const identity = parseObject(await health.text());
        if (health.status === 200 && identity.service === "opencodex"
          && identity.pid === server.pid && identity.port === port) {
          const runtime = parseObject(readFileSync(join(ocxHome, "runtime-port.json"), "utf8"));
          const readiness = await request("/readyz");
          await readiness.body?.cancel();
          ready = runtime.pid === server.pid && runtime.port === port && readiness.status === 200;
          if (ready) break;
        }
      } catch { /* Connection refusal/publication absence is expected only during bounded startup. */ }
      await Bun.sleep(25);
    }
    expect(ready, `owned CLI readiness (exit ${server.exitCode ?? "running"})`).toBe(true);
    const ordinary = await bootstrap(await request("/opencodex-session", { headers: { Origin: origin } }), origin);
    const headers = (session: typeof ordinary) => ({
      Origin: origin, "content-type": "application/json", "x-opencodex-gui-origin": origin,
      "x-opencodex-api-key": session.token, "x-opencodex-csrf-token": session.csrf,
    });
    const joinRequest = (sessionHeaders: Record<string, string>) => request("/api/link/join", {
      method: "POST", headers: sessionHeaders, body: JSON.stringify({ alias: "pair-http-unconfirmed" }),
    });
    const expectError = async (response: Response, status: number, code: string) => {
      expect(response.status, `expected ${code} HTTP status`).toBe(status);
      const body = parseObject(await response.text());
      const error = body.error;
      expect(!!error && typeof error === "object" && "code" in error && error.code === code,
        `expected error code ${code} (body withheld)`).toBe(true);
    };
    const expectStatus = async (session: typeof ordinary, paired: boolean) => {
      const response = await request("/api/link/status", { headers: headers(session) });
      expect(response.status, "link status HTTP status").toBe(200);
      const status = parseObject(await response.text());
      expect(status.joinAvailable === paired, "join availability matches session issuance").toBe(true);
      expect(status.joinDenied === (paired ? null : "pairing_required"), "exact join denial").toBe(true);
      expect(Array.isArray(status.links) && status.links.length === 0, "no durable links").toBe(true);
    };
    await expectStatus(ordinary, false);
    await expectError(await joinRequest(headers(ordinary)), 403, "forbidden");

    const mint = Bun.spawn([process.execPath, repoPath("src/cli/index.ts"), "gui", "pair", "--origin", origin, "--json"], {
      cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "ignore",
    });
    children.add(mint);
    const [mintExit, output] = await Promise.all([mint.exited, new Response(mint.stdout).text()]);
    expect(mintExit, "actual gui pair CLI exit status (output withheld)").toBe(0);
    const minted = parseObject(output);
    expect(minted.kind === "created", "CLI created a grant").toBe(true);
    expect(typeof minted.grant === "string" && minted.grant.startsWith("ocx_pair_"), "CLI grant present").toBe(true);
    expect(minted.browserOrigin === origin && minted.serverOrigin === origin, "CLI exact origin binding").toBe(true);
    const redeem = (extraHeaders: Record<string, string> = {}) => request("/opencodex-session", {
      method: "POST", headers: { Origin: origin, "content-type": "application/json", ...extraHeaders },
      body: JSON.stringify({ grant: minted.grant }),
    });
    // Refused attempts must not consume the valid grant.
    for (const extra of [{ Origin: "https://foreign.example.test" }, { Authorization: "Bearer invalid-test-credential" }]) {
      const refused = await redeem(extra);
      expect(refused.status, "wrong origin/alternate credential redemption refused").toBe(401);
      await refused.body?.cancel();
    }
    const paired = await bootstrap(await redeem(), origin);
    const replay = await redeem();
    expect(replay.status, "single-use grant replay refused").toBe(401);
    await replay.body?.cancel();
    await expectStatus(paired, true);
    await expectStatus(ordinary, false);
    for (const csrf of [undefined, "invalid-test-csrf"]) {
      const withoutCsrf = new Headers(headers(paired));
      if (csrf === undefined) withoutCsrf.delete("x-opencodex-csrf-token");
      else withoutCsrf.set("x-opencodex-csrf-token", csrf);
      const refused = await joinRequest(Object.fromEntries(withoutCsrf));
      expect(refused.status, "missing/wrong CSRF refused before join").toBe(401);
      await refused.body?.cancel();
    }
    // Fresh state has no confirmed host: production joinHome rejects BEFORE allocating a port or SSH.
    await expectError(await joinRequest(headers(paired)), 409, "host_not_confirmed");
    await expectStatus(paired, true);
    for (const file of ["links.json", "client-link.json", "child-initiated.json", "known_hosts"]) {
      expect(existsSync(join(ocxHome, "link", file)), `no durable ${file} after refused joins`).toBe(false);
    }
    expect(server.exitCode, "join denial must not restart the server").toBeNull();
  } finally {
    controller.abort();
    clearTimeout(deadline);
    const force = setTimeout(() => {
      for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    }, 2_000);
    try {
      for (const child of children) if (child.exitCode === null) child.kill();
      await Promise.all([...children].map(child => child.exited));
    } finally { clearTimeout(force); }
    removeTreeWithRetry(root);
  }
}, DEADLINE + 10_000);
