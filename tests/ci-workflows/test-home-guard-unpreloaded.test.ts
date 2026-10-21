/**
 * #7407: a `bun test` that never loads tests/preload.ts must still refuse credential writes.
 *
 * Bun reads bunfig.toml from the CURRENT WORKING DIRECTORY, so
 * `cd elsewhere && bun test <repo>/tests/x.test.ts` runs with the real HOME, no OPENCODEX_HOME,
 * and (before this fix) a disarmed guard: one such run added an account to a developer's real
 * ~/.opencodex/auth.json and made it active. Every case here spawns exactly that shape, a test
 * file outside the repository run from a cwd with no bunfig.toml, against a temp directory
 * posing as the real home, so nothing in this suite can reach the developer's own.
 *
 * The negative case matters as much: the same writes from a plain `bun` process, even with
 * NODE_ENV=test, must still land. Production persistence is unchanged.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { repoRoot } from "../helpers/repo-root";
import { watchdogMs } from "../helpers/ci-watchdog";

const REPO_ROOT_URL = pathToFileURL(repoRoot() + "/").href;
const CHILD_MS = watchdogMs(20_000);
const SENTINEL_AUTH = JSON.stringify({ sentinel: { activeAccountId: "real", accounts: [] } }, null, 2) + "\n";
const SENTINEL_CODEX_AUTH = JSON.stringify({ tokens: { access_token: "real-codex-sentinel" } }) + "\n";

const handles: TempHome[] = [];
afterEach(() => { for (const handle of handles.splice(0)) handle.remove(); });

/** A temp root this suite owns and removes after each case. */
function owned(prefix: string): string {
  const handle = createTempHome(prefix);
  handles.push(handle);
  return handle.root;
}

/** A directory posing as the developer's home, seeded with live-looking credential stores. */
function fakeRealHome(): string {
  const home = owned("ocx-7407-real-home-");
  mkdirSync(join(home, ".opencodex"), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, ".codex"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".opencodex", "auth.json"), SENTINEL_AUTH, { mode: 0o600 });
  writeFileSync(join(home, ".codex", "auth.json"), SENTINEL_CODEX_AUTH, { mode: 0o600 });
  return home;
}

/** Every entry under the two credential homes, with its mode and content hash. */
function snapshot(home: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      const digest = stat.isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex") : "";
      out.push(relative(home, path) + " " + stat.mode.toString(8) + " " + digest);
      if (stat.isDirectory()) walk(path);
    }
  };
  for (const tree of [".opencodex", ".codex"]) {
    out.push(tree + " " + lstatSync(join(home, tree)).mode.toString(8));
    walk(join(home, tree));
  }
  return out;
}

/** A developer shell's environment: real HOME, nothing sandboxed, no preload receipts. */
function unsandboxedEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  for (const key of ["OCX_TEST_HOME_GUARD", "OCX_REAL_HOME", "OCX_TEST_PRELOAD_PID", "OPENCODEX_HOME", "CODEX_HOME", "NODE_ENV"]) {
    delete env[key];
  }
  return { ...env, HOME: home, USERPROFILE: home, ...extra };
}

async function run(args: string[], cwd: string, env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), CHILD_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { stdout, stderr, code };
  } finally {
    clearTimeout(timer);
  }
}

function report(stdout: string, stderr: string): Record<string, string> {
  const line = (stdout + "\n" + stderr).split("\n").find(entry => entry.startsWith("REPORT "));
  if (!line) throw new Error("child printed no REPORT line:\n" + stdout + "\n" + stderr);
  return JSON.parse(line.slice("REPORT ".length)) as Record<string, string>;
}

/**
 * One call per credential-write entry path. A call counts as REFUSED only when its error chain
 * carries the guard's own message, so an unrelated failure cannot pass as protection.
 */
