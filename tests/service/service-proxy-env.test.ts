import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeInterceptProxyTokenPath } from "../../src/claude/intercept/proxy-auth";
import { claudeInterceptProxyUrl } from "../../src/claude/intercept/settings";
import { resolvedProxyEnv } from "../../src/service/definition";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const token = "a".repeat(43);
let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "service-proxy-env-"));
  process.env.OPENCODEX_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function storeToken(value = token): void {
  mkdirSync(join(home, "claude-intercept"), { mode: 0o700 });
  writeFileSync(claudeInterceptProxyTokenPath(home), `${value}\n`, { mode: 0o600 });
}

describe("service proxy environment ownership", () => {
  test("default token lookup excludes an inherited owned URL after the configured port changes", () => {
    storeToken();
    const own = claudeInterceptProxyUrl(10200, token);
    writeFileSync(join(home, "config.json"), JSON.stringify({
      port: 11100, hostname: "127.0.0.1", providers: {}, defaultProvider: "openai",
      claudeCode: { intercept: { port: 11200 } },
    }));
    const before = readFileSync(claudeInterceptProxyTokenPath(home), "utf8");
    expect(resolvedProxyEnv({ HTTPS_PROXY: own })).toEqual([]);
    expect(resolvedProxyEnv({ HTTP_PROXY: own, ALL_PROXY: own, https_proxy: own }))
      .toEqual([]);
    expect(resolvedProxyEnv({ HTTPS_PROXY: own, https_proxy: "http://127.0.0.1:7897" }))
      .toEqual([{ name: "HTTPS_PROXY", value: "http://127.0.0.1:7897" }]);
    expect(readFileSync(claudeInterceptProxyTokenPath(home), "utf8")).toBe(before);
  });

  test("accepts valid owned ports without consulting current config", () => {
    storeToken();
    for (const port of [1, 10200, 65535]) {
      expect(resolvedProxyEnv({ HTTPS_PROXY: claudeInterceptProxyUrl(port, token) })).toEqual([]);
    }
    expect(resolvedProxyEnv({ HTTPS_PROXY: `${claudeInterceptProxyUrl(10200, token)}/` })).toEqual([]);
  });

  test("preserves unrelated authenticated proxies and malformed or foreign URL components", () => {
    storeToken();
    for (const value of [
      "http://opencodex:corporate-password@127.0.0.1:10200",
      claudeInterceptProxyUrl(10200, "b".repeat(43)),
      "http://127.0.0.1:10200",
      `http://other:${token}@127.0.0.1:10200`,
      `https://opencodex:${token}@127.0.0.1:10200`,
      `http://opencodex:${token}@example.com:10200`,
      `http://opencodex:${token}@127.0.0.1.example.com:10200`,
      `http://opencodex:${token}@localhost:10200`,
      `http://opencodex:${token}@127.0.0.1:0`,
      `http://opencodex:${token}@127.0.0.1:65536`,
      `http://opencodex:${token}@127.0.0.1:-1`,
      `http://opencodex:${token}@127.0.0.1:10200/path`,
      `http://opencodex:${token}@127.0.0.1:10200?query`,
      `http://opencodex:${token}@127.0.0.1:10200#fragment`,
      `http://opencodex:${token}@127.0.0.1:10200@foreign`,
    ]) {
      expect(resolvedProxyEnv({ HTTPS_PROXY: value })).toEqual([{ name: "HTTPS_PROXY", value }]);
    }
  });

  test("an absent or unusable stored token cannot claim a proxy or create a credential", () => {
    const value = claudeInterceptProxyUrl(10200, token);
    expect(resolvedProxyEnv({ HTTPS_PROXY: value })).toEqual([{ name: "HTTPS_PROXY", value }]);
    expect(existsSync(join(home, "claude-intercept"))).toBe(false);
    storeToken("invalid");
    expect(resolvedProxyEnv({ HTTPS_PROXY: value })).toEqual([{ name: "HTTPS_PROXY", value }]);
    expect(readFileSync(claudeInterceptProxyTokenPath(home), "utf8")).toBe("invalid\n");
  });
});
