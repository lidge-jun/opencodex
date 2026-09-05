import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  resolveCodexCatalogSerializationDatabasePath,
  resolveEffectiveUserIdentity,
} from "../../src/codex/user-identity";
import { claimOwnedServiceHome, withOwnedServiceHomePreload } from "../helpers/owned-service-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoRoot as resolveRepoRoot } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";
import { INTERNAL_DEADLINE_MS } from "../helpers/test-budget";

const repoRoot = resolveRepoRoot();
const sandboxes: Sandbox[] = [];

interface Sandbox {
  readonly root: string;
  readonly codexHome: string;
  readonly opencodexHome: string;
  readonly env: Record<string, string>;
  readonly serviceManagerEnv: Record<string, string>;
  readonly preloadPath?: string;
  /** Every child spawned against this sandbox, so teardown can reap before deleting the root. */
  readonly children: Set<ReturnType<typeof Bun.spawn>>;
  /** Release markers a lock holder polls for; written (tolerantly) on teardown. */
  readonly releaseMarkers: Set<string>;
}

function nativeEntry(slug: string, visibility = "list"): Record<string, unknown> {
  return {
    slug,
    display_name: slug,
    description: "native",
    priority: 9,
    visibility,
    supported_in_api: true,
    shell_type: "shell_command",
    base_instructions: "You are Codex, a coding agent based on GPT-5.",
    supported_reasoning_levels: [{ effort: "medium", description: "medium" }],
  };
}

function catalogBytes(visibility = "list", routed = false): string {
  return `${JSON.stringify({
    retained_marker: visibility,
    models: [
      nativeEntry("gpt-5.5", visibility),
      ...(routed ? [{
        ...nativeEntry("vendor/old-model"),
        description: "Routed via opencodex → vendor.",
      }] : []),
    ],
  }, null, 2)}\n`;
}

function makeSandbox(prefix: string): Sandbox {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  const codexHome = join(root, "codex-home");
  const opencodexHome = join(root, "opencodex-home");
  const home = join(root, "user-home");
  const runtime = join(root, "runtime");
  for (const path of [codexHome, opencodexHome, home, runtime]) {
    mkdirSync(path, { recursive: true });
    chmodSync(path, 0o700);
  }
  const serviceHome = claimOwnedServiceHome(codexHome, opencodexHome, home);
  const sandbox = {
    root,
    codexHome,
    opencodexHome,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      CODEX_HOME: codexHome,
      OPENCODEX_HOME: opencodexHome,
      HOME: home,
      USERPROFILE: home,
      TMPDIR: runtime,
      TEMP: runtime,
      TMP: runtime,
      XDG_RUNTIME_DIR: runtime,
      LOCALAPPDATA: join(home, "LocalAppData"),
    },
    serviceManagerEnv: serviceHome.env,
    preloadPath: serviceHome.preloadPath,
    children: new Set(),
    releaseMarkers: new Set(),
  };
  sandboxes.push(sandbox);
  return sandbox;
}

/**
 * Idempotent teardown, safe from a test's `finally` AND from `afterEach` in either
 * order. Order matters: release holders, kill anything still running, then AWAIT
 * every exit so no child holds a handle inside the sandbox when the root is removed.
 * Run 33920624827 (windows 2/4) showed the alternative: a per-test timeout left two
 * children dangling and the `finally` then wrote a release marker into a root
 * `afterEach` had already deleted (ENOENT).
 */
async function teardownSandbox(sandbox: Sandbox): Promise<void> {
  for (const marker of sandbox.releaseMarkers) {
    try { writeFileSync(marker, "release"); } catch { /* root may already be gone */ }
  }
  for (const child of sandbox.children) {
    if (child.exitCode === null) child.kill();
  }
  await Promise.all([...sandbox.children].map(child => child.exited));
  sandbox.children.clear();
}

function sandboxChildEnv(sandbox: Sandbox): Record<string, string> {
  return { ...sandbox.env, ...sandbox.serviceManagerEnv };
}

