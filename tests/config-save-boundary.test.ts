import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * "Every live-config writer goes through the guarded saver" is a claim until something
 * checks it (devlog 260726_claude_auth_auto/040 H1). `saveConfig` serializes the WHOLE
 * config, so ONE bare call on a live config re-clobbers a hand-edited `claudeCode` and
 * silently undoes the guard.
 *
 * Startup migrations are the documented exception: they run before the server serves
 * requests, against a config nobody else holds.
 */

const SRC = join(import.meta.dir, "..", "src");

/** Modules that hold a LIVE server config and must use the wrapper. */
const GUARDED_FILES = [
  "providers/api-keys.ts",       // request-path + management key pool
  "providers/key-failover.ts",   // 429 rotation, reached mid-turn with no user action
  "codex/routing.ts",            // account auto-switch during a turn
  "codex/auth-api.ts",           // runtime account/quota persistence
  "cli/claude-desktop.ts",       // CLI against a running service
  "server/management-api.ts",
];

function guardedManagementFiles(): string[] {
  const dir = join(SRC, "server", "management");
  return readdirSync(dir)
    .filter(name => name.endsWith(".ts"))
    .map(name => join("server", "management", name));
}

/** Bare `saveConfig(` calls, ignoring the guarded wrapper's own longer name. */
function bareSaveConfigCalls(text: string): string[] {
  return text
    .split("\n")
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(entry => /(?<![A-Za-z])saveConfig\s*\(/.test(entry.line))
    .map(entry => `${entry.number}: ${entry.line}`);
}

test("no live-config writer calls saveConfig directly", () => {
  const offenders: string[] = [];
  for (const relative of [...GUARDED_FILES, ...guardedManagementFiles()]) {
    const text = readFileSync(join(SRC, relative), "utf8");
    for (const hit of bareSaveConfigCalls(text)) offenders.push(`${relative}:${hit}`);
  }
  expect(offenders).toEqual([]);
});

// The import itself is the drift risk: a later edit reaching for the bare symbol should
// have to add the import back, which review catches.
test("guarded modules do not import the bare saver", () => {
  const offenders: string[] = [];
  for (const relative of [...GUARDED_FILES, ...guardedManagementFiles()]) {
    const text = readFileSync(join(SRC, relative), "utf8");
    if (/(?<![A-Za-z])saveConfig\s*[,}]/.test(text)) offenders.push(relative);
  }
  expect(offenders).toEqual([]);
});

// The exception has to stay narrow and visible, not become a habit.
test("startServer arms the baseline before it can serve a request", () => {
  const text = readFileSync(join(SRC, "server", "index.ts"), "utf8");
  const start = text.indexOf("export function startServer");
  expect(start).toBeGreaterThan(-1);
  const armIndex = text.indexOf("armClaudeCodeBaseline(config)", start);
  expect(armIndex).toBeGreaterThan(-1);
  // Every bare save inside startServer is a startup migration and must precede arming.
  const body = text.slice(start, armIndex);
  const after = text.slice(armIndex, text.indexOf("\n}\n", armIndex));
  expect(bareSaveConfigCalls(body).length).toBeGreaterThan(0);
  expect(bareSaveConfigCalls(after)).toEqual([]);
});
