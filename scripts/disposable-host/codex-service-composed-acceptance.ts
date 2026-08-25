/**
 * Disposable-host composed acceptance for the six globally addressed service rows.
 *
 * This is intentionally a script, not a Bun test. It mutates the current account's
 * systemd user registration and therefore refuses to run without the root-owned
 * image sentinel specified by WP13.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { Database } from "bun:sqlite";

const SENTINEL = "/etc/opencodex-disposable-service-host-v1";
const SENTINEL_BYTES = "OPENCODEX_DISPOSABLE_SERVICE_HOST_V1\n";
const UNIT = "opencodex-proxy.service";
const repoRoot = resolve(import.meta.dir, "../..");
const cliPath = join(repoRoot, "src/cli/index.ts");
const accountHome = homedir();
const accountUnit = join(accountHome, ".config/systemd/user", UNIT);
const eventLedger: string[] = [];

type RowId = "P09" | "P10" | "P18" | "P34" | "P35" | "P36";
type ChildResult = { exitCode: number; stdout: string; stderr: string };
type Transition = { nativeGeneration: number; currentTxId: string | null; direction: string | null };

function fail(message: string): never {
  throw new Error(message);
}

function assertDisposableSentinel(): void {
  const link = lstatSync(SENTINEL);
  const stat = statSync(SENTINEL);
  if (!link.isFile() || link.isSymbolicLink()) fail(`${SENTINEL} must be a non-symlink regular file`);
  if (stat.uid !== 0) fail(`${SENTINEL} must be root-owned (uid=${stat.uid})`);
  if ((stat.mode & 0o022) !== 0) fail(`${SENTINEL} must not be group/world writable (mode=${(stat.mode & 0o777).toString(8)})`);
  if (readFileSync(SENTINEL, "utf8") !== SENTINEL_BYTES) fail(`${SENTINEL} has unexpected bytes`);
  eventLedger.push("sentinel:verified");
  console.log(`SENTINEL verified ${SENTINEL}`);
}

async function spawnResult(argv: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Promise<ChildResult> {
  const child = Bun.spawn(argv, {
    cwd: options.cwd ?? repoRoot,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function requireCommand(argv: string[], label: string): Promise<ChildResult> {
  const result = await spawnResult(argv);
  eventLedger.push(`query:${label}`);
  if (result.exitCode !== 0) {
    fail(`${label} unavailable (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
  }
  return result;
}

async function emptyRegistrationGate(extraArtifact?: string): Promise<void> {
  if (eventLedger[0] !== "sentinel:verified") fail("service query attempted before sentinel verification");
  // Ubuntu's systemctl returns 1 (with no output) when a name filter matches no
  // unit. Prove the bus independently so that result cannot hide a permission or
  // connectivity failure, then accept only the measured empty 0/1 result.
  await requireCommand(["systemctl", "--user", "show-environment"], "systemctl user bus");
  const units = await spawnResult(["systemctl", "--user", "list-unit-files", UNIT, "--no-legend", "--no-pager"]);
  eventLedger.push("query:systemctl list-unit-files");
  if ((units.exitCode !== 0 && units.exitCode !== 1) || units.stderr.trim()) {
    fail(`systemctl list-unit-files unavailable (exit ${units.exitCode}): ${units.stderr || units.stdout}`);
  }
  if (units.stdout.trim()) fail(`service registration is nonempty: ${units.stdout.trim()}`);

  const status = await spawnResult(["systemctl", "--user", "status", UNIT, "--no-pager"]);
  eventLedger.push("query:systemctl status");
  const statusText = `${status.stdout}\n${status.stderr}`;
  if (status.exitCode === 0 || !/could not be found|not-found|not found|loaded: not-found/i.test(statusText)) {
    fail(`service status did not prove unit-not-found (exit ${status.exitCode}): ${statusText.trim()}`);
  }
  for (const artifact of [accountUnit, extraArtifact].filter((value): value is string => Boolean(value))) {
    if (existsSync(artifact)) fail(`service artifact exists: ${artifact}`);
  }
  console.log(`GATE empty registration (${extraArtifact ?? accountUnit})`);
}

function byteManifest(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      const key = relative(root, path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) entries[key] = createHash("sha256").update(readFileSync(path)).digest("hex");
      else entries[key] = `non-file:${stat.mode}`;
    }
  };
  walk(root);
  return entries;
}

function sameManifest(a: Record<string, string>, b: Record<string, string>, label: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) fail(`${label} byte manifest changed`);
}

function coordinatorPath(codexHome: string): string {
  const canonical = realpathSync.native(codexHome);
  const digest = createHash("sha256").update(canonical).digest("hex");
  return join(`/tmp/opencodex-runtime-v1-${process.getuid!()}`, "native-write-locks", `${digest}.sqlite`);
}

class Fixture {
  readonly root = mkdtempSync(join(tmpdir(), "ocx-service-composed-"));
  /**
   * The REAL account home, deliberately.
   *
   * Every other path here is a fixture path, and a fake HOME was the obvious symmetry — but
   * `systemctl --user` resolves its unit directory from the running user manager, not from
   * `$HOME`. With a fake home, `ocx service install` wrote a unit file the user manager never
   * reads and then failed on `systemctl --user enable`: "Unit file opencodex-proxy.service does
   * not exist". Verified directly on the host — the same install against the real home succeeds
   * and lists as `enabled`.
   *
   * That is precisely why these rows are disposable-host-only. A globally addressed service
   * cannot be redirected into a temp root, so the safety property cannot come from isolation;
   * it comes from the sentinel plus the empty-registration gate on both sides of every row.
   */
  readonly home = homedir();
  readonly userprofile = join(this.root, "userprofile");
  readonly codex = join(this.root, "codex");
  readonly ocx = join(this.root, "ocx");
  readonly runtime = `/run/user/${process.getuid!()}`;
  readonly unit = accountUnit;
  readonly lock: string;
  readonly lockAllowlist: string[];
  readonly baselineOutside: Record<string, string>;

  constructor(readonly row: RowId) {
    for (const path of [this.userprofile, this.codex, this.ocx]) mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(join(this.codex, "config.toml"), 'model = "gpt-5"\n');
    writeFileSync(join(this.ocx, "config.json"), JSON.stringify({
      port: 0,
      hostname: "127.0.0.1",
      syncResumeHistory: false,
      claudeCode: { systemEnv: false },
      clientIntegrations: { codex: true, grok: false, "claude-desktop": false },
      providers: {
        fixture: {
          adapter: "openai-chat",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "fixture-key",
          allowPrivateNetwork: true,
          liveModels: false,
          models: ["fixture-model"],
        },
      },
      defaultProvider: "fixture",
    }, null, 2));
    this.lock = coordinatorPath(this.codex);
    this.lockAllowlist = [this.lock, `${this.lock}-journal`, `${this.lock}-wal`, `${this.lock}-shm`];
    for (const path of this.lockAllowlist) if (existsSync(path)) fail(`${row}: pre-existing coordinator artifact: ${path}`);
    this.baselineOutside = this.outsideManifest();
  }

  env(): Record<string, string> {
    return {
      HOME: this.home,
      USERPROFILE: this.userprofile,
      CODEX_HOME: this.codex,
      OPENCODEX_HOME: this.ocx,
      XDG_RUNTIME_DIR: this.runtime,
      OPENCODEX_API_AUTH_TOKEN: "disposable-data-token",
      OPENCODEX_ADMIN_AUTH_TOKEN: "disposable-admin-token",
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      NO_PROXY: "127.0.0.1,localhost",
      CI: "true",
    };
  }

  outsideManifest(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const path of [accountUnit, ...this.lockAllowlist]) {
      result[path] = existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "absent";
    }
    return result;
  }

  async cli(args: string[]): Promise<ChildResult> {
    const result = await spawnResult([process.execPath, cliPath, ...args], { cwd: this.root, env: this.env() });
    if (result.exitCode !== 0) fail(`${this.row}: ocx ${args.join(" ")} failed (${result.exitCode})\n${result.stderr}\n${result.stdout}`);
    return result;
  }

  transition(): Transition {
    if (!existsSync(this.lock)) return { nativeGeneration: 0, currentTxId: null, direction: null };
    const db = new Database(this.lock, { readonly: true });
    try {
      const row = db.query(`SELECT native_generation, current_tx_id, history_direction FROM codex_transition_state WHERE singleton = 1`).get() as Record<string, unknown> | null;
      if (!row) fail(`${this.row}: coordinator transition row is missing`);
      return {
        nativeGeneration: Number(row.native_generation),
        currentTxId: row.current_tx_id === null ? null : String(row.current_tx_id),
        direction: row.history_direction === null ? null : String(row.history_direction),
      };
    } finally {
      db.close();
    }
  }

  async install(): Promise<void> {
    await this.cli(["service", "install"]);
    if (!existsSync(this.unit)) fail(`${this.row}: install did not create fixture unit`);
  }

  async waitForRuntime(): Promise<{ port: number; pid: number }> {
    const path = join(this.ocx, "runtime-port.json");
    for (let attempt = 0; attempt < 300; attempt++) {
      if (existsSync(path)) {
        const value = JSON.parse(readFileSync(path, "utf8")) as { port?: number; pid?: number };
        if (Number.isInteger(value.port) && Number.isInteger(value.pid)) return value as { port: number; pid: number };
      }
      await Bun.sleep(20);
    }
    fail(`${this.row}: timed out waiting for runtime-port.json`);
  }

  async apiStop(): Promise<ChildResult> {
    const runtime = await this.waitForRuntime();
    const script = `const r=await fetch(${JSON.stringify(`http://127.0.0.1:${runtime.port}/api/stop`)},{method:"POST",headers:{"x-opencodex-api-key":"disposable-admin-token"}});console.log(r.status,await r.text());if(!r.ok)process.exit(1)`;
    const result = await spawnResult([process.execPath, "--eval", script], { cwd: this.root, env: this.env() });
    if (result.exitCode !== 0) fail(`${this.row}: POST /api/stop failed\n${result.stderr}\n${result.stdout}`);
    return result;
  }

  assertOneTransaction(before: Transition, expectedDirection: "apply" | "remove"): Transition {
    const after = this.transition();
    if (after.nativeGeneration !== before.nativeGeneration + 1) {
      fail(`${this.row}: expected exactly one admitted transaction; generation ${before.nativeGeneration} -> ${after.nativeGeneration}`);
    }
    if (!after.currentTxId || after.currentTxId === before.currentTxId) fail(`${this.row}: transaction id did not advance`);
    if (after.direction !== expectedDirection) fail(`${this.row}: expected ${expectedDirection} transaction, got ${after.direction}`);
    return after;
  }

  async teardown(): Promise<void> {
    const cleanup = await spawnResult([process.execPath, cliPath, "service", "uninstall"], { cwd: this.root, env: this.env() });
    if (cleanup.exitCode !== 0 && existsSync(this.unit)) {
      fail(`${this.row}: fixture service teardown failed\n${cleanup.stderr}\n${cleanup.stdout}`);
    }
    await emptyRegistrationGate(this.unit);
    for (const path of this.lockAllowlist) if (existsSync(path)) unlinkSync(path);
    sameManifest(this.outsideManifest(), this.baselineOutside, `${this.row}: outside-temp-root`);
    rmSync(this.root, { recursive: true });
  }
}