/**
 * Wait for a child to reach its barrier, failing fast with its output if it exits
 * first. The exit branch is a REJECTING promise, so while the race is pending an
 * early exit fails the test with the child's output. The subtlety is what happens
 * AFTER the barrier wins: that promise stays pending, and if a per-test timeout
 * later fires, teardown kills the child (exit 143) and the promise rejects with
 * nobody awaiting it — Bun reports it as an "unhandled error between tests" on
 * top of the timeout that already explained the failure (run 33923803071). The
 * no-op catch attached up front marks that late rejection handled without
 * changing what the race sees.
 */
async function raceBarrier(child: ReturnType<typeof Bun.spawn>, barrier: Promise<void>): Promise<void> {
  const exitedEarly = child.exited.then(async exitCode => {
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    throw new Error(`sync exited before provider barrier (${exitCode})\nstdout=${stdout}\nstderr=${stderr}`);
  });
  exitedEarly.catch(() => undefined);
  await Promise.race([barrier, exitedEarly]);
}

// A `bun --eval` child on a loaded windows-latest shard takes 8-11 s just to boot and
// reach its marker (runs 33590540220 and 33605898170), so a 10 s wait was the coin flip,
// not the child. Every caller passes a deadline that sits inside its own test budget so
// the helper's diagnostic, not Bun's timeout, is what reports a slow child.
async function waitForPath(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await Bun.sleep(5);
  }
}

