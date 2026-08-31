import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchCommand, type CliDispatchDeps } from "../src/cli/dispatch";

/**
 * `ocx restore` must finish the WHOLE shared teardown, including when Codex is already
 * off (#3008).
 *
 * The deferred-teardown recovery path prints "run 'ocx restore', then delete the receipt".
 * If restore returns success on the Codex no-op path before touching the Grok fence, an
 * operator following those instructions signs off an incomplete teardown and deletes the
 * obligation that would have caught it — leaving Grok pointed at a proxy that is gone.
 */

const BEGIN = "# >>> opencodex managed block — do not edit (removed by `ocx stop`) >>>";
const END = "# <<< opencodex managed block <<<";
const depsFor = (args: string[]) => ({ args } as unknown as CliDispatchDeps);

let grokHome: string;
let opencodexHome: string;
let codexHome: string;
let previous: Record<string, string | undefined> = {};

beforeEach(() => {
  previous = {
    GROK_HOME: process.env.GROK_HOME,
    OPENCODEX_HOME: process.env.OPENCODEX_HOME,
    CODEX_HOME: process.env.CODEX_HOME,
  };
  grokHome = mkdtempSync(join(tmpdir(), "ocx-restore-grok-"));
  opencodexHome = mkdtempSync(join(tmpdir(), "ocx-restore-home-"));
  codexHome = mkdtempSync(join(tmpdir(), "ocx-restore-codex-"));
  process.env.GROK_HOME = grokHome;
  process.env.OPENCODEX_HOME = opencodexHome;
  process.env.CODEX_HOME = codexHome;
});

afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of [grokHome, opencodexHome, codexHome]) rmSync(dir, { recursive: true, force: true });
});

async function seedOffConfig(): Promise<void> {
  // Codex already OFF in this home, so the desired-state write reports "unchanged" and the
  // residue classifier reports clean — the no-op path under test. Written through the real
  // saver so the file satisfies the same schema the CLI validates.
  const { loadConfig, saveConfig } = await import("../src/config");
  const config = loadConfig();
  saveConfig({ ...config, clientIntegrations: { ...(config.clientIntegrations ?? {}), codex: false } });
}

function writeManagedGrokFence(): string {
  mkdirSync(grokHome, { recursive: true });
  const configPath = join(grokHome, "config.toml");
  writeFileSync(configPath, [
    "# user content above",
    BEGIN,
    'base_url = "http://127.0.0.1:10100/v1"',
    END,
    "",
  ].join("\n"));
  return configPath;
}

test("restore strips the Grok fence even when Codex is already off and native", async () => {
  await seedOffConfig();
  const configPath = writeManagedGrokFence();
  expect(readFileSync(configPath, "utf8")).toContain(BEGIN);

  // Codex is untouched in this home, so the desired-state write is "unchanged" and the
  // residue classifier reports clean — the exact no-op path that used to return 0 before
  // stripGrokConfig() ever ran.
  const code = await dispatchCommand({ kind: "run", command: "restore", args: ["restore"] }, depsFor(["restore"]));

  const after = readFileSync(configPath, "utf8");
  expect(after).not.toContain(BEGIN);
  expect(after).not.toContain(END);
  expect(after).toContain("# user content above");
  expect(code).toBe(0);
});

test("the JSON envelope on that path reports the Grok cleanup too", async () => {
  await seedOffConfig();
  writeManagedGrokFence();
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    await dispatchCommand({ kind: "run", command: "restore", args: ["restore", "--json"] }, depsFor(["restore", "--json"]));
  } finally {
    console.log = originalLog;
  }
  const envelope = JSON.parse(lines.at(-1)!);
  // A machine caller must not read "already OFF and native" as "nothing was left to do".
  expect(envelope.success).toBe(true);
  expect(String(envelope.message)).toContain("already OFF and native");
  expect(String(envelope.message)).toMatch(/Grok|managed block/i);
});

test("with no Grok home at all the no-op path still succeeds quietly", async () => {
  await seedOffConfig();
  rmSync(grokHome, { recursive: true, force: true });
  const code = await dispatchCommand({ kind: "run", command: "restore", args: ["restore"] }, depsFor(["restore"]));
  expect(code).toBe(0);
  expect(existsSync(grokHome)).toBe(false);
});
