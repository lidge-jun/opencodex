import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";
import { DESKTOP_UPDATE_FEED_URL, DESKTOP_UPDATER_PUBKEY, desktopInstallerUrl } from "../../src/desktop-update/trust";
import { compareToInstalled, DesktopUpdateRefusal, parseDesktopFeed, verifyDesktopInstaller } from "../../src/desktop-update/release";

const MSI = Buffer.concat([Buffer.from("d0cf11e0a1b11ae1", "hex"), Buffer.from("fixture installer payload")]);

/** A dedicated fixture key in the Tauri updater's encoding; never the production key. */
function fixtureSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(-32);
  const id = Buffer.from("0011223344556677", "hex");
  const keyBox = `untrusted comment: minisign public key: fixture\n${Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64")}\n`;
  const signBytes = (bytes: Uint8Array, comment: string, algorithm = "ED") => {
    const payload = algorithm === "ED" ? createHash("blake2b512").update(bytes).digest() : Buffer.from(bytes);
    const signature = sign(null, payload, privateKey);
    const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
    const packet = Buffer.concat([Buffer.from(algorithm), id, signature]).toString("base64");
    return Buffer.from(`untrusted comment: signature from tauri secret key\n${packet}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`).toString("base64");
  };
  return { pubkey: Buffer.from(keyBox).toString("base64"), signBytes };
}

function feed(version: string, entry: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return new TextEncoder().encode(JSON.stringify({ version, notes: "n", pub_date: "2026-11-14T01:30:07Z", platforms: { "windows-x86_64": entry, ...extra } }));
}

describe("headless trust is the GUI updater's trust", () => {
  test("the embedded key and feed equal desktop/src-tauri/tauri.conf.json", () => {
    const conf = JSON.parse(readFileSync(repoPath("desktop/src-tauri/tauri.conf.json"), "utf8"));
    expect(DESKTOP_UPDATER_PUBKEY).toBe(conf.plugins.updater.pubkey);
    expect([DESKTOP_UPDATE_FEED_URL]).toEqual(conf.plugins.updater.endpoints);
  });
});

describe("release feed", () => {
  const url = desktopInstallerUrl("2.100.3");
  test("selects the exact Windows x64 MSI asset", () => {
    expect(url).toBe("https://github.com/lidge-jun/opencodex/releases/download/v2.100.3/OpenCodex-2.100.3-windows-x64.msi");
    expect(parseDesktopFeed(feed("2.100.3", { url, signature: "c2ln" }))).toEqual({ version: "2.100.3", url, signature: "c2ln" });
  });

  const cases: Array<[string, Uint8Array, string]> = [
    ["not JSON", new TextEncoder().encode("<html>"), "feed_malformed"],
    ["no version", new TextEncoder().encode(JSON.stringify({ platforms: {} })), "feed_version"],
    ["a v-prefixed version", feed("v2.100.3", { url, signature: "c2ln" }), "feed_version"],
    ["no Windows entry", new TextEncoder().encode(JSON.stringify({ version: "2.100.3", platforms: { "darwin-aarch64": {} } })), "feed_target_missing"],
    ["another asset", feed("2.100.3", { url: url.replace("windows-x64.msi", "windows-x64.exe"), signature: "c2ln" }), "feed_source"],
    ["another release", feed("2.100.3", { url: desktopInstallerUrl("2.100.2"), signature: "c2ln" }), "feed_source"],
    ["another repository", feed("2.100.3", { url: url.replace("lidge-jun", "someone"), signature: "c2ln" }), "feed_source"],
    ["no signature", feed("2.100.3", { url }), "signature_missing"],
    ["two Windows installers", feed("2.100.3", { url, signature: "c2ln" }, { "windows-x86_64-msi": { url, signature: "b3RoZXI=" } }), "feed_target_ambiguous"],
  ];
  for (const [name, bytes, code] of cases) {
    test(`refuses ${name}`, () => {
      expect(() => parseDesktopFeed(bytes)).toThrow(DesktopUpdateRefusal);
      try { parseDesktopFeed(bytes); } catch (error) { expect((error as DesktopUpdateRefusal).code).toBe(code as DesktopUpdateRefusal["code"]); }
    });
  }
});