async function runChild(
  sandbox: Sandbox,
  script: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, ...withOwnedServiceHomePreload(["--eval", script], sandbox.preloadPath)], {
    cwd: repoRoot,
    env: sandboxChildEnv(sandbox),
    stdout: "pipe",
    stderr: "pipe",
  });
  sandbox.children.add(child);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function holdCatalogLock(sandbox: Sandbox): Promise<{
  release(): void;
  child: ReturnType<typeof Bun.spawn>;
}> {
  const ready = join(sandbox.root, "lock-ready");
  const release = join(sandbox.root, "lock-release");
  const script = `
    import { existsSync, writeFileSync } from "node:fs";
    import { withCatalogWriteSerialization } from "./src/codex/catalog-write-serialization.ts";
    const home = process.env.CODEX_HOME;
    const outcome = withCatalogWriteSerialization(home, () => {
      writeFileSync(${JSON.stringify(ready)}, "ready");
      const waiter = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(${JSON.stringify(release)})) Atomics.wait(waiter, 0, 0, 10);
    });
    if (outcome.kind !== "completed") throw new Error(JSON.stringify(outcome));
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: repoRoot,
    env: sandbox.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  sandbox.children.add(child);
  sandbox.releaseMarkers.add(release);
  await waitForPath(ready, INTERNAL_DEADLINE_MS);
  return {
    release: () => { try { writeFileSync(release, "release"); } catch { /* teardown may have released already */ } },
    child,
  };
}

function seedCatalog(sandbox: Sandbox, bytes = catalogBytes()): string {
  const path = join(sandbox.codexHome, "catalog.json");
  writeFileSync(join(sandbox.codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n');
  writeFileSync(path, bytes);
  return path;
}

afterEach(async () => {
  const identity = resolveEffectiveUserIdentity();
  for (const sandbox of sandboxes.splice(0)) {
    await teardownSandbox(sandbox);
    const database = resolveCodexCatalogSerializationDatabasePath(identity, sandbox.codexHome);
    for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(`${database}${suffix}`, { force: true });
    removeTreeWithRetry(sandbox.root);
  }
});

test("startup and CLI sync-cache cannot write models_cache while another process owns K", async () => {
  const sandbox = makeSandbox("ocx-retained-cache-");
  seedCatalog(sandbox);
  const cachePath = join(sandbox.codexHome, "models_cache.json");
  const holder = await holdCatalogLock(sandbox);
  try {
    const startupProbe = await runChild(sandbox, `
      const sentinel = new Error("TEST_LISTENER_INTERCEPTED");
      Bun.serve = () => { throw sentinel; };
      const { startServer } = await import("./src/server/index.ts");
      try {
        startServer(0);
        throw new Error("startServer unexpectedly reached a listener");
      } catch (error) {
        if (error !== sentinel) throw error;
      }
    `);
    expect(startupProbe.exitCode).toBe(0);
    expect(existsSync(cachePath)).toBe(false);

    const cli = Bun.spawnSync([
      process.execPath,
      ...withOwnedServiceHomePreload(["run", "src/cli/index.ts", "sync-cache"], sandbox.preloadPath),
    ], {
      cwd: repoRoot,
      env: sandboxChildEnv(sandbox),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(cli.exitCode).toBe(0);
    expect(existsSync(cachePath)).toBe(false);
    const cliSource = readFileSync(join(repoRoot, "src/cli/dispatch.ts"), "utf8");
    const cliStart = cliSource.indexOf('"sync-cache": async');
    const cliRoot = cliSource.slice(cliStart, cliSource.indexOf('gui: async', cliStart));
    expect(cliRoot).toContain("withCatalogWriteSerialization(owningCodexHome");
    expect(cliRoot).toContain("invalidateCodexModelsCacheWithPermit");

    const startup = readFileSync(join(repoRoot, "src/server/index.ts"), "utf8");
    const startupStart = startup.indexOf("const startupCodexHome");
    const startupRoot = startup.slice(startupStart, startup.indexOf("armClaudeCodeBaseline", startupStart));
    expect(startupRoot).toContain("withCatalogWriteSerialization(startupCodexHome");
    expect(startupRoot).toContain("invalidateCodexModelsCacheWithPermit");
  } finally {
    holder.release();
    expect(await holder.child.exited).toBe(0);
  }
// Three real Bun children (the lock holder alive throughout; the startup probe and
// the CLI sync-cache in series), two of them importing the server/CLI graphs at
// 8-11 s each on windows-latest (see waitForPath). 15 s timed out on CI run
// 33920624827; the local timing (~450 ms) is not what this number is for.
}, SPAWN_BUDGET_MS);

test("native restore cannot read-transform-write the catalog while another process owns K", async () => {
  const sandbox = makeSandbox("ocx-retained-restore-");
  const catalogPath = seedCatalog(sandbox, catalogBytes("list", true));
  writeFileSync(join(sandbox.opencodexHome, "catalog-backup.json"), catalogBytes("list", false));
  const before = readFileSync(catalogPath, "utf8");
  const holder = await holdCatalogLock(sandbox);
  try {
    const restored = await runChild(sandbox, `
      const { restoreNativeCodex } = await import("./src/codex/inject.ts");
      console.log(JSON.stringify(restoreNativeCodex()));
    `);
    expect(restored.exitCode).toBe(0);
    expect(readFileSync(catalogPath, "utf8")).toBe(before);
    const source = readFileSync(join(repoRoot, "src/codex/inject.ts"), "utf8");
    const restoreRoot = source.slice(source.indexOf("const owningCodexHome"), source.indexOf("// Design B", source.indexOf("const owningCodexHome")));
    expect(restoreRoot).toContain("withCatalogWriteSerialization(owningCodexHome");
    expect(restoreRoot).toContain("restoreCodexCatalogWithPermit");
  } finally {
    holder.release();
    expect(await holder.child.exited).toBe(0);
  }
});

async function runPublisher(
  sandbox: Sandbox,
  kind: "convergence" | "retained",
  config: Record<string, unknown>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (kind === "retained") {
    return runChild(sandbox, `
      const { handleManagementAPI } = await import("./src/server/management-api.ts");
      const config = ${JSON.stringify(config)};
      const req = new Request("http://localhost/api/sync", { method: "POST", headers: { Host: "localhost" } });
      const response = await handleManagementAPI(req, new URL(req.url), config);
      console.log(JSON.stringify({ status: response.status, body: await response.json() }));
    `);
  }
  return runChild(sandbox, `
    const { withConfigMutationLockSync } = await import("./src/config.ts");
    const { captureCatalogAdmissionSnapshot, createCatalogConvergeRequest } = await import("./src/codex/catalog-admission.ts");
    const { convergeCodexCatalog } = await import("./src/codex/convergence.ts");
    const config = ${JSON.stringify(config)};
    withConfigMutationLockSync(() => undefined);
    const snapshot = captureCatalogAdmissionSnapshot(config);
    const result = await convergeCodexCatalog(snapshot, createCatalogConvergeRequest({ deadlineMs: 2000 }));
    console.log(JSON.stringify(result));
  `);
}

for (const publisher of ["convergence", "retained"] as const) {
  test(`POST /api/sync gathered first and acquired K second does not clobber a newer ${publisher} catalog`, async () => {
    const sandbox = makeSandbox(`ocx-retained-race-${publisher}-`);
    const catalogPath = seedCatalog(sandbox);
    const initial = readFileSync(catalogPath, "utf8");
    const requested = join(sandbox.root, "provider-requested");
    const release = join(sandbox.root, "provider-release");
    let requests = 0;
    const provider = Bun.serve({
      port: 0,
      fetch: async request => {
        if (!new URL(request.url).pathname.endsWith("/models")) return new Response("not found", { status: 404 });
        if (requests++ === 0) {
          writeFileSync(requested, "requested");
          while (!existsSync(release)) await Bun.sleep(5);
        }
        return Response.json({ data: [{ id: "race-model" }] });
      },
    });
    const config = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "fixture",
      providers: {
        fixture: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${provider.port}/v1`,
          apiKey: "fixture-key",
          allowPrivateNetwork: true,
          liveModels: true,
        },
      },
      disabledModels: ["gpt-5.5"],
    };
    writeFileSync(join(sandbox.opencodexHome, "config.json"), JSON.stringify(config));
    try {
      const sync = Bun.spawn([process.execPath, ...withOwnedServiceHomePreload(["--eval", `
        const config = ${JSON.stringify(config)};
        const { handleManagementAPI } = await import("./src/server/management-api.ts");
        const req = new Request("http://localhost/api/sync", { method: "POST", headers: { Host: "localhost" } });
        const response = await handleManagementAPI(req, new URL(req.url), config);
        console.log(JSON.stringify({ status: response.status, body: await response.json() }));
      `], sandbox.preloadPath)], { cwd: repoRoot, env: sandboxChildEnv(sandbox), stdout: "pipe", stderr: "pipe" });
      sandbox.children.add(sync);

      await raceBarrier(sync, waitForPath(requested, INTERNAL_DEADLINE_MS));
      const published = await runPublisher(sandbox, publisher, config);
      if (published.exitCode !== 0) {
        throw new Error(`${publisher} publisher failed\nstdout=${published.stdout}\nstderr=${published.stderr}`);
      }
      const newer = readFileSync(catalogPath, "utf8");
      expect(newer).not.toBe(initial);

      writeFileSync(release, "release");
      const [exitCode, stdout, stderr] = await Promise.all([
        sync.exited,
        new Response(sync.stdout).text(),
        new Response(sync.stderr).text(),
      ]);
      expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 });
      expect(readFileSync(catalogPath, "utf8")).toBe(newer);
    } finally {
      provider.stop(true);
    }
  }, SPAWN_BUDGET_MS);
}

