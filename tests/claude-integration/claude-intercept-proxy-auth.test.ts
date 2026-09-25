import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import * as filesystem from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeInterceptProxyTokenPath, ensureClaudeInterceptProxyToken, readClaudeInterceptProxyToken } from "../../src/claude/intercept/proxy-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const roots: string[] = [];
function dir(): string {
  const root = mkdtempSync(join(tmpdir(), "ocx-proxy-auth-"));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) removeTreeWithRetry(root); });

test("read returns null without creating anything on disk", () => {
  const root = dir();
  expect(readClaudeInterceptProxyToken(root)).toBeNull();
  expect(existsSync(join(root, "claude-intercept"))).toBe(false);
});
test("ensure creates one bounded token and all callers reuse it", () => {
  const root = dir();
  const token = ensureClaudeInterceptProxyToken(root);
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(readFileSync(claudeInterceptProxyTokenPath(root), "utf8")).toBe(`${token}\n`);
  expect(ensureClaudeInterceptProxyToken(root)).toBe(token);
  expect(readClaudeInterceptProxyToken(root)).toBe(token);
  expect(readdirSync(join(root, "claude-intercept"))).toEqual(["proxy-token"]);
});
for (const ending of ["", "\n", "\r\n"]) {
  test(`a valid committed credential with ending ${JSON.stringify(ending)} wins`, () => {
    const root = dir();
    ensureClaudeInterceptProxyToken(root);
    writeFileSync(claudeInterceptProxyTokenPath(root), "A".repeat(43) + ending, { mode: 0o600 });
    expect(ensureClaudeInterceptProxyToken(root)).toBe("A".repeat(43));
  });
}
for (const [label, value] of [
  ["empty", ""], ["short", "committed-token"], ["space", "A".repeat(43) + " "],
  ["extra newline", "A".repeat(43) + "\n\n"], ["oversized", "A".repeat(65536)],
  ["non-ascii", "가".repeat(43)],
] as const) {
  test(`invalid ${label} credentials are refused, never overwritten`, () => {
    const root = dir();
    ensureClaudeInterceptProxyToken(root);
    const path = claudeInterceptProxyTokenPath(root);
    writeFileSync(path, value);
    expect(readClaudeInterceptProxyToken(root)).toBeNull();
    expect(() => ensureClaudeInterceptProxyToken(root)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(value);
    expect(readdirSync(join(root, "claude-intercept"))).toEqual(["proxy-token"]);
  });
}
test("a directory at the credential path is not a credential", () => {
  const root = dir();
  mkdirSync(claudeInterceptProxyTokenPath(root), { recursive: true });
  expect(readClaudeInterceptProxyToken(root)).toBeNull();
  expect(() => ensureClaudeInterceptProxyToken(root)).toThrow();
  expect(lstatSync(claudeInterceptProxyTokenPath(root)).isDirectory()).toBe(true);
});
test.skipIf(process.platform === "win32")("valid existing token permissions are repaired through its descriptor", () => {
  const root = dir();
  mkdirSync(join(root, "claude-intercept"), { recursive: true });
  const path = claudeInterceptProxyTokenPath(root);
  writeFileSync(path, "B".repeat(43) + "\n", { mode: 0o644 });
  expect(readClaudeInterceptProxyToken(root)).toBeNull();
  expect(ensureClaudeInterceptProxyToken(root)).toBe("B".repeat(43));
  expect(statSync(path).mode & 0o077).toBe(0);
});
test.skipIf(process.platform === "win32")("a token symlink never reads or chmods its external target", () => {
  const root = dir();
  const external = join(root, "outside.txt");
  writeFileSync(external, "C".repeat(43) + "\n", { mode: 0o644 });
  const before = statSync(external).mode;
  mkdirSync(join(root, "claude-intercept"), { mode: 0o700 });
  const path = claudeInterceptProxyTokenPath(root);
  symlinkSync(external, path);
  expect(readClaudeInterceptProxyToken(root)).toBeNull();
  expect(() => ensureClaudeInterceptProxyToken(root)).toThrow();
  expect(lstatSync(path).isSymbolicLink()).toBe(true);
  expect(readFileSync(external, "utf8")).toBe("C".repeat(43) + "\n");
  expect(statSync(external).mode).toBe(before);
});
test("a linked credential directory never grants authority", () => {
  const root = dir();
  const external = join(root, "outside-dir");
  mkdirSync(external);
  writeFileSync(join(external, "proxy-token"), "D".repeat(43) + "\n");
  symlinkSync(external, join(root, "claude-intercept"), process.platform === "win32" ? "junction" : "dir");
  expect(readClaudeInterceptProxyToken(root)).toBeNull();
  expect(() => ensureClaudeInterceptProxyToken(root)).toThrow();
  expect(readFileSync(join(external, "proxy-token"), "utf8")).toBe("D".repeat(43) + "\n");
});

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no test port");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
function connectStatus(port: number, token?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      const auth = token ? `Proxy-Authorization: Basic ${Buffer.from(`opencodex:${token}`).toString("base64")}\r\n` : "";
      socket.write(`CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n${auth}\r\n`);
    });
    socket.setTimeout(5000, () => socket.destroy(new Error("test CONNECT timed out")));
    let head = "";
    socket.on("data", chunk => {
      head += chunk.toString("latin1");
      if (head.includes("\r\n\r\n")) {
        const status = Number(head.split(" ")[1]);
        socket.destroy();
        resolve(status);
      }
    });
    socket.on("error", reject);
  });
}
test("a live intercept adopts an explicitly recreated token without restarting", async () => {
  const root = dir();
  const claudeHome = join(root, "claude");
  mkdirSync(claudeHome);
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  const { startClaudeIntercept } = await import("../../src/claude/intercept/runtime");
  const { applyDesktopFirstParty } = await import("../../src/claude/desktop-first-party");
  const port = await unusedPort();
  const config = { port: 10100, defaultProvider: "openai", providers: {},
    claudeCode: { intercept: { enabled: true, port, picker: false } } };
  let handle: Awaited<ReturnType<typeof startClaudeIntercept>> = null;
  try {
    handle = await startClaudeIntercept({ config, configDir: root, publicPort: 10100,
      dispatch: async () => new Response("local fixture") });
    expect(handle).not.toBeNull();
    expect(applyDesktopFirstParty(config, { opencodexConfigDir: root, claudeConfigDir: claudeHome }).ok).toBe(true);
    const old = readClaudeInterceptProxyToken(root)!;
    expect(await connectStatus(port, old)).toBe(200);
    unlinkSync(claudeInterceptProxyTokenPath(root));
    expect(await connectStatus(port, old)).toBe(407);
    expect(await connectStatus(port)).toBe(407);
    expect(applyDesktopFirstParty(config, { opencodexConfigDir: root, claudeConfigDir: claudeHome }).ok).toBe(true);
    const current = readClaudeInterceptProxyToken(root)!;
    expect(current).not.toBe(old);
    const settings = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
    expect(new URL(settings.env.HTTPS_PROXY).password).toBe(current);
    expect(await connectStatus(port, current)).toBe(200);
    expect(await connectStatus(port, old)).toBe(407);
    expect(handle!.proxyPort).toBe(port);
  } finally {
    await handle?.stop();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
}, 30000);

test("published token stays usable when removal of its own temporary entry fails", () => {
  const root = dir();
  const original = filesystem.unlinkSync;
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  const removal = spyOn(filesystem, "unlinkSync").mockImplementation(path => {
    if (String(path).includes(".proxy-token.") && String(path).endsWith(".tmp")) {
      throw Object.assign(new Error("private detail must not escape"), { code: "EACCES" });
    }
    return original(path);
  });
  try {
    const token = ensureClaudeInterceptProxyToken(root);
    expect(readClaudeInterceptProxyToken(root)).toBe(token);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls.flat().join(" ")).not.toContain("private detail");
    const temps = readdirSync(join(root, "claude-intercept")).filter(name => name.endsWith(".tmp"));
    expect(temps).toHaveLength(1);
  } finally { removal.mockRestore(); warning.mockRestore(); }
});
test("cleanup errors preserve the original credential creation error", () => {
  const root = dir();
  const originalWrite = filesystem.writeFileSync;
  const originalUnlink = filesystem.unlinkSync;
  const failure = new Error("expected creation failure");
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  const write = spyOn(filesystem, "writeFileSync").mockImplementation((path, data, options) => {
    if (typeof path === "number") throw failure;
    return originalWrite(path, data, options);
  });
  const removal = spyOn(filesystem, "unlinkSync").mockImplementation(path => {
    if (String(path).includes(".proxy-token.") && String(path).endsWith(".tmp")) {
      throw Object.assign(new Error("secondary removal error"), { code: "EACCES" });
    }
    return originalUnlink(path);
  });
  try {
    let caught: unknown;
    try { ensureClaudeInterceptProxyToken(root); } catch (error) { caught = error; }
    expect(caught).toBe(failure);
    expect(readClaudeInterceptProxyToken(root)).toBeNull();
    expect(warning).toHaveBeenCalledTimes(1);
  } finally { removal.mockRestore(); write.mockRestore(); warning.mockRestore(); }
});
test("a temporary close error does not replace the published credential result", () => {
  const root = dir();
  const originalWrite = filesystem.writeFileSync;
  const originalClose = filesystem.closeSync;
  let tempFd = -1;
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  const write = spyOn(filesystem, "writeFileSync").mockImplementation((path, data, options) => {
    if (typeof path === "number") tempFd = path;
    return originalWrite(path, data, options);
  });
  const close = spyOn(filesystem, "closeSync").mockImplementation(fd => {
    originalClose(fd);
    if (fd === tempFd) {
      tempFd = -1;
      throw new Error("injected post-close error");
    }
  });
  try {
    const token = ensureClaudeInterceptProxyToken(root);
    expect(readClaudeInterceptProxyToken(root)).toBe(token);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(readdirSync(join(root, "claude-intercept"))).toEqual(["proxy-token"]);
  } finally { close.mockRestore(); write.mockRestore(); warning.mockRestore(); }
});
