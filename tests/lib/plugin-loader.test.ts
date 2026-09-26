import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { resetOptionalShutdownHooksForTests, runOptionalShutdownHooks } from "../../src/lib/optional-shutdown-hooks";
import { loadOcxPlugins, pluginFileTrustError } from "../../src/plugins/loader";
import {
  hasUpstreamRewriters,
  resetUpstreamRewritersForTests,
  rewriteUpstream,
} from "../../src/plugins/upstream-hooks";

let dir: string;

// The loader refuses a plugin directory with a group- or other-writable, non-sticky ancestor.
// The test runner nests per-process temp roots and creates them with the caller's umask, which is
// group-writable on user-private-group systems (umask 002). Those directories belong to this
// test run, so drop group/other write on every ancestor this user owns. The root-owned sticky
// `/tmp` above them is accepted as is, which also exercises the sticky exception.
beforeAll(() => {
  if (process.platform === "win32") return;
  for (let current = realpathSync(tmpdir()); ; current = dirname(current)) {
    try {
      const stats = statSync(current);
      if (stats.uid === process.getuid?.() && (stats.mode & 0o022) !== 0 && (stats.mode & 0o1000) === 0) {
        chmodSync(current, stats.mode & 0o7755);
      }
    } catch { /* leave directories this run cannot inspect alone */ }
    if (dirname(current) === current) break;
  }
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocx-plugins-"));
  delete process.env["OCX_PLUGINS"];
});

afterEach(() => {
  resetUpstreamRewritersForTests();
  delete process.env["OCX_PLUGINS"];
  rmSync(dir, { recursive: true, force: true });
});

function writePlugin(file: string, source: string, mode = 0o600): string {
  const path = join(dir, file);
  writeFileSync(path, source);
  chmodSync(path, mode);
  return path;
}

const REDIRECT_PLUGIN = `
export default {
  name: "redirect",
  setup(ctx) {
    ctx.registerUpstreamRewriter(target => { target.url = "http://127.0.0.1:8787" + new URL(target.url).pathname; });
  },
};
`;

test("a missing plugin directory loads nothing", async () => {
  expect(await loadOcxPlugins(join(dir, "absent"))).toEqual([]);
  expect(hasUpstreamRewriters()).toBe(false);
});

test("a valid plugin registers its upstream rewriter", async () => {
  writePlugin("redirect.ts", REDIRECT_PLUGIN);
  const results = await loadOcxPlugins(dir);
  expect(results.map(result => [result.name, result.loaded])).toEqual([["redirect", true]]);
  expect(rewriteUpstream("https://api.example.com/v1/responses", undefined, "http").url)
    .toBe("http://127.0.0.1:8787/v1/responses");
});

test("OCX_PLUGINS=0 skips loading", async () => {
  writePlugin("redirect.ts", REDIRECT_PLUGIN);
  process.env["OCX_PLUGINS"] = "0";
  expect(await loadOcxPlugins(dir)).toEqual([]);
  expect(hasUpstreamRewriters()).toBe(false);
});

test("Windows does not auto-load plugins without an ACL trust check", async () => {
  writePlugin("redirect.ts", REDIRECT_PLUGIN);
  const platform = process.platform;
  try {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const results = await loadOcxPlugins(dir);
    expect(results).toEqual([{ file: dir, name: "plugins directory", loaded: false, error: "windows_auto_load_disabled" }]);
    expect(hasUpstreamRewriters()).toBe(false);
  } finally {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
  }
});

test("plugin setup exceptions expose only a bounded category", async () => {
  const marker = "private plugin error marker";
  writePlugin("throws.ts", `export default { setup() { throw new Error("${marker}"); } };`);
  const results = await loadOcxPlugins(dir);
  expect(results[0]?.loaded).toBe(false);
  expect(results[0]?.error).toBe("setup_failed");
  expect(JSON.stringify(results)).not.toContain(marker);
});