/**
 * Runtime authority can move without touching the catalog at all.
 *
 * The verifier's R1→R2 case: a retained sync prepares from one Codex runtime,
 * and while it is awaiting its provider another process rewrites the persisted
 * runtime selection. Every catalog byte is untouched, so a freshness check built
 * only from catalog/backup/cache bytes sees nothing and commits a candidate that
 * was derived under a runtime that is no longer selected.
 *
 * `codex-runtime.json` is therefore part of the pre-await filesystem evidence,
 * PRESENT or ABSENT. Removing it from `retainedCatalogSyncEvidence` turns this
 * test red while every other retained-root test stays green — which is exactly
 * why it exists: nothing else in the suite covered that component.
 */
test("a persisted runtime selection moved by another process during the await blocks the write", async () => {
  const sandbox = makeSandbox("ocx-retained-runtime-move-");
  const catalogPath = seedCatalog(sandbox);
  const initial = readFileSync(catalogPath, "utf8");
  const requested = join(sandbox.root, "provider-requested");
  const release = join(sandbox.root, "provider-release");
  const runtimeStatePath = join(sandbox.opencodexHome, "codex-runtime.json");
  writeFileSync(runtimeStatePath, `${JSON.stringify({
    version: 1,
    command: "/usr/local/bin/codex-r1",
    source: "configured",
    selectedVersion: "1.0.0",
    updatedAt: new Date(0).toISOString(),
  }, null, 2)}\n`);

  const config = {
    port: 10100,
    defaultProvider: "together",
    providers: {
      together: {
        adapter: "openai-chat",
        baseUrl: "https://api.together.xyz/v1",
        apiKey: "runtime-move-key",
        models: ["fallback-model"],
      },
    },
  };

  const sync = Bun.spawn([process.execPath, ...withOwnedServiceHomePreload(["--eval", `
    import { existsSync, writeFileSync } from "node:fs";
    const config = ${JSON.stringify(config)};
    config.providers.together.fetch = async () => {
      writeFileSync(${JSON.stringify(requested)}, "requested");
      while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(5);
      return Response.json({ data: [{ id: "runtime-move-model" }] });
    };
    const { syncCatalogModels } = await import("./src/codex/catalog/sync.ts");
    console.log(JSON.stringify(await syncCatalogModels(config)));
  `], sandbox.preloadPath)], { cwd: repoRoot, env: sandboxChildEnv(sandbox), stdout: "pipe", stderr: "pipe" });
  sandbox.children.add(sync);

  await raceBarrier(sync, waitForPath(requested, INTERNAL_DEADLINE_MS));

  // Another process selects a different Codex runtime. No catalog byte changes.
  writeFileSync(runtimeStatePath, `${JSON.stringify({
    version: 1,
    command: "/usr/local/bin/codex-r2",
    source: "configured",
    selectedVersion: "2.0.0",
    updatedAt: new Date(1).toISOString(),
  }, null, 2)}\n`);

  writeFileSync(release, "release");
  const [exitCode, stdout, stderr] = await Promise.all([
    sync.exited,
    new Response(sync.stdout).text(),
    new Response(sync.stderr).text(),
  ]);
  expect({ exitCode, stderr }).toMatchObject({ exitCode: 0 });
  expect(JSON.parse(stdout.trim())).toMatchObject({ catalogWritten: false });
  expect(readFileSync(catalogPath, "utf8")).toBe(initial);
}, SPAWN_BUDGET_MS);

