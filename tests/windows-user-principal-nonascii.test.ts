import { afterEach, describe, expect, test } from "bun:test";

import {
  cachedCurrentWindowsIdentity,
  resetWindowsPrincipalForTests,
  resolveCurrentWindowsPrincipal,
  resolveCurrentWindowsPrincipalAsync,
  setAsyncWindowsPrincipalRunnerForTests,
  setWindowsPrincipalLocaleForTests,
  setWindowsPrincipalRunnerForTests,
} from "../src/lib/windows-user-principal";

/**
 * The identity lookup shells out to `powershell.exe` and reads its stdout. Windows
 * PowerShell 5.1 writes the console OUTPUT CODE PAGE, not UTF-8, so decoding those
 * bytes with a bare `Buffer.toString()` turns any non-ASCII account name into U+FFFD
 * and freezes the corruption into the process identity cache.
 *
 * The SID on the first line is ASCII by construction and survives either way, which is
 * exactly why this went unnoticed: the failure is invisible until something compares
 * the NAME - a legacy scheduler task whose <UserId> is name-form, or the ACL check in
 * windows-secret-acl.ts.
 *
 * Each case pins its own locale. decodeWindowsTextBytes selects one legacy encoding
 * from the ambient locale, so the CP949, CP932 and CP936 fixtures are mutually
 * exclusive in a single process unless the locale is stated per case.
 */

const SID = "S-1-5-21-111-222-333-1001";

/** Encode `text` in a legacy Windows code page the way the console would emit it. */
function legacyBytes(text: string, encoding: string): Uint8Array {
  // Bun ships full ICU, so these decoders exist; the encode side does not, so the
  // fixtures are built from a decode round-trip of known byte sequences below.
  throw new Error(`unused placeholder for ${text} / ${encoding}`);
}
void legacyBytes;

/**
 * Byte fixtures, written out rather than generated: TextEncoder only emits UTF-8, so a
 * legacy-code-page fixture has to be literal bytes or it is not testing the decode.
 */
const CP949_HANGUL = Uint8Array.from([
  0xb1, 0xe8, 0xba, 0xb4, 0xc1, 0xd8, // "김병준" in CP949
]);
const CP932_KANA = Uint8Array.from([
  0x83, 0x65, 0x83, 0x58, 0x83, 0x67, // "テスト" in CP932
]);
const CP936_HANZI = Uint8Array.from([
  0xd5, 0xc5, 0xc8, 0xfd, // "张三" in CP936
]);

function stdoutBytes(nameBytes: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(`${SID}\r\nMACHINE\\`);
  const suffix = new TextEncoder().encode("\r\n");
  const out = new Uint8Array(prefix.length + nameBytes.length + suffix.length);
  out.set(prefix, 0);
  out.set(nameBytes, prefix.length);
  out.set(suffix, prefix.length + nameBytes.length);
  return out;
}

const okBytes = (nameBytes: Uint8Array) => ({
  success: true,
  exitCode: 0,
  timedOut: false,
  stdout: stdoutBytes(nameBytes),
});

afterEach(() => {
  setWindowsPrincipalRunnerForTests(null);
  setAsyncWindowsPrincipalRunnerForTests(null);
  setWindowsPrincipalLocaleForTests(null);
  resetWindowsPrincipalForTests();
});

describe("Windows principal decoding of non-ASCII account names", () => {
  for (const c of [
    { label: "CP949 (ko-KR)", locale: "ko-KR", bytes: CP949_HANGUL, expected: "김병준" },
    { label: "CP932 (ja-JP)", locale: "ja-JP", bytes: CP932_KANA, expected: "テスト" },
    { label: "CP936 (zh-CN)", locale: "zh-CN", bytes: CP936_HANZI, expected: "张三" },
  ]) {
    test(`${c.label} account name survives the lookup`, () => {
      setWindowsPrincipalLocaleForTests(c.locale);
      setWindowsPrincipalRunnerForTests(() => okBytes(c.bytes));

      expect(resolveCurrentWindowsPrincipal(5000)).toBe(`*${SID}`);
      const identity = cachedCurrentWindowsIdentity();
      expect(identity?.name).toBe(`MACHINE\\${c.expected}`);
      // The replacement character is the exact symptom of the UTF-8 misread.
      expect(identity?.name).not.toContain("\uFFFD");
    });
  }

  test("a UTF-8 host is unaffected under every pinned locale", () => {
    const utf8 = new TextEncoder().encode("김병준");
    for (const locale of ["ko-KR", "ja-JP", "zh-CN", "en-US"]) {
      setWindowsPrincipalLocaleForTests(locale);
      setWindowsPrincipalRunnerForTests(() => okBytes(utf8));
      expect(cachedCurrentWindowsIdentity()).toBeNull();
      resolveCurrentWindowsPrincipal(5000);
      expect(cachedCurrentWindowsIdentity()?.name).toBe("MACHINE\\김병준");
    }
  });

  test("an ASCII account name is byte-identical before and after", () => {
    setWindowsPrincipalLocaleForTests("ko-KR");
    setWindowsPrincipalRunnerForTests(() => okBytes(new TextEncoder().encode("Owner")));
    resolveCurrentWindowsPrincipal(5000);
    expect(cachedCurrentWindowsIdentity()?.name).toBe("MACHINE\\Owner");
  });

  test("a string-returning runner still works, so the widened type stays compatible", () => {
    setWindowsPrincipalRunnerForTests(() => ({
      success: true,
      exitCode: 0,
      timedOut: false,
      stdout: `${SID}\r\nEXAMPLE\\Owner\r\n`,
    }));
    expect(resolveCurrentWindowsPrincipal(5000)).toBe(`*${SID}`);
    expect(cachedCurrentWindowsIdentity()?.name).toBe("EXAMPLE\\Owner");
  });

  test("the async path decodes the same way", async () => {
    setWindowsPrincipalLocaleForTests("ko-KR");
    setAsyncWindowsPrincipalRunnerForTests(async () => okBytes(CP949_HANGUL));
    expect(await resolveCurrentWindowsPrincipalAsync(5000)).toBe(`*${SID}`);
    expect(cachedCurrentWindowsIdentity()?.name).toBe("MACHINE\\김병준");
  });

  test("a failed lookup still throws EACLIDENTITY rather than decoding garbage", () => {
    setWindowsPrincipalRunnerForTests(() => ({
      success: false,
      exitCode: 1,
      timedOut: false,
      stdout: new Uint8Array([0xff, 0xfe, 0xfd]),
    }));
    expect(() => resolveCurrentWindowsPrincipal(5000)).toThrow(/SID lookup/);
  });

  test("changing the locale invalidates the cached identity", () => {
    setWindowsPrincipalLocaleForTests("ko-KR");
    setWindowsPrincipalRunnerForTests(() => okBytes(CP949_HANGUL));
    resolveCurrentWindowsPrincipal(5000);
    expect(cachedCurrentWindowsIdentity()?.name).toBe("MACHINE\\김병준");

    // Without the cache clear this would keep reporting the previous decode.
    setWindowsPrincipalLocaleForTests("ja-JP");
    expect(cachedCurrentWindowsIdentity()).toBeNull();
  });
});