const ATTEMPTS = String.raw`
  const repo = ${JSON.stringify(REPO_ROOT_URL)};
  const out: Record<string, string> = {};
  const guard = await import(repo + "src/lib/test-home-guard.ts");
  out.armed = String(guard.isTestHomeGuardArmed());
  out.flag = String(process.env.OCX_TEST_HOME_GUARD);
  out.preload = String(process.env.OCX_TEST_PRELOAD_PID);
  globalThis.fetch = (async () => { throw new Error("network disabled in this probe"); }) as never;
  const config = await import(repo + "src/config.ts");
  const store = await import(repo + "src/oauth/store.ts");
  const codexStore = await import(repo + "src/codex/account-store.ts");
  const kimi = await import(repo + "src/oauth/kimi.ts");
  const nous = await import(repo + "src/oauth/nous.ts");
  out.configDir = config.getConfigDir();
  const cred = { access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3_600_000, email: "fixture@example.test" };
  const chain = (error: unknown): string => {
    const parts: string[] = [];
    for (let e: any = error, i = 0; e && i < 6; e = e.cause, i++) parts.push(String(e?.message ?? e));
    return parts.join(" <- ");
  };
  const attempt = async (name: string, fn: () => unknown) => {
    try { await fn(); out[name] = "WROTE"; }
    catch (error) {
      const text = chain(error);
      out[name] = /refusing to write the real (OpenCodex|Codex) home/.test(text) ? "REFUSED" : "OTHER: " + text.slice(0, 300);
      if (name === "saveCredential") out.hint = String(text.includes("did not load tests/preload.ts"));
    }
  };
  await attempt("saveCredential", () => store.saveCredential("anthropic", cred));
  await attempt("upsertCredentialByIdentity", () => store.upsertCredentialByIdentity("kimi", cred));
  await attempt("saveAccountCredential", () => store.saveAccountCredential("kimi", "fixture-account", cred));
  await attempt("setActiveAccount", () => store.setActiveAccount("kimi", "fixture-account"));
  await attempt("removeAccount", () => store.removeAccount("kimi", "fixture-account"));
  await attempt("mergeAccountCredential", () => store.mergeAccountCredential("kimi", "fixture-account", cred));
  await attempt("writeOAuthRefreshIntent", () => store.writeOAuthRefreshIntent("kimi", "fixture-account", "generation"));
  await attempt("refreshIntentLock", async () => (await store.createOAuthRefreshIntentLock("kimi", "fixture-account").acquire()).release());
  await attempt("saveCodexAccountCredential", () => codexStore.saveCodexAccountCredential("fixture-codex", { accessToken: "a", refreshToken: "r", accountId: "acct", expiresAt: Date.now() + 3_600_000 } as never));
  await attempt("codexAuthJsonMirror", () => config.atomicWriteFile("__CODEX_AUTH__", "{}\n"));
  await attempt("saveConfig", () => config.saveConfig({ providers: {}, defaultProvider: "openai", port: 10100 } as never));
  await attempt("kimiDeviceId", () => kimi.refreshKimiToken("fixture-refresh"));
  await attempt("nousRefreshIntent", () => nous.refreshNousToken("fixture-refresh"));
  console.log("REPORT " + JSON.stringify(out));
`;

const WRITE_PATHS = [
  "saveCredential", "upsertCredentialByIdentity", "saveAccountCredential", "setActiveAccount", "removeAccount",
  "mergeAccountCredential", "writeOAuthRefreshIntent", "refreshIntentLock", "saveCodexAccountCredential",
  "codexAuthJsonMirror", "saveConfig", "kimiDeviceId", "nousRefreshIntent",
];

/**
 * A helper whose entry is NOT a test file, spawned from inside the unpreloaded test. It cannot
 * arm itself by name, so it is protected only if it inherits the flag the test process published.
 */
const CHILD_HELPER = String.raw`
  const store = await import(${JSON.stringify(REPO_ROOT_URL)} + "src/oauth/store.ts");
  try {
    await store.saveCredential("anthropic", { access: "child", refresh: "child", expires: Date.now() + 3_600_000, email: "child@example.test" });
    console.log("CHILD WROTE");
  } catch (error) {
    console.log(/refusing to write the real OpenCodex home/.test(String((error as Error)?.message)) ? "CHILD REFUSED" : "CHILD OTHER");
  }
`;

function writeFixture(dir: string, name: string, home: string, asTest: boolean): string {
  // JSON-encoded so a Windows path keeps its backslashes inside the child's string literal.
  let body = ATTEMPTS.replace('"__CODEX_AUTH__"', JSON.stringify(join(home, ".codex", "auth.json")));
  if (asTest) {
    const helper = join(dir, "spawned-helper.ts");
    writeFileSync(helper, CHILD_HELPER);
    body = body.replace('  console.log("REPORT "', "  const spawned = Bun.spawnSync([process.execPath, \"run\", " + JSON.stringify(helper) + "], { env: process.env });\n"
      + "  out.child = /CHILD (\\w+)/.exec(spawned.stdout.toString())?.[1] ?? \"none\";\n"
      + '  console.log("REPORT "');
  }
  const source = asTest
    ? 'import { test } from "bun:test";\ntest("unpreloaded writes", async () => {\n' + body + "\n}, 30_000);\n"
    : body;
  const path = join(dir, name);
  writeFileSync(path, source);
  return path;
}

