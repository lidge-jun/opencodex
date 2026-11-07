import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import { dirname } from "node:path";
import { createTempHome, type TempHome } from "../helpers/temp-home";

// Install the fs wrapper before importing either publisher or rename helper.
const native = { ...fs };
const descriptors = new Map<number, string>();
let target = "";
let failure: "temp" | "directory" | null = null;
let events: string[] = [];
mock.module("node:fs", () => ({
  ...native,
  openSync: (...args: Parameters<typeof fs.openSync>) => {
    const descriptor = native.openSync(...args);
    descriptors.set(descriptor, String(args[0])); return descriptor;
  },
  closeSync: (descriptor: number) => { descriptors.delete(descriptor); native.closeSync(descriptor); },
  fsyncSync: (descriptor: number) => {
    const path = descriptors.get(descriptor) ?? "";
    const stage = path.startsWith(target + ".ocx.") ? "temp" : path === dirname(target) ? "directory" : null;
    if (stage) events.push("fsync:" + stage);
    if (stage && failure === stage) throw new Error("fixture fsync failure");
    native.fsyncSync(descriptor);
  },
  renameSync: (source: fs.PathLike, destination: fs.PathLike) => {
    if (String(destination) === target) events.push("rename");
    native.renameSync(source, destination);
  },
}));
const { atomicWriteFileNoFollowStreamed } = await import("../../src/config/atomic-write");
let home: TempHome;
beforeEach(() => {
  home = createTempHome("ocx-nofollow-streamed-");
  target = home.path("dashboard-sessions.json"); failure = null; events = [];
  native.writeFileSync(target, "previous");
});
afterEach(() => { failure = null; home.remove(); });
afterAll(() => { mock.restore(); });
function publish() {
  atomicWriteFileNoFollowStreamed(target, descriptor => native.writeFileSync(descriptor, "replacement"));
}

test("content fsync precedes publication, followed by best-effort directory fsync", () => {
  publish();
  expect(native.readFileSync(target, "utf8")).toBe("replacement");
  expect(events).toEqual(process.platform === "win32" ? ["fsync:temp", "rename"] : ["fsync:temp", "rename", "fsync:directory"]);
});

test("temp fsync failure prevents rename and removes the unpublished temporary file", () => {
  failure = "temp";
  expect(publish).toThrow("fixture fsync failure");
  expect(events).toEqual(["fsync:temp"]);
  expect(native.readFileSync(target, "utf8")).toBe("previous");
  expect(native.readdirSync(home.root).filter(name => name.includes(".ocx.") && name.endsWith(".tmp"))).toEqual([]);
});

test.skipIf(process.platform === "win32")("directory fsync failure still reports a successful publication", () => {
  failure = "directory"; publish();
  expect(events).toEqual(["fsync:temp", "rename", "fsync:directory"]);
  expect(native.readFileSync(target, "utf8")).toBe("replacement");
});

test.skipIf(process.platform === "win32")("a symlinked final entry is replaced without following its target", () => {
  const other = home.path("other.json"); native.writeFileSync(other, "untouched");
  native.unlinkSync(target); native.symlinkSync(other, target);
  publish();
  expect(native.lstatSync(target).isSymbolicLink()).toBe(false);
  expect(native.readFileSync(target, "utf8")).toBe("replacement");
  expect(native.readFileSync(other, "utf8")).toBe("untouched");
});
