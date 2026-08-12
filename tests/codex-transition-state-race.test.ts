import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { Database } from "bun:sqlite";

import { openCodexCoordinatorTransaction } from "../src/codex/transition-state";
import {
  resolveCodexCoordinatorDatabasePath,
  resolveEffectiveUserIdentity,
} from "../src/codex/user-identity";

const CHILD_TIMEOUT_MS = 10_000;
const transitionStateModuleUrl = pathToFileURL(
  join(import.meta.dir, "..", "src", "codex", "transition-state.ts"),
).href;
const userIdentityModuleUrl = pathToFileURL(
  join(import.meta.dir, "..", "src", "codex", "user-identity.ts"),
).href;

const transitionProbe = `
  import {
    beginCodexTransition,
    readCodexTransitionState,
  } from ${JSON.stringify(transitionStateModuleUrl)};
  import {
    resolveCodexCoordinatorDatabasePath,
    resolveEffectiveUserIdentity,
  } from ${JSON.stringify(userIdentityModuleUrl)};
  import { existsSync, realpathSync, writeFileSync } from "node:fs";

  const payload = JSON.parse(process.env.OCX_TEST_PAYLOAD);
  const canonicalCodexHome = realpathSync.native(payload.codexHome);
  const databasePath = resolveCodexCoordinatorDatabasePath(
    resolveEffectiveUserIdentity(),
    canonicalCodexHome,
  );
  const next = txId => ({
    txId,
    direction: "apply",
    authoritySnapshotId: \`authority-\${txId}\`,
    nextRetryAt: "2026-08-04T12:00:00.000Z",
  });
  const waitFor = async path => {
    const deadline = Date.now() + ${CHILD_TIMEOUT_MS};
    while (!existsSync(path)) {
      if (Date.now() >= deadline) throw new Error(\`timed out waiting for \${path}\`);
      await Bun.sleep(5);
    }
  };

  let result;
  if (payload.action === "race") {
    writeFileSync(payload.readyPath, "ready");
    await waitFor(payload.releasePath);
    const first = beginCodexTransition(
      { nativeGeneration: 0, currentTxId: null },
      next(payload.txId),
    );
    writeFileSync(payload.outcomePath, JSON.stringify(first));
    await waitFor(payload.retryPath);
    /*
     * Retry until the contention resolves, not once. A single retry assumes the
     * loser found the lock free on its second attempt; on a loaded CI runner
     * both contenders can lose BOTH, and the test then read [unavailable,
     * unavailable] as a broken invariant when it was just an unlucky schedule.
     * The invariant is that it CONVERGES, not that it converges in one retry.
     */
    let final = first;
    for (let attempt = 0; attempt < 10 && final.kind === "unavailable" && final.reason === "busy"; attempt += 1) {
      await Bun.sleep(25 * (attempt + 1));
      final = beginCodexTransition(
        { nativeGeneration: 0, currentTxId: null },
        next(payload.txId),
      );
    }
    result = { id: payload.id, databasePath, first, final };
  } else if (payload.action === "begin") {
    result = {
      databasePath,
      outcome: beginCodexTransition(payload.expected, next(payload.txId)),
    };
  } else {
    result = { databasePath, outcome: readCodexTransitionState() };
  }
  process.stdout.write(JSON.stringify(result));
`;

interface ProbeResult {
  id?: string;
  databasePath: string;
  first?: TransitionOutcome;
  final?: TransitionOutcome;
  outcome?: TransitionOutcome;
}

interface TransitionOutcome {
  kind: string;
  reason?: string;
  state?: { nativeGeneration: number; currentTxId: string | null };
  current?: { nativeGeneration: number; currentTxId: string | null };
}

interface Sandbox {
  root: string;
  codexHome: string;
  opencodexHomes: [string, string];
  coordinatorPath: string;
}

