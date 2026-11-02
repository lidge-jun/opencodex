import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { handleInternalCommand } from "../../src/cli/internal-command";
import { buildChatgptShimLauncher, writeChatgptShimLauncher, chatgptShimLauncherPath } from "../../src/chatgpt/app-server-shim/launcher";
import { untrustedLauncherFilesystemReason, type BundleTrustDeps } from "../../src/chatgpt/app-server-shim/bundle-trust-policy";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const root = "/Volumes/Apps/ChatGPT Beta.app";
const binary = `${root}/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`;
let logs: ReturnType<typeof spyOn<typeof console, "log">>;
let errors: ReturnType<typeof spyOn<typeof console, "error">>;
beforeEach(() => {
  logs = spyOn(console, "log").mockImplementation(() => {});
  errors = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { logs.mockRestore(); errors.mockRestore(); });

test("a recorded renamed bundle rechecks trust after revocation without a conventional alias", async () => {
  let allowed = true;
  const checked: string[][] = [];
  const boundary = {
    platform: "darwin" as const, executable: () => true, realpath: (path: string) => path,
    expectedBundleRoot: root,
    macBundleTrustReasonAsync: async (bundle: string, target: string) => {
      checked.push([bundle, target]);
      return allowed ? null : "signature revoked";
    },
  };
  expect(await handleInternalCommand(["codex-exec-target", "--", binary], boundary)).toBe(0);
  expect(logs.mock.calls).toEqual([[binary]]);
  logs.mockClear(); allowed = false;
  expect(await handleInternalCommand(["codex-exec-target", "--", binary], boundary)).toBe(1);
  expect(logs.mock.calls).toEqual([]);
  expect(checked).toEqual([[root, binary], [root, binary]]);
});

test("launcher carries its outer renamed bundle root inline to the strict helper mode", () => {
  const script = buildChatgptShimLauncher(["/filter"], binary, ["/ocx", "internal", "codex-exec-target"]);
  expect(script).toContain(`BUNDLE_ROOT='${root}'`);
  expect(script).toContain('--bundle-root "$BUNDLE_ROOT" -- "$REAL"');
});

test("explicit bundle mode validates a renamed bundle and never accepts an empty root", async () => {
  let checks = 0;
  const boundary = {
    platform: "darwin" as const, executable: () => true, realpath: (path: string) => path,
    macBundleTrustReasonAsync: async (bundle: string, target: string) => {
      checks++; expect(bundle).toBe(root); expect(target).toBe(binary); return null;
    },
  };
  expect(await handleInternalCommand(["codex-exec-target", "--bundle-root", root, "--", binary], boundary)).toBe(0);
  expect(checks).toBe(1);
  for (const args of [
    ["--bundle-root", "", "--", binary], ["--bundle-root", root],
    ["--bundle-root", root, "--", binary, "extra"], ["--bundle-root", `${root}\nextra`, "--", binary],
  ]) expect(await handleInternalCommand(["codex-exec-target", ...args], boundary)).toBe(2);
  expect(checks).toBe(1);
});

test("launcher helper argv rechecks the recorded root on a later respawn", async () => {
  const args = ["codex-exec-target", "--bundle-root", root, "--", binary];
  let allowed = true, checks = 0;
  const boundary = {
    platform: "darwin" as const, executable: () => true, realpath: (path: string) => path,
    macBundleTrustReasonAsync: async (bundle: string, target: string) => {
      checks++; expect(bundle).toBe(root); expect(target).toBe(binary);
      return allowed ? null : "signature revoked";
    },
  };
  expect(await handleInternalCommand(args, boundary)).toBe(0);
  logs.mockClear(); allowed = false;
  expect(await handleInternalCommand(args, boundary)).toBe(1);
  expect(checks).toBe(2); expect(logs.mock.calls).toEqual([]);
});

for (const defect of ["missing root", "missing binary", "escape", "prefix sibling", "outside Contents"] as const) {
  test(`recorded bundle refuses ${defect} before invoking trust`, async () => {
    let checks = 0;
    const boundary = {
      platform: "darwin" as const, executable: () => true,
      realpath: (path: string) => {
        if (path === root && defect === "missing root" || path === binary && defect === "missing binary") return null;
        if (path !== binary) return path;
        return defect === "escape" ? "/opt/codex" : defect === "prefix sibling" ? `${root}-copy/Contents/codex`
          : defect === "outside Contents" ? `${root}/codex` : path;
      },
      macBundleTrustReasonAsync: async () => { checks++; return null; },
    };
    expect(await handleInternalCommand(["codex-exec-target", "--bundle-root", root, "--", binary], boundary)).toBe(1);
    expect(checks).toBe(0); expect(logs.mock.calls).toEqual([]);
  });
}

test("ordinary executable helper calls retain passthrough", async () => {
  const target = "/opt/bin/codex";
  expect(await handleInternalCommand(["codex-exec-target", "--", target], {
    platform: "darwin", executable: () => true, realpath: path => path,
    macBundleTrustReasonAsync: async () => { throw new Error("ordinary CLI must not be checked"); },
  })).toBe(0);
  expect(logs.mock.calls).toEqual([[target]]);
});

test("recorded bundle validation uses a consistent canonical root and target", async () => {
  const canonicalRoot = "/private/Apps/ChatGPT Beta.app";
  const target = binary.replace(root, canonicalRoot);
  expect(await handleInternalCommand(["codex-exec-target", "--bundle-root", root, "--", binary], {
    platform: "darwin", executable: () => true, realpath: path => path.replace(root, canonicalRoot),
    macBundleTrustReasonAsync: async (bundle, executable) => {
      expect(bundle).toBe(canonicalRoot); expect(executable).toBe(target); return null;
    },
  })).toBe(0);
  expect(logs.mock.calls).toEqual([[target]]);
});

test("recorded bundle mode refuses on a host without macOS verification", async () => {
  expect(await handleInternalCommand(["codex-exec-target", "--bundle-root", root, "--", binary], { platform: "linux" })).toBe(1);
  expect(logs.mock.calls).toEqual([]);
});

for (const defect of ["none", "foreign file", "writable file", "link file", "foreign parent", "writable parent", "link parent"] as const) {
  test(`inline root's launcher filesystem policy: ${defect}`, () => {
    const path = "/owned/config/launcher.sh";
    const deps: Omit<BundleTrustDeps, "codesign"> = {
      uid: 501,
      stat: entry => {
        const bad = entry === (defect.endsWith("file") ? path : dirname(path));
        return { uid: bad && defect.startsWith("foreign") ? 502 : 501,
          mode: bad && defect.startsWith("writable") ? 0o777 : 0o755,
          isFile: entry === path, isDirectory: entry !== path,
          isSymbolicLink: bad && defect.startsWith("link") };
      },
    };
    expect(untrustedLauncherFilesystemReason(path, deps) === null).toBe(defect === "none");
  });
}

for (const defect of ["none", "parent", "file"] as const) {
  test(`writer protects recorded root before publication: ${defect}`, () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ocx-recorded-root-")));
    const launcher = chatgptShimLauncherPath(dir);
    try {
      writeFileSync(launcher, "original");
      const deps: Omit<BundleTrustDeps, "codesign"> = {
        uid: 501,
        stat: entry => ({ uid: 501,
          mode: defect === "parent" && entry === dir || defect === "file" && entry.endsWith(".tmp") ? 0o777 : 0o755,
          isFile: entry.endsWith(".tmp"), isDirectory: !entry.endsWith(".tmp"), isSymbolicLink: false }),
      };
      const write = () => writeChatgptShimLauncher(dir, binary, root, deps);
      if (defect === "none") {
        expect(write()).toBe(launcher);
        const text = readFileSync(launcher, "utf8");
        expect(text).toContain(`BUNDLE_ROOT='${root}'`);
        expect(text).toContain('--bundle-root "$BUNDLE_ROOT" -- "$REAL"');
      } else {
        expect(write).toThrow("unsafe app-server launcher");
        expect(readFileSync(launcher, "utf8")).toBe("original");
      }
      expect(readdirSync(dir)).toEqual(["chatgpt-codex-shim.sh"]);
    } finally { removeTreeWithRetry(dir); }
  });
}
