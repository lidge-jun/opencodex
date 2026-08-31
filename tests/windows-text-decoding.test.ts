import { describe, expect, test } from "bun:test";

import { decodeWindowsTextBytes } from "../src/lib/windows-text";

describe("Windows system text decoding (#1573)", () => {
  test("preserves strict UTF-8 before considering a legacy code page", () => {
    const path = "C:\\Users\\한글\\.opencodex";
    expect(decodeWindowsTextBytes(Buffer.from(path, "utf8"), { locale: "ko-KR" })).toBe(path);
  });

  test("decodes CP949 Korean profile paths under a Korean Windows locale", () => {
    const cp949 = Buffer.from("433a5c55736572735cc7d1b1db", "hex");
    expect(decodeWindowsTextBytes(cp949, { locale: "ko-KR" })).toBe("C:\\Users\\한글");
  });

  test("decodes Windows-1252 Western profile paths without Korean reinterpretation", () => {
    const windows1252 = Buffer.from("433a5c55736572735c4af67267", "hex");
    expect(decodeWindowsTextBytes(windows1252, { locale: "de-DE" })).toBe("C:\\Users\\Jörg");
  });

  /*
   * #2914 narrowed this case rather than deleting it. The invariant is "never
   * guess a code page for a locale we have not named" — it was demonstrated with
   * CP932 only because ja was unnamed at the time. ja now has its real page, so
   * the demonstration moves to a locale that is still unnamed; asserting the old
   * expectation would now be asserting that Japanese output must stay broken.
   */
  test("does not guess Windows-1252 for an unsupported legacy-codepage locale", () => {
    // CP1251 Cyrillic. Reading these as Windows-1252 would yield a plausible
    // but wrong string, which is the failure this refusal exists to prevent.
    const cp1251 = Buffer.from([0xd0, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
    expect(decodeWindowsTextBytes(cp1251, { locale: "ru-RU" })).toContain("\uFFFD");
  });

  test("decodes CP932 Japanese output under a Japanese Windows locale", () => {
    const cp932 = Buffer.from([0x82, 0xa0]);
    expect(decodeWindowsTextBytes(cp932, { locale: "ja-JP" })).toBe("あ");
  });

  /*
   * The exact bytes `schtasks /query /tn opencodex-proxy /xml` writes to stderr on
   * a zh-CN host (#2914). Before this, they fell through to a lossy UTF-8 decode
   * and every localized not-found message became unmatchable mojibake.
   */
  test("decodes CP936 schtasks output under a Simplified Chinese locale", () => {
    const gbk = Buffer.from("b4edcef33a20cfb5cdb3d5d2b2bbb5bdd6b8b6a8b5c4cec4bcfea1a3", "hex");
    const decoded = decodeWindowsTextBytes(gbk, { locale: "zh-CN" });
    expect(decoded).not.toContain("\uFFFD");
    expect(decoded).toBe("错误: 系统找不到指定的文件。");
  });

  test("decodes the full CP932 schtasks refusal, not just one kana", () => {
    const cp932 = Buffer.from(
      "83478389815b3a208e7792e882b382ea82bd837483408343838b82aa8ca982c282a982e882dc82b982f18142",
      "hex",
    );
    expect(decodeWindowsTextBytes(cp932, { locale: "ja-JP" }))
      .toBe("エラー: 指定されたファイルが見つかりません。");
  });

  test("uses Big5 for Traditional Chinese regions instead of the mainland page", () => {
    // Same abstract message, Big5 bytes: 找不到
    const big5 = Buffer.from("a7e4a4a3a8ec", "hex");
    expect(decodeWindowsTextBytes(big5, { locale: "zh-TW" })).toBe("找不到");
    // The mainland default must NOT be applied to a Big5 region.
    expect(decodeWindowsTextBytes(big5, { locale: "zh-CN" })).not.toBe("找不到");
  });

  test("preserves UTF-16LE task XML", () => {
    const xml = '<?xml version="1.0" encoding="UTF-16"?><Arguments>C:\\Users\\한글</Arguments>';
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]);
    expect(decodeWindowsTextBytes(bytes, { locale: "ko-KR" })).toBe(xml);
  });
});