function createSandbox(label: string): Sandbox {
  const root = mkdtempSync(join(tmpdir(), `ocx-transition-race-${label}-`));
  const codexHome = join(root, "codex");
  const opencodexHomes: [string, string] = [join(root, "ocx-a"), join(root, "ocx-b")];
  mkdirSync(codexHome);
  for (const path of opencodexHomes) mkdirSync(path);
  const coordinatorPath = resolveCodexCoordinatorDatabasePath(
    resolveEffectiveUserIdentity(),
    realpathSync.native(codexHome),
  );
  return { root, codexHome, opencodexHomes, coordinatorPath };
}

function cleanupSandbox(sandbox: Sandbox): void {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    rmSync(`${sandbox.coordinatorPath}${suffix}`, { recursive: true, force: true });
  }
  rmSync(sandbox.root, { recursive: true, force: true });
}

function spawnProbe(sandbox: Sandbox, opencodexHome: string, payload: Record<string, unknown>) {
  return Bun.spawn([process.execPath, "--eval", transitionProbe], {
    env: {
      ...process.env,
      CODEX_HOME: sandbox.codexHome,
      OPENCODEX_HOME: opencodexHome,
      OCX_TEST_PAYLOAD: JSON.stringify({ ...payload, codexHome: sandbox.codexHome }),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function collectProbe(child: ReturnType<typeof spawnProbe>): Promise<ProbeResult> {
  const timeout = setTimeout(() => child.kill(), CHILD_TIMEOUT_MS);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(stdout.trim().split("\n"), stderr).toHaveLength(1);
    return JSON.parse(stdout) as ProbeResult;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForFiles(paths: readonly string[]): Promise<void> {
  const deadline = Date.now() + CHILD_TIMEOUT_MS;
  while (!paths.every(existsSync)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${paths.join(", ")}`);
    await Bun.sleep(5);
  }
}

test("two real processes racing first use publish exactly one initial transition", async () => {
  const sandbox = createSandbox("initialization");
  const barrier = join(sandbox.root, "barrier");
  mkdirSync(barrier);
  const releasePath = join(barrier, "release");
  const retryPath = join(barrier, "retry");
  const children = ["a", "b"].map((id, index) => spawnProbe(
    sandbox,
    sandbox.opencodexHomes[index]!,
    {
      action: "race",
      id,
      txId: `tx-${id}`,
      readyPath: join(barrier, `${id}.ready`),
      outcomePath: join(barrier, `${id}.outcome`),
      releasePath,
      retryPath,
    },
  ));

  try {
    await waitForFiles([join(barrier, "a.ready"), join(barrier, "b.ready")]);
    writeFileSync(releasePath, "go");
    await waitForFiles([join(barrier, "a.outcome"), join(barrier, "b.outcome")]);
    writeFileSync(retryPath, "retry-busy-loser");
    const results = await Promise.all(children.map(collectProbe));

    const firstKinds = results.map(result => result.first?.kind);
    // AT MOST one first-attempt winner, not exactly one. The coordinator uses
    // `busy_timeout = 0` deliberately, so under load both contenders can lose
    // their first attempt to SQLITE_BUSY and resolve it on the retry below.
    // Demanding a first-round winner asserts scheduler luck; the invariant that
    // actually matters — never two winners — is the filter being <= 1, and the
    // terminal state is pinned exactly by `finalKinds`.
    expect(firstKinds.filter(kind => kind === "updated").length).toBeLessThanOrEqual(1);
    for (const result of results) {
      const acceptable = result.first?.kind === "updated"
        || result.first?.kind === "conflict"
        || (result.first?.kind === "unavailable" && result.first.reason === "busy");
      // Report the actual value on failure; `toBe(true)` alone says only that
      // something unexpected happened, which is the least useful thing a race
      // test can tell you.
      expect({ acceptable, first: result.first }).toMatchObject({ acceptable: true });
    }

    const finalKinds = results.map(result => result.final?.kind).sort();
    expect(finalKinds).toEqual(["conflict", "updated"]);
    const winner = results.find(result => result.final?.kind === "updated")!;
    const loser = results.find(result => result.final?.kind === "conflict")!;
    expect(loser.final?.current?.currentTxId).toBe(winner.final?.state?.currentTxId);
    expect(results.map(result => result.databasePath)).toEqual([
      sandbox.coordinatorPath,
      sandbox.coordinatorPath,
    ]);

    const database = new Database(sandbox.coordinatorPath, { readonly: true });
    try {
      expect(database.query<{ count: number }, []>(
        "SELECT count(*) AS count FROM codex_transition_state WHERE singleton = 1",
      ).get()?.count).toBe(1);
      expect(database.query<{ native_generation: number; current_tx_id: string }, []>(
        "SELECT native_generation, current_tx_id FROM codex_transition_state WHERE singleton = 1",
      ).get()).toEqual({
        native_generation: 1,
        current_tx_id: winner.final?.state?.currentTxId,
      });
    } finally {
      database.close();
    }
  } finally {
    for (const child of children) child.kill();
    cleanupSandbox(sandbox);
  }
}, { timeout: 30_000 });

test("different OPENCODEX_HOME claimants advance the row under one CODEX_HOME", async () => {
  const sandbox = createSandbox("shared-codex-home");
  try {
    const first = await collectProbe(spawnProbe(sandbox, sandbox.opencodexHomes[0], {
      action: "begin",
      expected: { nativeGeneration: 0, currentTxId: null },
      txId: "tx-home-a",
    }));
    expect(first.outcome?.kind).toBe("updated");

    const integrations = join(sandbox.opencodexHomes[1], "integrations");
    mkdirSync(integrations);
    writeFileSync(join(integrations, "codex.json"), JSON.stringify({
      version: 1,
      nativeGeneration: 91,
      currentTxId: "opencodex-home-local-claimant",
      history: { status: "pending", txId: "opencodex-home-local-claimant" },
    }));

    const second = await collectProbe(spawnProbe(sandbox, sandbox.opencodexHomes[1], {
      action: "begin",
      expected: { nativeGeneration: 1, currentTxId: "tx-home-a" },
      txId: "tx-home-b",
    }));
    expect(second.databasePath).toBe(first.databasePath);
    expect(second.outcome).toMatchObject({
      kind: "updated",
      state: { nativeGeneration: 2, currentTxId: "tx-home-b" },
    });

    const observed = await collectProbe(spawnProbe(sandbox, sandbox.opencodexHomes[0], {
      action: "read",
    }));
    expect(observed.databasePath).toBe(first.databasePath);
    expect(observed.outcome).toMatchObject({
      kind: "ready",
      state: { nativeGeneration: 2, currentTxId: "tx-home-b" },
    });
  } finally {
    cleanupSandbox(sandbox);
  }
}, { timeout: 30_000 });

test("a locked coordinator returns the exact typed busy outcome", async () => {
  const sandbox = createSandbox("busy");
  let controller: ReturnType<typeof openCodexCoordinatorTransaction> | undefined;
  try {
    const initialized = await collectProbe(spawnProbe(sandbox, sandbox.opencodexHomes[0], {
      action: "read",
    }));
    expect(initialized.outcome?.kind).toBe("ready");

    controller = openCodexCoordinatorTransaction(sandbox.coordinatorPath);
    const blocked = await collectProbe(spawnProbe(sandbox, sandbox.opencodexHomes[1], {
      action: "read",
    }));
    expect(blocked.outcome).toEqual({ kind: "unavailable", reason: "busy" });
  } finally {
    controller?.close();
    cleanupSandbox(sandbox);
  }
}, { timeout: 20_000 });

test("an unsafe coordinator path returns the exact typed unsafe-path outcome", async () => {
  const sandbox = createSandbox("unsafe-path");
  try {
    mkdirSync(sandbox.coordinatorPath);
    const refused = await collectProbe(spawnProbe(sandbox, sandbox.opencodexHomes[0], {
      action: "read",
    }));
    expect(refused.outcome).toEqual({ kind: "unavailable", reason: "unsafe-path" });
  } finally {
    if (process.platform !== "win32" && existsSync(sandbox.coordinatorPath)) {
      chmodSync(sandbox.coordinatorPath, 0o700);
    }
    cleanupSandbox(sandbox);
  }
}, { timeout: 20_000 });
