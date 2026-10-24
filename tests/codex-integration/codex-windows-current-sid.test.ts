import { expect, test } from "bun:test";
import { win32 } from "node:path";

import {
  CodexUserIdentityRefusal,
  resolveEffectiveUserIdentity,
  resolveWindowsSidForTests,
} from "../../src/codex/user-identity";
import {
  readWindowsCurrentSid,
  resolveWindowsCurrentSid,
  type WindowsTokenSidApi,
} from "../../src/codex/windows-current-sid";
import { resolveTrustedWindowsSystemDirectory } from "../../src/lib/windows-elevation";

const TOKEN = 0x1a4n;
const SID_ADDRESS = 8192;
const STRING_ADDRESS = 4096;

/** advapi32/kernel32 as the native path calls them, with every release recorded. */
function tokenFixture(sid = "s-1-5-21-1004336348-1177238915-682003330-1001") {
  const freed: number[] = [];
  const closed: bigint[] = [];
  const api: WindowsTokenSidApi = {
    openProcessToken(access, token) {
      expect(access).toBe(0x0008);
      expect(token[0]).toBe(0n);
      token[0] = TOKEN;
      return 1;
    },
    getTokenInformation(token, informationClass, buffer, returnLength) {
      expect(token).toBe(TOKEN);
      expect(informationClass).toBe(1);
      expect(buffer.byteLength).toBe(256);
      new DataView(buffer.buffer).setBigUint64(0, BigInt(SID_ADDRESS), true);
      returnLength[0] = 44;
      return 1;
    },
    convertSidToStringSid(sidAddress, output) {
      expect(sidAddress).toBe(SID_ADDRESS);
      output[0] = BigInt(STRING_ADDRESS);
      return 1;
    },
    readCodeUnit(address, offset) {
      expect(address).toBe(STRING_ADDRESS);
      return sid.charCodeAt(offset / 2) || 0;
    },
    localFree(address) { freed.push(address); },
    closeHandle(token) { closed.push(token); },
  };
  return { api, freed, closed };
}

/** The helper's own refusal, as `powershellValue` raises it when the child hits its budget. */
function timedOutHelper(counter: { calls: number }): () => never {
  return () => {
    counter.calls += 1;
    throw new CodexUserIdentityRefusal("Windows effective-account lookup timed out.");
  };
}

test("the native token SID never starts the helper that timed out under a cold PowerShell (#7544)", () => {
  const fixture = tokenFixture();
  const helper = { calls: 0 };
  // Native unavailable: the helper's timeout still refuses, unchanged.
  expect(() => resolveWindowsSidForTests(timedOutHelper(helper), null))
    .toThrow(new CodexUserIdentityRefusal("Windows effective-account lookup timed out."));
  expect(helper.calls).toBe(1);
  // Native available: no helper call, so no deadline exists to breach.
  expect(resolveWindowsSidForTests(timedOutHelper(helper), () => readWindowsCurrentSid(fixture.api)))
    .toBe("S-1-5-21-1004336348-1177238915-682003330-1001");
  expect(helper.calls).toBe(1);
  expect(fixture.freed).toEqual([STRING_ADDRESS]);
  expect(fixture.closed).toEqual([TOKEN]);
});