test.skipIf(process.platform === "win32")("a group- or world-writable plugin is refused", async () => {
  const path = writePlugin("redirect.ts", REDIRECT_PLUGIN, 0o664);
  expect(pluginFileTrustError(path)).toContain("writable by group or others");
  const [result] = await loadOcxPlugins(dir);
  expect(result?.loaded).toBe(false);
  expect(hasUpstreamRewriters()).toBe(false);
});

test.skipIf(process.platform !== "darwin")("a mode-0600 plugin with an everyone-write ACL is refused", async () => {
  const path = writePlugin("acl.ts", REDIRECT_PLUGIN, 0o600);
  execFileSync("chmod", ["+a", "everyone allow write", path]);
  expect(pluginFileTrustError(path)).toBe("has an access control list");
  const [result] = await loadOcxPlugins(dir);
  expect(result?.error).toBe("file_untrusted");
  expect(hasUpstreamRewriters()).toBe(false);
});

test.skipIf(process.platform !== "darwin")("an ACL on an ancestor directory blocks plugin loading", async () => {
  const parent = mkdtempSync(join(tmpdir(), "ocx-plugin-acl-parent-"));
  const nested = join(parent, "plugins");
  try {
    mkdirSync(nested);
    writeFileSync(join(nested, "redirect.ts"), REDIRECT_PLUGIN);
    execFileSync("chmod", ["+a", "everyone allow write", parent]);
    const [result] = await loadOcxPlugins(nested);
    expect(result?.error).toBe("ancestor_untrusted");
    expect(hasUpstreamRewriters()).toBe(false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "darwin")("an ACL on the plugin directory blocks plugin loading", async () => {
  writePlugin("redirect.ts", REDIRECT_PLUGIN);
  execFileSync("chmod", ["+a", "everyone allow write", dir]);
  const [result] = await loadOcxPlugins(dir);
  expect(result?.error).toBe("directory_untrusted");
  expect(hasUpstreamRewriters()).toBe(false);
});

test.skipIf(process.platform === "win32")("a symbolic link is refused even when it points to a trusted file", async () => {
  const outside = mkdtempSync(join(tmpdir(), "ocx-plugin-target-"));
  try {
    const target = join(outside, "real.ts");
    writeFileSync(target, REDIRECT_PLUGIN);
    chmodSync(target, 0o600);
    symlinkSync(target, join(dir, "linked.ts"));
    const [result] = await loadOcxPlugins(dir);
    expect(result?.loaded).toBe(false);
    expect(result?.error).toBe("file_untrusted");
    expect(hasUpstreamRewriters()).toBe(false);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("a plugin directory writable by group or others is refused", async () => {
  writePlugin("redirect.ts", REDIRECT_PLUGIN);
  chmodSync(dir, 0o775);
  const results = await loadOcxPlugins(dir);
  expect(results).toEqual([{
    file: dir,
    name: "plugins directory",
    loaded: false,
    error: "directory_untrusted",
  }]);
  expect(hasUpstreamRewriters()).toBe(false);
});

test.skipIf(process.platform === "win32")("a plugin directory under a group-writable, non-sticky parent is refused", async () => {
  const parent = join(dir, "shared");
  const nested = join(parent, "plugins");
  mkdirSync(nested, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o775);
  writeFileSync(join(nested, "redirect.ts"), REDIRECT_PLUGIN);
  chmodSync(join(nested, "redirect.ts"), 0o600);
  const results = await loadOcxPlugins(nested);
  expect(results).toHaveLength(1);
  expect(results[0]?.loaded).toBe(false);
  expect(results[0]?.error).toBe("ancestor_untrusted");
  expect(hasUpstreamRewriters()).toBe(false);
});

test("a wrong export shape or a throwing setup is skipped and leaves no hooks behind", async () => {
  writePlugin("a-shape.ts", "export default { name: 'shape' };");
  writePlugin("b-throws.ts", `
export default {
  setup(ctx) {
    ctx.registerUpstreamRewriter(target => { target.url = "http://leaked/"; });
    throw new Error("setup failed");
  },
};
`);
  writePlugin("c-ok.ts", REDIRECT_PLUGIN);
  const results = await loadOcxPlugins(dir);
  expect(results.map(result => [result.name, result.loaded])).toEqual([
    ["a-shape", false],
    ["b-throws", false],
    ["redirect", true],
  ]);
  expect(results[1]?.error).toBe("setup_failed");
  expect(rewriteUpstream("https://api.example.com/v1/x", undefined, "http").url).toBe("http://127.0.0.1:8787/v1/x");
});

test("a plugin path that cannot be read is reported, not treated as empty", async () => {
  const notADirectory = writePlugin("file-not-dir", "x");
  const results = await loadOcxPlugins(notADirectory);
  expect(results).toHaveLength(1);
  expect(results[0]?.loaded).toBe(false);
  expect(results[0]?.name).toBe("plugins directory");
  expect(results[0]?.error).toBe("directory_read_failed");
});

test("two plugins with the same name keep separate shutdown teardowns", async () => {
  const ran: string[] = [];
  (globalThis as Record<string, unknown>)["__ocxTeardownLog"] = ran;
  const source = (tag: string) => `
export default {
  name: "same",
  setup(ctx) { ctx.onShutdown(() => { globalThis.__ocxTeardownLog.push("${tag}"); }); },
};
`;
  writePlugin("a.ts", source("a"));
  writePlugin("b.ts", source("b"));
  resetOptionalShutdownHooksForTests();
  try {
    const results = await loadOcxPlugins(dir);
    expect(results.map(result => result.loaded)).toEqual([true, true]);
    runOptionalShutdownHooks();
    expect(ran.sort()).toEqual(["a", "b"]);
  } finally {
    resetOptionalShutdownHooksForTests();
    delete (globalThis as Record<string, unknown>)["__ocxTeardownLog"];
  }
});

test("one plugin can register several shutdown teardowns", async () => {
  const ran: string[] = [];
  (globalThis as Record<string, unknown>)["__ocxTeardownLog"] = ran;
  writePlugin("multi.ts", `
export default {
  setup(ctx) {
    ctx.onShutdown(() => { globalThis.__ocxTeardownLog.push("first"); });
    ctx.onShutdown(() => { globalThis.__ocxTeardownLog.push("second"); });
  },
};
`);
  resetOptionalShutdownHooksForTests();
  try {
    expect((await loadOcxPlugins(dir))[0]?.loaded).toBe(true);
    runOptionalShutdownHooks();
    expect(ran.sort()).toEqual(["first", "second"]);
  } finally {
    resetOptionalShutdownHooksForTests();
    delete (globalThis as Record<string, unknown>)["__ocxTeardownLog"];
  }
});

test("a setup that resumes after its deadline cannot leave registrations behind", async () => {
  writePlugin("slow.ts", `
export default {
  name: "slow",
  async setup(ctx) {
    await new Promise(resolve => setTimeout(resolve, 60));
    ctx.registerUpstreamRewriter(target => { target.url = "http://leaked/"; });
  },
};
`);
  const originalError = console.error;
  console.error = () => {};
  try {
    const results = await loadOcxPlugins(dir, { setupTimeoutMs: 20 });
    expect(results[0]?.loaded).toBe(false);
    expect(results[0]?.error).toBe("setup_timeout");
    await new Promise(resolve => setTimeout(resolve, 120));
  } finally {
    console.error = originalError;
  }
  expect(hasUpstreamRewriters()).toBe(false);
});

test("hidden, underscore-prefixed and declaration files are ignored", async () => {
  writePlugin(".hidden.ts", REDIRECT_PLUGIN);
  writePlugin("_draft.ts", REDIRECT_PLUGIN);
  writePlugin("types.d.ts", "export {};");
  writePlugin("notes.md", "# not a plugin");
  expect(await loadOcxPlugins(dir)).toEqual([]);
});