/**
 * The post-approval seam, raced by two real processes through a real route.
 *
 * Every case above drives `/api/sync`, which is a retained root. This one drives
 * `PATCH /api/providers` — one of the sixteen management mutations that used to
 * reach a catalog write through `refreshCodexCatalogBestEffort`, whose entire
 * error policy was `catch {}`. The interesting window is AFTER the route has
 * already persisted its own mutation and approved the refresh: two processes
 * arriving there together must serialize, and neither may report `committed`
 * for bytes the other replaced.
 *
 * Both processes go through `handleManagementAPI`, so this exercises the bound
 * factory, the total adapter, and K in the shape production actually uses.
 *
 * The edit itself is a `note` update: a recognized field that persists a real
 * config mutation without changing routing, so what is under test is the refresh
 * that follows approval rather than the edit.
 */
test("two processes at the post-approval management seam serialize instead of interleaving", async () => {
  const sandbox = makeSandbox("ocx-post-approval-race-");
  const catalogPath = seedCatalog(sandbox);
  const seeded = readFileSync(catalogPath, "utf8");
  const barrier = join(sandbox.root, "seam-barrier");

  // Warm the config ownership + mutation database in a single process first.
  // Two cold processes otherwise race to create `.opencodex-owner.json` and both
  // die with EEXIST before approval, which would make this test vacuous.
  const warm = Bun.spawn([process.execPath, "--eval", `
    const { withConfigMutationLockSync } = await import("./src/config.ts");
    withConfigMutationLockSync(() => undefined);
  `], { cwd: repoRoot, env: sandbox.env, stdout: "pipe", stderr: "pipe" });
  sandbox.children.add(warm);
  expect(await warm.exited).toBe(0);

  const routeScript = (marker: string) => `
    import { existsSync, writeFileSync } from "node:fs";
    // The stub lives on globalThis, NOT on the provider row. Catalog admission
    // encodes the config to derive its identity and refuses a function member, so
    // a per-provider \`fetch\` makes the seam throw before it can converge — which
    // looked exactly like a production defect until the encoder said so.
    globalThis.fetch = async () => {
      writeFileSync(${JSON.stringify(barrier)} + "-" + ${JSON.stringify(marker)}, "here");
      // Two children rendezvous on markers; either may take 8-19 s to boot on windows-latest.
      const deadline = Date.now() + ${INTERNAL_DEADLINE_MS};
      while (Date.now() < deadline) {
        if (existsSync(${JSON.stringify(barrier)} + "-a") && existsSync(${JSON.stringify(barrier)} + "-b")) break;
        await Bun.sleep(5);
      }
      return Response.json({ data: [{ id: "seam-model-" + ${JSON.stringify(marker)} }] });
    };
    const config = {
      port: 10100,
      defaultProvider: "together",
      providers: {
        together: {
          adapter: "openai-chat",
          baseUrl: "https://api.together.xyz/v1",
          apiKey: "seam-key",
          models: ["fallback-model"],
        },
      },
    };
    const { handleManagementAPI } = await import("./src/server/management-api.ts");
    const url = new URL("http://localhost/api/providers?name=together");
    const req = new Request(url, {
      method: "PATCH",
      headers: { Host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ note: "seam-" + ${JSON.stringify(marker)} }),
    });
    const response = await handleManagementAPI(req, url, config);
    const body = await response.json();
    console.log(JSON.stringify({ status: response.status, catalogRefresh: body.catalogRefresh }));
  `;

  const isPreApprovalLoss = (stderr: string): boolean =>
    stderr.includes("CONFIG_MUTATION_LOCK_UNAVAILABLE")
    || (stderr.includes("EEXIST") && stderr.includes("createOwnership"))
    || /database (?:is|table is) locked/i.test(stderr)
    || stderr.includes("SQLITE_BUSY");

  // On macOS CI both children can still lose the config lock before approval even
  // after the warm-up — that proves nothing about catalog serialization. Retry
  // vacuous runs until at least one process reaches the post-approval seam.
  // Each attempt boots two real children; bound the retry loop by the spawn budget, not a literal.
  const attemptDeadline = Date.now() + SPAWN_BUDGET_MS;
  let results: Array<{ exitCode: number; stdout: string; stderr: string }> | undefined;
  while (Date.now() < attemptDeadline) {
    for (const marker of ["a", "b"] as const) {
      rmSync(`${barrier}-${marker}`, { force: true });
    }
    writeFileSync(catalogPath, seeded);

    const children = (["a", "b"] as const).map(marker => Bun.spawn(
      [process.execPath, ...withOwnedServiceHomePreload(["--eval", routeScript(marker)], sandbox.preloadPath)],
      { cwd: repoRoot, env: sandboxChildEnv(sandbox), stdout: "pipe", stderr: "pipe" },
    ));
    for (const child of children) sandbox.children.add(child);

    results = await Promise.all(children.map(async child => {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    }));

    // A 2xx `skipped` result reached the total adapter but still proves no
    // catalog serialization. Keep retrying until one attempt actually commits;
    // the assertions below continue to fail closed if the deadline expires.
    const committed = results.some(result => {
      if (result.exitCode !== 0) return false;
      const parsed = JSON.parse(result.stdout.trim()) as {
        catalogRefresh?: { status?: string };
      };
      return parsed.catalogRefresh?.status === "committed";
    });
    if (committed) break;

    for (const result of results) {
      if (result.exitCode === 0) continue;
      expect({ preApproval: isPreApprovalLoss(result.stderr), stderr: result.stderr })
        .toMatchObject({ preApproval: true });
    }
  }

  expect(results).toBeDefined();
  for (const result of results!) {
    // A process can lose a race BEFORE approval and never reach the seam at all.
    // The known cases come from `saveConfigPreservingClaudeCode`: the config mutation
    // lock is already held, two cold processes create the ownership file at once, or
    // SQLite refuses the transaction outright while another process holds it. None of
    // them say anything about catalog convergence, so they are excluded here — but only
    // these, so a genuine seam failure still fails.
    //
    // The third case was found by a CI failure on macOS, not by this suite. The lock
    // helper normally wraps busy errors in `ConfigMutationLockError`, but the raw
    // `SQLiteError: database is locked` can still reach stderr from a path that has not
    // wrapped it yet. `configGenerationFailureReason` already classifies that exact
    // message as "busy" rather than a database fault, so treating it as a seam failure
    // here contradicted the product code and turned ordinary contention into a red build.
    if (result.exitCode !== 0) {
      expect({ preApproval: isPreApprovalLoss(result.stderr), stderr: result.stderr })
        .toMatchObject({ preApproval: true });
      continue;
    }
    const parsed = JSON.parse(result.stdout.trim()) as {
      status: number;
      catalogRefresh: { status: string };
    };
    // The route persisted its mutation, so it must answer 2xx no matter what the
    // catalog attempt decided. A throw here would be the old `catch {}` failure
    // inverted: a persisted change reported as a 500.
    expect(parsed.status).toBeGreaterThanOrEqual(200);
    expect(parsed.status).toBeLessThan(300);
    // Whatever happened, it is REPORTED — never swallowed into silence.
    expect(["committed", "skipped", "failed"]).toContain(parsed.catalogRefresh.status);
  }

  // At least one process must have gotten through to the seam, or this test would
  // be vacuous — two config-lock losers prove nothing about catalog serialization.
  expect(results!.some(r => r.exitCode === 0)).toBe(true);

  // At least one process must reach a real commit, or the race proves nothing:
  // the adapter is total, so a seam that only ever failed would still answer 2xx
  // with a typed disposition and satisfy every assertion above.
  const dispositions = results!
    .filter(r => r.exitCode === 0)
    .map(r => (JSON.parse(r.stdout.trim()) as { catalogRefresh: { status: string } }).catalogRefresh.status);
  expect(dispositions).toContain("committed");

  // A commit means the catalog really moved.
  expect(readFileSync(catalogPath, "utf8")).not.toBe(seeded);

  // The surviving catalog is one process's complete output, never a blend of both.
  const finalBytes = readFileSync(catalogPath, "utf8");
  const parsedCatalog = JSON.parse(finalBytes) as { models: Array<{ slug?: unknown }> };
  const slugs = parsedCatalog.models.flatMap(m => typeof m.slug === "string" ? [m.slug] : []);
  const fromA = slugs.some(s => s.includes("seam-model-a"));
  const fromB = slugs.some(s => s.includes("seam-model-b"));
  expect(fromA && fromB).toBe(false);
}, SPAWN_BUDGET_MS);
