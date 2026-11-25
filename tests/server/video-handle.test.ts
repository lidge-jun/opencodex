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

test("another principal, an edited payload, a foreign key and malformed input do not open", () => {
  const handle = sealVideoHandle(claims, "key:alice");
  expect(openVideoHandle(handle, "key:bob")).toBeUndefined();
  expect(openVideoHandle(handle, "loopback")).toBeUndefined();
  const [payload, tag] = handle.slice("video_ocx_".length).split(".");
  const forged = Buffer.from(JSON.stringify({ v: 1, p: "other-row", u: "video_68d7" })).toString("base64url");
  expect(openVideoHandle(`video_ocx_${forged}.${tag}`, "key:alice")).toBeUndefined();
  for (const bad of ["", "video_68d7", `video_ocx_${payload}`, `video_ocx_${payload}.${tag}.x`, "video_ocx_" + "a".repeat(5000)]) {
    expect(openVideoHandle(bad, "key:alice")).toBeUndefined();
  }
  setVideoHandleKeyForTests(Buffer.alloc(32, 1));
  expect(openVideoHandle(handle, "key:alice")).toBeUndefined();
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
  const second = sealVideoHandle(claims, "key:alice");
  expect(second).toBe(first);
  expect(readdirSync(home).filter(name => name.endsWith(".tmp"))).toEqual([]);
});

test("an unusable key file fails closed instead of minting a process-local key", () => {
  writeFileSync(join(home, VIDEO_HANDLE_KEY_FILE), "not-a-key\n", { mode: 0o600 });
  expect(() => sealVideoHandle(claims, "key:alice")).toThrow("video handle key is unavailable");
});
