import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { repoPath } from "../helpers/repo-root";
import { generateUpdateTrustRoot } from "../../scripts/generate-update-trust-root";
import { decodePublicKey } from "../../src/update/minisign.mjs";
import { EMBEDDED_ROOT_SHA256 } from "../../src/update/update-trust-anchor.mjs";

describe("generated update trust root", () => {
  test("uses the pinned updater public key and generates identical resource bytes", () => {
    const config = JSON.parse(readFileSync(repoPath("desktop/src-tauri/tauri.conf.json"), "utf8"));
    const generated = generateUpdateTrustRoot(config);
    const root = JSON.parse(generated);
    const publicBox: string = config.plugins.updater.pubkey;
    const key = decodePublicKey(Buffer.from(publicBox, "base64").toString("utf8"));
    expect(root.schema).toBe("ocx.update.root/1");
    expect(root.revision).toBe(1);
    expect(root.rootKeys[0].keyId).toBe(key.fingerprint);
    expect(root.rootKeys[0].publicKey).toBe(publicBox);
    expect(root.releaseKeys[0].keyId).toBe(key.fingerprint);
    expect(root.channels).toEqual(["latest", "preview", "nightly"]);
    expect(readFileSync(repoPath("src/update/trust-root.json"), "utf8")).toBe(generated);
    expect(readFileSync(repoPath("desktop/src-tauri/update-trust-root.json"), "utf8")).toBe(generated);
    expect(EMBEDDED_ROOT_SHA256).toBe(createHash("sha256").update(generated).digest("hex"));
  });

  test("rejects absent, malformed and noncanonical public keys", () => {
    expect(() => generateUpdateTrustRoot({})).toThrow();
    expect(() => generateUpdateTrustRoot({ plugins: { updater: { pubkey: "!" } } })).toThrow();
    expect(() => generateUpdateTrustRoot({ plugins: { updater: { pubkey: "YQ" } } })).toThrow();
  });
});
