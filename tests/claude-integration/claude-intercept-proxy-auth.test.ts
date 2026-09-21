import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeInterceptProxyTokenPath,
  ensureClaudeInterceptProxyToken,
  readClaudeInterceptProxyToken,
} from "../../src/claude/intercept/proxy-auth";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "ocx-proxy-auth-"));
}

test("read returns null without creating anything on disk", () => {
  const configDir = dir();
  expect(readClaudeInterceptProxyToken(configDir)).toBeNull();
  expect(existsSync(join(configDir, "claude-intercept"))).toBe(false);
});

test("ensure creates the token once, returns it, and reuses it", () => {
  const configDir = dir();
  const token = ensureClaudeInterceptProxyToken(configDir);
  expect(token.length).toBeGreaterThanOrEqual(32);
  expect(readFileSync(claudeInterceptProxyTokenPath(configDir), "utf8")).toBe(`${token}\n`);
  expect(ensureClaudeInterceptProxyToken(configDir)).toBe(token);
  expect(readClaudeInterceptProxyToken(configDir)).toBe(token);
  // No temp or backup files linger next to the committed credential.
  expect(readdirSync(join(configDir, "claude-intercept"))).toEqual(["proxy-token"]);
});

test("a committed token beats a concurrent creator's generated one", () => {
  // Another process already published: the loser must converge on the committed credential
  // rather than return a token that was never persisted.
  const configDir = dir();
  mkdirSync(join(configDir, "claude-intercept"), { recursive: true });
  writeFileSync(claudeInterceptProxyTokenPath(configDir), "committed-token\n");
  expect(ensureClaudeInterceptProxyToken(configDir)).toBe("committed-token");
});

test("an empty token file is treated as missing and republished", () => {
  const configDir = dir();
  mkdirSync(join(configDir, "claude-intercept"), { recursive: true });
  writeFileSync(claudeInterceptProxyTokenPath(configDir), "");
  expect(readClaudeInterceptProxyToken(configDir)).toBeNull();
  const token = ensureClaudeInterceptProxyToken(configDir);
  expect(token.length).toBeGreaterThanOrEqual(32);
  expect(readClaudeInterceptProxyToken(configDir)).toBe(token);
});