describe("bun test without the preload (#7407)", () => {
  test("arms the guard and refuses every credential write to the real home", async () => {
    const home = fakeRealHome();
    const outside = owned("ocx-7407-cwd-");
    expect(existsSync(join(outside, "bunfig.toml"))).toBe(false);
    const fixture = writeFixture(outside, "unpreloaded-writes.test.ts", home, true);
    const before = snapshot(home);

    const result = await run(["test", fixture], outside, unsandboxedEnv(home));
    const seen = report(result.stdout, result.stderr);

    // The incident's shape: no preload ran and the config dir is the real one.
    expect(seen.preload).toBe("undefined");
    expect(seen.configDir).toBe(join(home, ".opencodex"));
    // Armed anyway, and published so CLI children it spawns inherit the arming.
    expect(seen.armed).toBe("true");
    expect(seen.flag).toBe("1");
    for (const path of WRITE_PATHS) expect({ path, outcome: seen[path] }).toEqual({ path, outcome: "REFUSED" });
    expect(seen.hint).toBe("true");
    // A spawned helper with a non-test entry inherits the arming instead of writing the real home.
    expect(seen.child).toBe("REFUSED");
    // Nothing landed, nothing was created, and no mode changed.
    expect(snapshot(home)).toEqual(before);
    expect(readFileSync(join(home, ".opencodex", "auth.json"), "utf8")).toBe(SENTINEL_AUTH);
  }, CHILD_MS + 5_000);

  test("a plain bun process with NODE_ENV=test still persists (production is unchanged)", async () => {
    const home = fakeRealHome();
    const outside = owned("ocx-7407-prod-cwd-");
    const script = writeFixture(outside, "write-credentials.ts", home, false);

    const result = await run(["run", script], outside, unsandboxedEnv(home, { NODE_ENV: "test" }));
    const seen = report(result.stdout, result.stderr);

    expect(seen.armed).toBe("false");
    expect(seen.flag).toBe("undefined");
    // fetch is disabled, so a network path may fail otherwise, but none may hit the guard.
    for (const path of WRITE_PATHS) expect({ path, refused: seen[path] === "REFUSED" }).toEqual({ path, refused: false });
    expect(seen.saveCredential).toBe("WROTE");
    expect(seen.saveConfig).toBe("WROTE");
    expect(seen.codexAuthJsonMirror).toBe("WROTE");
    const auth = JSON.parse(readFileSync(join(home, ".opencodex", "auth.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(auth)).toContain("anthropic");
    // The writers that now assert first still persist before their network call fails.
    expect(readFileSync(join(home, ".opencodex", "kimi-device-id"), "utf8").trim()).not.toBe("");
    const intents = readdirSync(join(home, ".opencodex", ".nous-refresh-intent")).filter(name => name.endsWith(".json"));
    expect(intents.length).toBe(1);
    expect(JSON.parse(readFileSync(join(home, ".opencodex", ".nous-refresh-intent", intents[0]!), "utf8")).status).toBeString();
  }, CHILD_MS + 5_000);

  // Only "0" opts out; any other value is normalised to "1" before a helper can inherit it.
  test.each(["", "yes"])("a stray OCX_TEST_HOME_GUARD=%p is normalised so spawned helpers stay armed", async stray => {
    const home = fakeRealHome();
    const outside = owned("ocx-7407-stray-cwd-");
    const fixture = writeFixture(outside, "stray-flag.test.ts", home, true);
    const before = snapshot(home);

    const result = await run(["test", fixture], outside, unsandboxedEnv(home, { OCX_TEST_HOME_GUARD: stray }));
    const seen = report(result.stdout, result.stderr);

    expect(seen.armed).toBe("true");
    expect(seen.flag).toBe("1");
    expect(seen.child).toBe("REFUSED");
    expect(snapshot(home)).toEqual(before);
  }, CHILD_MS + 5_000);

  test("an explicit OCX_TEST_HOME_GUARD=0 still disarms a test file", async () => {
    const home = fakeRealHome();
    const outside = owned("ocx-7407-optout-cwd-");
    const fixture = join(outside, "optout.test.ts");
    writeFileSync(fixture, 'import { test } from "bun:test";\ntest("x", async () => {\n'
      + "  const guard = await import(" + JSON.stringify(REPO_ROOT_URL + "src/lib/test-home-guard.ts") + ");\n"
      + '  console.log("REPORT " + JSON.stringify({ armed: String(guard.isTestHomeGuardArmed()) }));\n});\n');

    const result = await run(["test", fixture], outside, unsandboxedEnv(home, { OCX_TEST_HOME_GUARD: "0" }));

    expect(report(result.stdout, result.stderr).armed).toBe("false");
  }, CHILD_MS + 5_000);
});
