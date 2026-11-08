// Build the repository's actual TypeScript release adapter for Node first:
// bun build tests/helpers/update-release-adapter-entry.ts --target=node --format=esm --outfile .tmp/auto-update-parity/verify-release-assets-node.mjs
// Then pass that bundle as the only argument to Node 18 and Bun. No release is published.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { decodePublicKey, verifyMinisignBytes } from "../../src/update/minisign.mjs";

assert.equal(process.argv.length, 3, "pass the built release-adapter module");
const adapter = await import(pathToFileURL(resolve(process.argv[2])).href);
const dir = mkdtempSync(join(tmpdir(), "ocx-release-adapter-"));
try {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(-32);
  const id = Buffer.alloc(8, 7);
  const publicBox = `untrusted comment: fixture\n${Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64")}\n`;
  const strictKey = decodePublicKey(publicBox), legacyKey = adapter.parseMinisignPublicKey(publicBox);
  const bytes = Buffer.from("fixture artifact"), asset = join(dir, "artifact");
  writeFileSync(asset, bytes);
  const signature = sign(null, createHash("blake2b512").update(bytes).digest(), privateKey);
  const packet = Buffer.concat([Buffer.from("ED"), id, signature]).toString("base64");
  const box = (comment, signedComment, newline) => {
    const global = sign(null, Buffer.concat([signature, Buffer.from(signedComment)]), privateKey).toString("base64");
    return Buffer.from(["untrusted comment: fixture", packet, `trusted comment: ${comment}`, global, ""].join(newline)).toString("base64");
  };
  for (const newline of ["\n", "\r\n"]) {
    const comment = "  timestamp:1\tversion:1.2.3\t";
    const exact = box(comment, comment, newline);
    writeFileSync(`${asset}.sig`, exact);
    assert.equal(verifyMinisignBytes(bytes, exact, strictKey).trustedComment, comment);
    assert.throws(() => adapter.verifyUpdaterSignature(asset, legacyKey), /Comment signature verification failed/);
    const normalized = box(comment, comment.trim(), newline);
    writeFileSync(`${asset}.sig`, normalized);
    assert.throws(() => verifyMinisignBytes(bytes, normalized, strictKey), /Comment signature verification failed/);
    assert.doesNotThrow(() => adapter.verifyUpdaterSignature(asset, legacyKey));
    const versionless = box("timestamp:1", "timestamp:1", newline);
    writeFileSync(`${asset}.sig`, versionless);
    assert.doesNotThrow(() => adapter.verifyUpdaterSignature(asset, legacyKey));
    assert.equal(verifyMinisignBytes(bytes, versionless, strictKey).trustedComment, "timestamp:1");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`Release adapter harness passed on ${globalThis.Bun ? `Bun ${globalThis.Bun.version}` : `Node ${process.versions.node}`}`);
