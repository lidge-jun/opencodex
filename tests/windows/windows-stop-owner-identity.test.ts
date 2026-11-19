import { expect, test } from "bun:test";
import { readSameUserWindowsStart } from "../../src/service/windows-process-native";
import { isClientStopCommandLine, isLegacyWindowsStartCommandLine, readClientStopProcessStart } from "../../src/client/stop-teardown-owner";

const fileTime = 133_000_000_000_000_007n;
const ticks = 637_911_232_000_000_000n;
const sid = "S-1-5-21-100-200-300-1001";

function nativeRead(overrides: Partial<Parameters<typeof readSameUserWindowsStart>[1]> = {}) {
  const handles: Array<number | bigint> = [], closed: Array<number | bigint> = [];
  const result = readSameUserWindowsStart(42, {
    open: pid => { expect(pid).toBe(42); return 101n; },
    close: handle => { closed.push(handle); },
    fileTime: handle => { handles.push(handle); return fileTime; },
    exited: handle => { handles.push(handle); return false; },
    ownerSid: handle => { handles.push(handle); return sid; },
    currentSid: () => sid,
    ...overrides,
  });
  return { result, handles, closed };
}

test("Windows stop creation and same-user evidence use one live handle and preserve protocol precision", () => {
  const result = nativeRead();
  expect(result.result).toBe(ticks);
  expect(result.handles).toEqual([101n, 101n, 101n, 101n]);
  expect(result.closed).toEqual([101n]);
});

test("Windows stop owner evidence fails closed and closes every opened handle", () => {
  for (const overrides of [
    { fileTime: () => null },
    { exited: () => true },
    { exited: () => null },
    { ownerSid: () => "S-1-5-21-100-200-300-1002" },
    { ownerSid: () => "", currentSid: () => "" },
    { ownerSid: () => { throw new Error("access denied"); } },
    { currentSid: () => { throw new Error("token unreadable"); } },
  ]) {
    const result = nativeRead(overrides);
    expect(result.result).toBeNull();
    expect(result.closed).toEqual([101n]);
  }
  expect(nativeRead({ open: () => 0 }).closed).toEqual([]);
  let reads = 0;
  expect(nativeRead({ exited: () => ++reads === 1 ? false : true }).result).toBeNull();
});

test("a reused PID gets a fresh handle and cannot inherit a prior creation proof", () => {
  let opens = 0;
  const io = {
    open: () => ++opens,
    close: () => {},
    fileTime: (handle: number | bigint) => fileTime + BigInt(handle) * 10n,
    exited: () => false,
    ownerSid: () => sid,
    currentSid: () => sid,
  };
  expect(readSameUserWindowsStart(42, io)).toBe(ticks + 10n);
  expect(readSameUserWindowsStart(42, io)).toBe(ticks + 20n);
  for (const pid of [0, -1, 1.5, 0x80000000]) expect(readSameUserWindowsStart(pid, io)).toBeNull();
  expect(opens).toBe(2);
});

test("Windows stop and legacy start recognize apostrophes without shell quoting", () => {
  for (const command of [
    "C:\\Users\\O'Neil\\ocx.exe stop",
    '"C:\\Users\\O\'Neil\\Program Files\\ocx.exe" stop --json',
    'bun.exe "C:\\Users\\O\'Neil\\app\\src\\cli\\index.ts" stop --deadline-ms 5000',
    '"C:\\Program Files\\ocx.exe"\tstop\t--json',
  ]) expect(isClientStopCommandLine(command), command).toBe(true);
  expect(isLegacyWindowsStartCommandLine("C:\\Users\\O'Neil\\ocx.exe start")).toBe(true);
  expect(isLegacyWindowsStartCommandLine('bun.exe "C:\\Users\\O\'Neil\\app\\src\\cli.ts" start')).toBe(true);
  for (const command of [
    "'C:\\Program Files\\ocx.exe' stop", "ocx.exe 'stop'", 'ocx.exe "stop --json"',
    'ocx.exe "st\\"op"', 'ocx.exe "st""op"', 'ocx.exe stop\0 --json', "ocx.exe start stop",
  ]) expect(isClientStopCommandLine(command), command).toBe(false);
});

test("Windows stop approval preserves quoted backslashes and embedded quote boundaries", () => {
  const approved = 'ocx.exe stop --json --expect-pid 12 --expect-port 10100 --expect-hostname 127.0.0.1 '
    + '--expect-config-home "C:\\Users\\O\'Neil\\Home Folder\\\\" --expect-cli-version 1.0.0 '
    + '--expect-compatibility-token ' + "a".repeat(64);
  expect(isClientStopCommandLine(approved)).toBe(true);
  expect(isClientStopCommandLine(approved.replace('Home Folder\\\\"', 'Home Folder\\"'))).toBe(false);
});

test.skipIf(process.platform !== "win32" || process.arch !== "x64")("Windows repeated stop proofs stay in-process and within the fixture budget", () => {
  const expected = readClientStopProcessStart(process.pid);
  expect(expected).toMatch(/^win32:\d+$/);
  const started = performance.now();
  for (let attempt = 0; attempt < 30; attempt++) expect(readClientStopProcessStart(process.pid)).toBe(expected);
  expect(performance.now() - started).toBeLessThan(3000);
});
