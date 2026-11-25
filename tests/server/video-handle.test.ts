import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openVideoHandle,
  sealVideoHandle,
  setVideoHandleKeyForTests,
  VIDEO_HANDLE_KEY_FILE,
  videoHandlePrincipal,
} from "../../src/server/video-handle";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home = "";
const previousHome = process.env.OPENCODEX_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-video-handle-"));
  process.env.OPENCODEX_HOME = home;
  setVideoHandleKeyForTests(undefined);
});
afterEach(() => {
  setVideoHandleKeyForTests(undefined);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (home) removeTreeWithRetry(home);
});

const claims = { provider: "aistudio", upstreamId: "video_68d7", model: "gemini-omni-1.1-flash" };

test("a handle opens for the principal that sealed it, under a key persisted with mode 0600", () => {
  const handle = sealVideoHandle(claims, "key:alice");
  expect(handle.startsWith("video_ocx_")).toBe(true);
  expect(openVideoHandle(handle, "key:alice")).toEqual(claims);
  const file = join(home, VIDEO_HANDLE_KEY_FILE);
  expect(existsSync(file)).toBe(true);
  expect(readFileSync(file, "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  // A restart re-reads the same key, so a job created before it is still reachable.
  setVideoHandleKeyForTests(undefined);
  expect(openVideoHandle(handle, "key:alice")).toEqual(claims);
});

test("another principal, any edited byte, a foreign key and malformed input do not open", () => {
  const handle = sealVideoHandle(claims, "key:alice");
  expect(openVideoHandle(handle, "key:bob")).toBeUndefined();
  expect(openVideoHandle(handle, "loopback")).toBeUndefined();
  const body = handle.slice("video_ocx_".length);
  const bytes = Buffer.from(body, "base64url");
  // Nonce, ciphertext and tag: flipping any decoded byte fails authentication.
  for (const at of [0, 11, 12, Math.floor(bytes.length / 2), bytes.length - 16, bytes.length - 1]) {
    const edited = Buffer.from(bytes);
    edited[at] = edited[at]! ^ 0x01;
    expect(openVideoHandle("video_ocx_" + edited.toString("base64url"), "key:alice")).toBeUndefined();
  }
  // A non-canonical spelling of the same bytes (set unused trailing bits) does not open either.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = body[body.length - 1]!;
  const sibling = alphabet[alphabet.indexOf(last) ^ 1]!;
  const respelled = "video_ocx_" + body.slice(0, -1) + sibling;
  // These claims seal to 95 bytes, so the last character carries two unused bits.
  expect(bytes.length % 3).toBe(2);
  expect(Buffer.from(respelled.slice("video_ocx_".length), "base64url").equals(bytes)).toBe(true);
  expect(openVideoHandle(respelled, "key:alice")).toBeUndefined();
  for (const bad of ["", "video_68d7", "video_ocx_", "video_ocx_abc", "video_ocx_" + body + ".x", "video_ocx_" + "a".repeat(9000)]) {
    expect(openVideoHandle(bad, "key:alice")).toBeUndefined();
  }
  setVideoHandleKeyForTests(Buffer.alloc(32, 1));
  expect(openVideoHandle(handle, "key:alice")).toBeUndefined();
});

test("the handle reveals neither the upstream id nor the model", () => {
  setVideoHandleKeyForTests(Buffer.alloc(32, 9));
  const secretish = { provider: "aistudio", upstreamId: "synthetic_secret_123abc", model: "synthetic_model_secret" };
  const handle = sealVideoHandle(secretish, "key:alice");
  const decoded = Buffer.from(handle.slice("video_ocx_".length), "base64url").toString("latin1");
  for (const value of [secretish.upstreamId, secretish.model, secretish.provider]) {
    expect(handle).not.toContain(value);
    expect(decoded).not.toContain(value);
  }
  expect(sealVideoHandle(secretish, "key:alice")).not.toBe(handle);
  expect(openVideoHandle(handle, "key:alice")).toEqual(secretish);
});

test("principals bind the admission kind, key id and the exact presented secret", () => {
  const bearer = (secret: string) => new Headers({ authorization: "Bearer " + secret });
  const k1 = videoHandlePrincipal({ kind: "configured", keyId: "k1", source: "bearer" }, bearer("secret-one"));
  // The same secret in the dedicated header or x-api-key is the same principal.
  expect(videoHandlePrincipal({ kind: "configured", keyId: "k1", source: "dedicated" }, new Headers({ "x-opencodex-api-key": "secret-one" }))).toBe(k1);
  expect(videoHandlePrincipal({ kind: "configured", keyId: "k1", source: "x-api-key" }, new Headers({ "x-api-key": "secret-one" }))).toBe(k1);
  expect(videoHandlePrincipal({ kind: "configured", keyId: "k1", source: "bearer" }, bearer("secret-two"))).not.toBe(k1);
  expect(videoHandlePrincipal({ kind: "configured", keyId: "k2", source: "bearer" }, bearer("secret-one"))).not.toBe(k1);
  expect(videoHandlePrincipal({ kind: "environment", source: "bearer" }, bearer("secret-one"))).not.toBe(k1);
  expect(k1).not.toContain("secret-one");
  expect(videoHandlePrincipal({ kind: "loopback", source: "loopback" }, new Headers())).toBe("loopback");
  expect(videoHandlePrincipal({ kind: "configured", keyId: "k1", source: "bearer" }, new Headers())).toBeUndefined();
});

test("the largest claims the create admits still seal into an openable handle", () => {
  setVideoHandleKeyForTests(Buffer.alloc(32, 3));
  const big = { provider: "p".repeat(128), upstreamId: "\u00e9".repeat(256), model: "m".repeat(256) };
  const handle = sealVideoHandle(big, "key:alice");
  expect(openVideoHandle(handle, "key:alice")).toEqual(big);
});

test("an existing key readable by other users, or a symlinked key, fails closed", () => {
  if (process.platform === "win32") return;
  const file = join(home, VIDEO_HANDLE_KEY_FILE);
  writeFileSync(file, "ab".repeat(32) + "\n", { mode: 0o644 });
  chmodSync(file, 0o644);
  expect(() => sealVideoHandle(claims, "key:alice")).toThrow("readable by other users");
  unlinkSync(file);
  const target = join(home, "elsewhere");
  writeFileSync(target, "ab".repeat(32) + "\n", { mode: 0o600 });
  symlinkSync(target, file);
  expect(() => sealVideoHandle(claims, "key:alice")).toThrow("symbolic link");
});

test("a later load reads the published key back and creation leaves no temporary file", () => {
  const first = sealVideoHandle(claims, "key:alice");
  setVideoHandleKeyForTests(undefined);
  expect(openVideoHandle(first, "key:alice")).toEqual(claims);
  expect(readdirSync(home).filter(name => name.endsWith(".tmp"))).toEqual([]);
});

test("an unusable key file fails closed instead of minting a process-local key", () => {
  writeFileSync(join(home, VIDEO_HANDLE_KEY_FILE), "not-a-key\n", { mode: 0o600 });
  expect(() => sealVideoHandle(claims, "key:alice")).toThrow("video handle key is unavailable");
});