async function runRow(row: RowId): Promise<void> {
  await emptyRegistrationGate();
  const fx = new Fixture(row);
  let completed = false;
  try {
    await fx.install();
    let before: Transition;
    let output: ChildResult;
    let direction: "apply" | "remove";
    if (row === "P34") {
      await fx.cli(["service", "stop"]);
      before = fx.transition();
      output = await fx.cli(["service", "start"]);
      direction = "apply";
    } else {
      before = fx.transition();
      direction = "remove";
      if (row === "P09") output = await fx.cli(["stop"]);
      else if (row === "P10") output = await fx.cli(["uninstall"]);
      else if (row === "P18") output = await fx.apiStop();
      else if (row === "P35") output = await fx.cli(["service", "stop"]);
      else output = await fx.cli(["service", "uninstall"]);
    }
    const after = fx.assertOneTransaction(before, direction);
    const recordPath = join(fx.ocx, "integrations/codex.json");
    if (row === "P10") {
      // Full uninstall deliberately removes the owned OPENCODEX_HOME only after the
      // native removal transaction succeeds. Requiring its record to survive would
      // contradict the production command's contract.
      if (existsSync(fx.ocx)) fail(`${row}: full uninstall left owned OpenCodex state behind`);
    } else {
      if (!existsSync(recordPath)) fail(`${row}: integration record is missing`);
      const record = JSON.parse(readFileSync(recordPath, "utf8")) as { provenance?: { entries?: Array<{ txId?: string }> } };
      const matching = record.provenance?.entries?.filter(entry => entry.txId === after.currentTxId).length ?? 0;
      if (matching === 0) fail(`${row}: admitted transaction has no provenance entry`);
    }
    console.log(`${row} PASS generation=${before.nativeGeneration}->${after.nativeGeneration} direction=${direction} tx=${after.currentTxId}`);
    console.log(`${row} OUTPUT ${output.stdout.trim().replace(/\s+/g, " ").slice(0, 500)}`);
    completed = true;
  } finally {
    await fx.teardown();
    if (!completed) console.error(`${row} FAIL (teardown completed)`);
  }
}

async function main(): Promise<void> {
  if (process.platform !== "linux") fail(`this disposable runner currently requires Linux/systemd, got ${process.platform}`);
  assertDisposableSentinel();
  await requireCommand(["systemctl", "--version"], "systemctl version");
  for (const row of ["P09", "P10", "P18", "P34", "P35", "P36"] as const) await runRow(row);
  await emptyRegistrationGate();
  console.log(`PASS disposable service census: ${["P09", "P10", "P18", "P34", "P35", "P36"].join(", ")}`);
  console.log(`EVENTS ${eventLedger.join(" | ")}`);
}

main().catch(error => {
  console.error(`FAIL disposable service acceptance: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
