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

  test("does not guess Windows-1252 for an unsupported legacy-codepage locale", () => {
    const cp932 = Buffer.from([0x82, 0xa0]);
    expect(decodeWindowsTextBytes(cp932, { locale: "ja-JP" })).toContain("\uFFFD");
  });

  test("preserves UTF-16LE task XML", () => {
    const xml = '<?xml version="1.0" encoding="UTF-16"?><Arguments>C:\\Users\\한글</Arguments>';
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]);
    expect(decodeWindowsTextBytes(bytes, { locale: "ko-KR" })).toBe(xml);
  });
});
