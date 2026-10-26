import { win32 } from "node:path";
import { DESKTOP_COMPATIBILITY_ASSESSED_FAMILY, DESKTOP_COMPATIBILITY_ASSESSED_VERSION,
  type DesktopPackageObservation } from "../../src/codex/desktop-compatibility/installed-build";

/** Synthetic registered manifest/file facts; never performs a host package query. */
export function desktopPackageObservation(version = DESKTOP_COMPATIBILITY_ASSESSED_VERSION): DesktopPackageObservation {
  const packageFullName = `OpenAI.Codex_${version}_x64__2p2nqsd0c76g0`;
  const root = win32.join("C:\\Program Files\\WindowsApps", packageFullName);
  return { id: DESKTOP_COMPATIBILITY_ASSESSED_FAMILY, root, relaunch: `${DESKTOP_COMPATIBILITY_ASSESSED_FAMILY}!App`,
    proof: { packageFullName, publisherId: "2p2nqsd0c76g0", publisher: "CN=Fixture Registered Publisher",
      manifestName: "OpenAI.Codex", manifestPublisher: "CN=Fixture Registered Publisher", manifestVersion: version,
      appId: "App", executable: "app\\ChatGPT.exe", canonicalExecutable: win32.join(root, "app", "ChatGPT.exe"),
      manifestDigest: "a".repeat(64), executableIdentity: "1024:100:200", ancestryIdentity: "c".repeat(64) } };
}
