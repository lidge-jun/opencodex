import { beforeEach, describe, expect, test } from "bun:test";
import { buildCursorLocalInstallerHint, platformForHost, realCursorLocalHintDeps, resetCursorLocalInstallerCacheForTests } from "../../../src/integrations/cursor-local-installer";

const MANIFEST_URL = "https://api2.cursor.sh/updates/api/update/win32-x64-user/cursor-local/0.0.0/manual-check/stable";
const REPORTED_INSTALLER = "https://downloads.cursor.com/local-mode/c4730f7d93d787d9ab120af715999f0345ee5bc5/win32/x64/user-setup/CursorUserSetup-x64-3.21.18.exe";

function depsWith(manifest: unknown, opts: { fail?: boolean } = {}) {
  return {
    platform: "win32",
    arch: "x64",
    fetchJson: async (url: string) => {
      expect(url).toBe(MANIFEST_URL);
      if (opts.fail) throw new Error("unreachable");
      return manifest;
    },
  };
}

describe("buildCursorLocalInstallerHint", () => {
  beforeEach(() => resetCursorLocalInstallerCacheForTests());

  test("resolves the reported win32-x64-user manifest into an available hint", async () => {
    const hint = await buildCursorLocalInstallerHint(
      { regularInstalled: true, privateInferenceInstalled: false },
      depsWith({ version: "3.21.18", url: REPORTED_INSTALLER, productVersion: "3.21.18" }),
    );
    expect(hint).toEqual({ available: true, url: REPORTED_INSTALLER, version: "3.21.18", reason: null });
  });

  test("stays quiet when Private Inference is already installed", async () => {
    const hint = await buildCursorLocalInstallerHint(
      { regularInstalled: true, privateInferenceInstalled: true },
      depsWith({ version: "3.21.18", url: REPORTED_INSTALLER }),
    );
    expect(hint).toEqual({ available: false, url: null, version: null, reason: null });
  });

  test("a regular install alone with no manifest answer is unavailable, not an error", async () => {
    const hint = await buildCursorLocalInstallerHint(
      { regularInstalled: true, privateInferenceInstalled: false },
      depsWith(null),
    );
    expect(hint).toEqual({ available: false, url: null, version: null, reason: "unusable-response" });
  });

  test("an unreachable manifest reports unreachable without throwing", async () => {
    const hint = await buildCursorLocalInstallerHint(
      { regularInstalled: true, privateInferenceInstalled: false },
      depsWith(undefined, { fail: true }),
    );
    expect(hint).toEqual({ available: false, url: null, version: null, reason: "unreachable" });
  });

  test("a URL outside the local-mode installer host is rejected", async () => {
    const hint = await buildCursorLocalInstallerHint(
      { regularInstalled: true, privateInferenceInstalled: false },
      depsWith({ version: "3.21.18", url: "https://evil.example/CursorUserSetup-x64-3.21.18.exe" }),
    );
    expect(hint).toEqual({ available: false, url: null, version: null, reason: "unusable-response" });
  });

  test("no regular install resolves nothing without any network call", async () => {
    const hint = await buildCursorLocalInstallerHint(
      { regularInstalled: false, privateInferenceInstalled: false },
      { platform: "win32", arch: "x64", fetchJson: async () => { throw new Error("must not fetch"); } },
    );
    expect(hint).toEqual({ available: false, url: null, version: null, reason: "no-regular-install" });
  });

  test("a Linux zsync manifest points at the sibling AppImage installer", async () => {
    const zsync = "https://downloads.cursor.com/local-mode/37076c6c3f9e253c0fa2305197e45befd13a2268/linux/x64/Cursor_Private_Inference-3.22.7-x86_64.AppImage.zsync";
    const hint = await buildCursorLocalInstallerHint(
      { regularInstalled: true, privateInferenceInstalled: false },
      { platform: "linux", arch: "x64", fetchJson: async (url: string) => {
        expect(url).toContain("/linux-x64/cursor-local/");
        return { version: "3.22.7", url: zsync };
      } },
    );
    expect(hint).toEqual({ available: true, url: zsync.slice(0, -".zsync".length), version: "3.22.7", reason: null });
  });

  test("the channel platform follows the host architecture", () => {
    expect(platformForHost("win32", "x64")).toBe("win32-x64-user");
    expect(platformForHost("win32", "arm64")).toBe("win32-arm64-user");
    expect(platformForHost("darwin", "arm64")).toBe("darwin-arm64");
    expect(platformForHost("darwin", "x64")).toBe("darwin-x64");
    expect(platformForHost("linux", "x64")).toBe("linux-x64");
    expect(platformForHost("linux", "arm64")).toBe("linux-arm64");
    expect(platformForHost("freebsd", "x64")).toBeNull();
    for (const arch of ["ia32", "arm", "riscv64", "ppc64", "s390x"]) {
      expect(platformForHost("linux", arch)).toBeNull();
      expect(platformForHost("win32", arch)).toBeNull();
    }
  });

  test("a host Cursor ships no build for gets no link and makes no request", async () => {
    for (const [platform, arch] of [["freebsd", "x64"], ["linux", "riscv64"], ["win32", "ia32"]] as const) {
      const hint = await buildCursorLocalInstallerHint(
        { regularInstalled: true, privateInferenceInstalled: false },
        { platform, arch, fetchJson: async () => { throw new Error("must not fetch"); } },
      );
      expect(hint).toEqual({ available: false, url: null, version: null, reason: "unsupported-platform" });
    }
  });

  test("a blank version is rejected like a missing one", async () => {
    for (const version of ["", "   "]) {
      resetCursorLocalInstallerCacheForTests();
      const hint = await buildCursorLocalInstallerHint(
        { regularInstalled: true, privateInferenceInstalled: false },
        depsWith({ version, url: REPORTED_INSTALLER }),
      );
      expect(hint).toEqual({ available: false, url: null, version: null, reason: "unusable-response" });
    }
  });

  test("answers are cached per platform: successes for 30 minutes, failures for 5", async () => {
    let clock = 0;
    let calls = 0;
    let fail = true;
    const deps = {
      platform: "win32", arch: "x64", now: () => clock,
      fetchJson: async () => {
        calls += 1;
        if (fail) throw new Error("down");
        return { version: "3.21.18", url: REPORTED_INSTALLER };
      },
    };
    const installs = { regularInstalled: true, privateInferenceInstalled: false };
    expect((await buildCursorLocalInstallerHint(installs, deps)).reason).toBe("unreachable");
    clock += 4 * 60_000;
    expect((await buildCursorLocalInstallerHint(installs, deps)).reason).toBe("unreachable");
    expect(calls).toBe(1);
    fail = false;
    clock += 2 * 60_000;
    expect((await buildCursorLocalInstallerHint(installs, deps)).available).toBe(true);
    expect(calls).toBe(2);
    clock += 29 * 60_000;
    expect((await buildCursorLocalInstallerHint(installs, deps)).available).toBe(true);
    expect(calls).toBe(2);
    clock += 2 * 60_000;
    await buildCursorLocalInstallerHint(installs, deps);
    expect(calls).toBe(3);
  });

  test("concurrent lookups share one request", async () => {
    let calls = 0;
    let release: (value: unknown) => void = () => {};
    const deps = {
      platform: "win32", arch: "x64",
      fetchJson: () => { calls += 1; return new Promise<unknown>(resolve => { release = resolve; }); },
    };
    const installs = { regularInstalled: true, privateInferenceInstalled: false };
    const pending = [buildCursorLocalInstallerHint(installs, deps), buildCursorLocalInstallerHint(installs, deps), buildCursorLocalInstallerHint(installs, deps)];
    await Bun.sleep(0);
    release({ version: "3.21.18", url: REPORTED_INSTALLER });
    const hints = await Promise.all(pending);
    expect(calls).toBe(1);
    expect(hints.every(hint => hint.available && hint.url === REPORTED_INSTALLER)).toBe(true);
  });

  test("real deps carry the host platform and architecture", () => {
    const real = realCursorLocalHintDeps();
    expect(real.platform).toBe(process.platform);
    expect(real.arch).toBe(process.arch);
  });
});