describe("installer verification", () => {
  const signer = fixtureSigner();
  const candidate = (signature: string, version = "2.100.3") => ({ version, url: desktopInstallerUrl(version), signature });
  const comment = "timestamp:1794619257\tfile:OpenCodex_2.100.3_x64_en-US.msi";
  const code = (work: () => unknown) => { try { work(); } catch (error) { return (error as DesktopUpdateRefusal).code; } return "accepted"; };

  test("accepts the exact signed MSI for its version and target", () => {
    expect(verifyDesktopInstaller(MSI, candidate(signer.signBytes(MSI, comment)), signer.pubkey).trustedComment).toBe(comment);
    const signedVersion = `${comment}\tversion:2.100.3`;
    expect(code(() => verifyDesktopInstaller(MSI, candidate(signer.signBytes(MSI, signedVersion)), signer.pubkey))).toBe("accepted");
  });

  test("refuses changed bytes, another key and the legacy unhashed form", () => {
    const tampered = Buffer.from(MSI); tampered[tampered.length - 1] ^= 1;
    expect(code(() => verifyDesktopInstaller(tampered, candidate(signer.signBytes(MSI, comment)), signer.pubkey))).toBe("signature_invalid");
    expect(code(() => verifyDesktopInstaller(MSI, candidate(fixtureSigner().signBytes(MSI, comment)), signer.pubkey))).toBe("signature_invalid");
    // The production key never accepts a fixture signature.
    expect(code(() => verifyDesktopInstaller(MSI, candidate(signer.signBytes(MSI, comment))))).toBe("signature_invalid");
    expect(code(() => verifyDesktopInstaller(MSI, candidate(signer.signBytes(MSI, comment, "Ed")), signer.pubkey))).toBe("signature_invalid");
    expect(code(() => verifyDesktopInstaller(MSI, candidate("not a signature"), signer.pubkey))).toBe("signature_invalid");
  });

  test("refuses a signature bound to another version or target", () => {
    const wrong = (signed: string) => code(() => verifyDesktopInstaller(MSI, candidate(signer.signBytes(MSI, signed)), signer.pubkey));
    expect(wrong(`${comment}\tversion:2.100.2`)).toBe("signed_version");
    expect(wrong("timestamp:1\tfile:OpenCodex_2.100.2_x64_en-US.msi")).toBe("signed_target");
    expect(wrong("timestamp:1\tfile:OpenCodex_2.100.3_arm64_en-US.msi")).toBe("signed_target");
    expect(wrong("timestamp:1\tfile:OpenCodex_2.100.3_x64-setup.exe")).toBe("signed_target");
    expect(wrong("timestamp:1\tfile:OpenCodex.app.tar.gz")).toBe("signed_target");
    expect(wrong("timestamp:1")).toBe("signed_target");
  });

  test("a correctly signed file that is not an MSI never reaches msiexec", () => {
    const script = Buffer.from("@echo off");
    expect(code(() => verifyDesktopInstaller(script, candidate(signer.signBytes(script, comment)), signer.pubkey))).toBe("not_msi");
  });

  test("a prerelease is signed under its full version name, never its numeric core or another version", () => {
    const pre = "2.101.0-preview.1";
    const sig = (file: string) => signer.signBytes(MSI, `timestamp:1\tfile:${file}`);
    // The release signs the full name, as published for v2.99.0-preview.20261108.
    expect(code(() => verifyDesktopInstaller(MSI, candidate(sig("OpenCodex_2.101.0-preview.1_x64_en-US.msi"), pre), signer.pubkey))).toBe("accepted");
    expect(code(() => verifyDesktopInstaller(MSI, candidate(sig("OpenCodex_2.101.0_x64_en-US.msi"), pre), signer.pubkey))).toBe("signed_target");
    expect(code(() => verifyDesktopInstaller(MSI, candidate(sig("OpenCodex_2.101.1_x64_en-US.msi"), pre), signer.pubkey))).toBe("signed_target");
  });
});

test("only a newer published version is installed", () => {
  expect(compareToInstalled("2.100.2", "2.100.3")).toBe("newer");
  expect(compareToInstalled("2.100.3", "2.100.3")).toBe("same");
  expect(compareToInstalled("2.100.3", "2.100.2")).toBe("older");
  expect(compareToInstalled("2.101.0-preview.1", "2.100.3")).toBe("older");
  expect(compareToInstalled("unknown", "2.100.3")).toBe("unknown");
});
