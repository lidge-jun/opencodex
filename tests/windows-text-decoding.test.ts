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

  test("decodes GBK zh-Hans schtasks task-not-found output under a Chinese Windows locale", () => {
    // GBK hex of the real zh-CN message: 错误: 系统找不到指定的文件。
    const gbk = Buffer.from("B4EDCEF33A20CFB5CDB3D5D2B2BBB5BDD6B8B6A8B5C4CEC4BCFEA1A3", "hex");
    expect(decodeWindowsTextBytes(gbk, { locale: "zh-CN" })).toBe("错误: 系统找不到指定的文件。");
  });

  test("decodes GBK output for the bare zh and zh-Hans locale tags", () => {
    const gbk = Buffer.from("B4EDCEF33A20CFB5CDB3D5D2B2BBB5BDD6B8B6A8B5C4CEC4BCFEA1A3", "hex");
    expect(decodeWindowsTextBytes(gbk, { locale: "zh" })).toBe("错误: 系统找不到指定的文件。");
    expect(decodeWindowsTextBytes(gbk, { locale: "zh-Hans-CN" })).toBe("错误: 系统找不到指定的文件。");
  });

  test("decodes Big5 zh-Hant schtasks-style output under a Traditional Chinese locale", () => {
    // Big5 hex of: 系統找不到指定的檔案。
    const big5 = Buffer.from("A874B2CEA7E4A4A3A8ECABFCA977AABAC0C9AED7A143", "hex");
    expect(decodeWindowsTextBytes(big5, { locale: "zh-TW" })).toBe("系統找不到指定的檔案。");
  });

  test("decodes Shift_JIS Japanese schtasks task-not-found output under a Japanese locale", () => {
    // Shift_JIS hex of: エラー: 指定されたファイルが見つかりません。
    const shiftJis = Buffer.from(
      "83478389815B3A208E7792E882B382EA82BD837483408343838B82AA8CA982C282A982E882DC82B982F18142",
      "hex",
    );
    expect(decodeWindowsTextBytes(shiftJis, { locale: "ja-JP" })).toBe(
      "エラー: 指定されたファイルが見つかりません。",
    );
  });

  test("does not guess Windows-1252 for a legacy-codepage locale outside the paired table", () => {
    // CP1251 bytes (Cyrillic) with no ru mapping: fail back to UTF-8 mojibake
    // rather than fabricating a different valid-looking value.
    const cp1251 = Buffer.from([0xd0, 0xd1]);
    expect(decodeWindowsTextBytes(cp1251, { locale: "ru-RU" })).toContain("\uFFFD");
  });

  test("does not reinterpret zh-Hant bytes as GBK under a Traditional Chinese locale", () => {
    const big5 = Buffer.from("A874B2CEA7E4A4A3A8ECABFCA977AABAC0C9AED7A143", "hex");
    expect(decodeWindowsTextBytes(big5, { locale: "zh-TW" })).toBe("系統找不到指定的檔案。");
    expect(decodeWindowsTextBytes(big5, { locale: "zh-CN" })).not.toBe("系統找不到指定的檔案。");
  });

  test("preserves UTF-16LE task XML", () => {
    const xml = '<?xml version="1.0" encoding="UTF-16"?><Arguments>C:\\Users\\한글</Arguments>';
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]);
    expect(decodeWindowsTextBytes(bytes, { locale: "ko-KR" })).toBe(xml);
  });
});
