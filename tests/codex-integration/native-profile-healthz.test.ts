import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { helperPath, repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

/** IPC gates keep readiness and publication entry independent of wall-clock sleeps. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function event<T>(child: Bun.Subprocess, promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      child.exited.then(code => { throw new Error(`Profile-health child exited before its IPC event (${code})`); }),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Profile-health child did not reach its IPC event")), SPAWN_BUDGET_MS); }),
    ]);
  } finally { clearTimeout(timeout); }
}

/** Ask only fixture children to stop; bound cleanup if their IPC loop has failed. */
async function finish(child: Bun.Subprocess | undefined, message: string): Promise<void> {
  if (!child) return;
  const kill = setTimeout(() => child.kill(), SPAWN_BUDGET_MS);
  try {
    try { child.send(message); } catch { /* already exited */ }
    await child.exited;
  } finally { clearTimeout(kill); }
}

test("production healthz responds while a real profile switch waits for a peer publication fence", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-profile-healthz-"));
  const codexHome = join(root, "codex");
  const configDir = join(root, "opencodex");
  mkdirSync(codexHome); mkdirSync(configDir);
  const env = { ...process.env, HOME: root, CODEX_HOME: codexHome, OPENCODEX_HOME: configDir,
    NATIVE_PROFILE_HEALTHZ_ROOT: root,
    OPENCODEX_ADMIN_AUTH_TOKEN: "test-profile-healthz-admin", OPENCODEX_API_AUTH_TOKEN: "",
  };
  const ready = deferred<{ port: number; targetId: string }>();
  const armed = deferred<void>();
  const entered = deferred<void>();
  let server: Bun.Subprocess | undefined;
  let owner: Bun.Subprocess | undefined;
  let switching: Promise<Response> | undefined;
  const cancel = new AbortController();
  try {
    server = Bun.spawn([process.execPath, "--no-env-file", helperPath("native-profile-healthz-child.ts")], {
      cwd: repoRoot(), env, stdout: "ignore", stderr: "inherit",
      ipc(message) {
        if (message === "armed") armed.resolve();
        else if (message === "publication-entered") entered.resolve();
        else if (message && typeof message === "object" && "port" in message && "targetId" in message) {
          ready.resolve({ port: Number(message.port), targetId: String(message.targetId) });
        }
      },
    });
    const { port, targetId } = await event(server, ready.promise);
    const base = `http://127.0.0.1:${port}`;
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const locked = deferred<void>();
    owner = Bun.spawn([process.execPath, "--no-env-file", helperPath("native-profile-healthz-child.ts"), "hold"], {
      cwd: repoRoot(), env, stdout: "ignore", stderr: "inherit",
      ipc(message) { if (message === "locked") locked.resolve(); },
    });
    await event(owner, locked.promise);
    server.send("arm"); await event(server, armed.promise);
    switching = fetch(`${base}/api/native-main-profiles/switch`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencodex-api-key": "test-profile-healthz-admin" },
      body: JSON.stringify({ target: targetId, confirmedStopped: true }), signal: cancel.signal,
    });
    await event(server, entered.promise);
    // The production manager has entered its real writer while the peer still holds
    // the SQLite fence. Only this parent releases that lock, after the real HTTP probe.
    expect((await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(750) })).status).toBe(200);
    expect(JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8")).tokens.account_id).toBe("health-source");
    owner.send("release"); expect(await owner.exited).toBe(0);
    const response = await switching;
    expect(response.status).toBe(200);
    expect((await response.json()).activeProfile.id).toBe(targetId);
    expect(JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8")).tokens.account_id).toBe("health-target");
  } finally {
    await finish(owner, "release");
    cancel.abort();
    if (switching) await switching.catch(() => undefined);
    await finish(server, "stop");
    removeTreeWithRetry(root);
  }
}, SPAWN_BUDGET_MS * 2);