test("each native failure refuses without falling back to the helper and releases what it acquired", () => {
  const cases: Array<{
    name: string;
    breakApi: (api: WindowsTokenSidApi) => void;
    message: string;
    freed: number[];
    closed: bigint[];
  }> = [
    {
      name: "OpenProcessToken fails",
      breakApi: api => { api.openProcessToken = () => 0; },
      message: "could not open the process token",
      freed: [],
      closed: [],
    },
    {
      name: "GetTokenInformation fails",
      breakApi: api => { api.getTokenInformation = () => 0; },
      message: "could not read the token user",
      freed: [],
      closed: [TOKEN],
    },
    {
      name: "the reported TOKEN_USER length overruns the buffer",
      breakApi: api => {
        api.getTokenInformation = (_token, _class, _buffer, returnLength) => {
          returnLength[0] = 257;
          return 1;
        };
      },
      message: "malformed token user",
      freed: [],
      closed: [TOKEN],
    },
    {
      name: "the SID pointer is null",
      breakApi: api => {
        api.getTokenInformation = (_token, _class, _buffer, returnLength) => {
          returnLength[0] = 44;
          return 1;
        };
      },
      message: "returned a null SID",
      freed: [],
      closed: [TOKEN],
    },
    {
      name: "ConvertSidToStringSidW fails",
      breakApi: api => { api.convertSidToStringSid = () => 0; },
      message: "could not format the SID",
      freed: [],
      closed: [TOKEN],
    },
  ];
  for (const entry of cases) {
    const fixture = tokenFixture();
    entry.breakApi(fixture.api);
    const helper = { calls: 0 };
    let thrown: unknown;
    try {
      resolveWindowsSidForTests(
        () => { helper.calls += 1; return "S-1-5-21-1-2-3-500"; },
        () => readWindowsCurrentSid(fixture.api),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown, entry.name).toBeInstanceOf(CodexUserIdentityRefusal);
    expect((thrown as Error).message, entry.name).toBe("Windows effective-account lookup failed.");
    expect(String((thrown as Error).cause), entry.name).toContain(entry.message);
    expect(helper.calls, entry.name).toBe(0);
    expect(fixture.freed, entry.name).toEqual(entry.freed);
    expect(fixture.closed, entry.name).toEqual(entry.closed);
  }
});

test("a malformed or unterminated SID string refuses and still frees it and closes the token", () => {
  const invalid = tokenFixture("S-1-");
  expect(() => readWindowsCurrentSid(invalid.api)).toThrow("returned an invalid SID");
  expect(invalid.freed).toEqual([STRING_ADDRESS]);
  expect(invalid.closed).toEqual([TOKEN]);

  const unterminated = tokenFixture();
  unterminated.api.readCodeUnit = () => 0x31;
  expect(() => readWindowsCurrentSid(unterminated.api)).toThrow("unterminated SID");
  expect(unterminated.freed).toEqual([STRING_ADDRESS]);
  expect(unterminated.closed).toEqual([TOKEN]);

  const broken = tokenFixture();
  broken.api.readCodeUnit = () => { throw new Error("read failed"); };
  expect(() => readWindowsCurrentSid(broken.api)).toThrow("read failed");
  expect(broken.freed).toEqual([STRING_ADDRESS]);
  expect(broken.closed).toEqual([TOKEN]);
});

test("the SID string read is bounded", () => {
  const fixture = tokenFixture();
  let reads = 0;
  fixture.api.readCodeUnit = () => { reads += 1; return 0x31; };
  expect(() => readWindowsCurrentSid(fixture.api)).toThrow("unterminated SID");
  expect(reads).toBe(256);
});

test.if(process.platform === "win32" && process.arch === "x64")(
  "Windows x64 reads the real token SID in-process, matching whoami, without the helper",
  () => {
    const whoami = Bun.spawnSync(
      [win32.join(resolveTrustedWindowsSystemDirectory(), "whoami.exe"), "/user", "/fo", "csv", "/nh"],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
    );
    expect(whoami.exitCode).toBe(0);
    // The account-name column is in the OEM code page; the SID column is ASCII.
    const expected = /"(S-1-(?:\d+-)+\d+)"\s*$/i.exec(whoami.stdout.toString())?.[1]?.toUpperCase();
    expect(expected).toBeDefined();
    expect(resolveWindowsCurrentSid(() => { throw new Error("PowerShell must not start"); }))
      .toBe(expected!);
    const identity = resolveEffectiveUserIdentity();
    expect(identity).toEqual({ platform: "win32", sid: expected! });
  },
);
