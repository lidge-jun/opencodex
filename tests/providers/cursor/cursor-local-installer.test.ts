import { describe, expect, test } from "bun:test";
import { buildCursorLocalInstallerHint, platformForHost, realCursorLocalHintDeps } from "../../../src/integrations/cursor-local-installer";

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
  });

  test("on an unknown host OS the platforms are tried in order and the first usable answer wins", async () => {
    const asked: string[] = [];
    const hint = await buildCursorLocalInstallerHint(
      { regularInstalled: true, privateInferenceInstalled: false },
      {
        platform: "freebsd",
        arch: "x64",
        fetchJson: async (url: string) => {
          const platform = url.split("/update/")[1]!.split("/")[0]!;
          asked.push(platform);
          if (platform === "win32-x64-user") throw new Error("refused");
          if (platform === "win32-arm64-user") return { version: "1" };
          return { version: "3.21.18", url: REPORTED_INSTALLER };
        },
      },
    );
    expect(asked).toEqual(["win32-x64-user", "win32-arm64-user", "win32-x64"]);
    expect(hint).toEqual({ available: true, url: REPORTED_INSTALLER, version: "3.21.18", reason: null });
  });

  test("real deps carry the host platform and architecture", () => {
    const real = realCursorLocalHintDeps();
    expect(real.platform).toBe(process.platform);
    expect(real.arch).toBe(process.arch);
  });
});
