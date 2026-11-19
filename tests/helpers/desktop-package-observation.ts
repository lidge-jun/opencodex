import { win32 } from "node:path";
import { DESKTOP_COMPATIBILITY_ASSESSED_FAMILY, DESKTOP_COMPATIBILITY_ASSESSED_VERSION,
  type DesktopPackageObservation, type VerifiedDesktopPackage } from "../../src/codex/desktop-compatibility/installed-build";

/** Synthetic registered package, signer and content facts. */
export function desktopPackageObservation(version = DESKTOP_COMPATIBILITY_ASSESSED_VERSION): DesktopPackageObservation {
  const packageFullName = `OpenAI.Codex_${version}_x64__2p2nqsd0c76g0`;
  const root = win32.join("C:\\Program Files\\WindowsApps", packageFullName);
  const publisher = "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B";
  return { id: DESKTOP_COMPATIBILITY_ASSESSED_FAMILY, root, relaunch: `${DESKTOP_COMPATIBILITY_ASSESSED_FAMILY}!App`,
    proof: { packageFullName, publisherId: "2p2nqsd0c76g0", publisher,
      manifestName: "OpenAI.Codex", manifestPublisher: publisher, manifestVersion: version,
      appId: "App", executable: "app\\ChatGPT.exe", canonicalExecutable: win32.join(root, "app", "ChatGPT.exe"),
      manifestDigest: "a".repeat(64), ancestryIdentity: "c".repeat(64), executableIdentity: "1024:100:200",
      executableHash: "d".repeat(64), signatureKind: "Store", contentIntegrity: true, signerThumbprint: "E".repeat(40),
      signerSubject: 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC", L=San Francisco, S=California, C=US' } };
}

export function verifiedDesktopPackage(version?: string): VerifiedDesktopPackage {
  const { id, root, relaunch, proof } = desktopPackageObservation(version);
  return { id, root, relaunch, packageFullName: proof!.packageFullName, executableHash: proof!.executableHash!,
    manifestDigest: proof!.manifestDigest, ancestryIdentity: proof!.ancestryIdentity, executableIdentity: proof!.executableIdentity,
    signerThumbprint: proof!.signerThumbprint! };
}
