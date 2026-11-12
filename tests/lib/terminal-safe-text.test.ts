/**
 * `terminalSafeText` is the boundary that turns a provider- or hub-supplied value into something
 * safe to print. C0/C1 escaping was already there; the review found the rest of the invisible
 * formatting block still reachable, so these cases pin the whole set and, just as important, pin
 * what must survive it: real script, real emoji sequences and structured output bytes.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { terminalSafeText } from "../../src/lib/terminal-safe-text";
import { repoPath } from "../helpers/repo-root";

const codePoints = (value: string): number[] => [...value].map(character => character.codePointAt(0)!);

describe("terminalSafeText", () => {
  test("C0, DEL and C1 stay escaped exactly as before", () => {
    expect(terminalSafeText("a\u0000b")).toBe("a\\x00b");
    expect(terminalSafeText("a\u001bb[31mb")).toBe("a\\x1bb[31mb");
    expect(terminalSafeText("a\u007fb")).toBe("a\\x7fb");
    expect(terminalSafeText("a\u009db")).toBe("a\\u009db");
  });

  // Each of these reads as nothing and can reorder or hide the rest of the line. Escaping is the
  // contract: dropping them would also work on a tty, but silently changes a value that a log or
  // a pasted bug report is supposed to reproduce.
  const invisible = [
    ["right-to-left override", 0x202e],
    ["pop directional formatting", 0x202c],
    ["left-to-right embedding", 0x202a],
    ["left-to-right override", 0x202d],
    ["right-to-left embedding", 0x202b],
    ["first strong isolate", 0x2068],
    ["left-to-right isolate", 0x2066],
    ["right-to-left isolate", 0x2067],
    ["pop directional isolate", 0x2069],
    ["word joiner", 0x2060],
    ["invisible plus", 0x2064],
    ["invisible separator", 0x2063],
    ["zero-width space", 0x200b],
    ["left-to-right mark", 0x200e],
    ["right-to-left mark", 0x200f],
    ["arabic letter mark", 0x061c],
    ["zero-width no-break space", 0xfeff],
    ["line separator", 0x2028],
    ["paragraph separator", 0x2029],
  ] as const;

  test.each(invisible.map(([name, code]) => [name, code, code.toString(16).padStart(4, "0").toUpperCase()] as const))(
    "escapes the %s (U+%s) rather than printing it",
    (_name, code) => {
      const character = String.fromCodePoint(code);
      const escaped = `\\u${code.toString(16).padStart(4, "0")}`;
      expect(terminalSafeText(`left${character}right`)).toBe(`left${escaped}right`);
      expect(codePoints(terminalSafeText(`left${character}right`))).not.toContain(code);
    },
  );

  test("a bidi override cannot reorder the text around it", () => {
    // The attack the review named: an override swaps how the rest of the line reads, so a
    // provider-supplied instruction can claim a different URL or code than the one it prints.
    const hostile = "\u202ehttps://evil.example\u202c https://accounts.x.ai/oauth2/device";
    const rendered = terminalSafeText(hostile);
    expect(rendered).toBe("\\u202ehttps://evil.example\\u202c https://accounts.x.ai/oauth2/device");
    expect(rendered.indexOf("evil")).toBeLessThan(rendered.indexOf("accounts.x.ai"));
  });

  test("legitimate script, shaping and emoji sequences are untouched", () => {
    for (const value of [
      "한국어 안내 문구",
      "日本語のテキスト",
      "العربية: الرجاء تأكيد الرمز",
      "فارسی می‌خواهم", // ZWNJ inside a Persian word
      "हिन्दी पाठ", // Devanagari
      "e\u0301cole", // combining acute
      "👨\u200d👩\u200d👧 family", // ZWJ sequence
      "🏳️\u200d🌈 flag", // variation selector + ZWJ
      "⚡️", // emoji with variation selector
      "naïve café — ok",
    ]) {
      expect(terminalSafeText(value)).toBe(value);
    }
  });

  test("ASCII, JSON and structured literals keep their exact bytes", () => {
    const json = JSON.stringify({ url: "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH", code: "ABCD-EFGH" });
    expect(terminalSafeText(json)).toBe(json);
    expect(terminalSafeText('{"a":"b\\nc"}')).toBe('{"a":"b\\nc"}');
  });

  test("escaping is idempotent, so a value printed twice is not double-mangled", () => {
    const once = terminalSafeText("a\u202eb\u200bc");
    expect(terminalSafeText(once)).toBe(once);
  });

  test("the source spells every hidden character as an escape", () => {
    // A literal U+202E in this file would be invisible in every diff that touches it.
    const source = readFileSync(repoPath("src", "lib", "terminal-safe-text.ts"), "utf8");
    const literal = codePoints(source).filter(code =>
      (code >= 0x7f && code <= 0x9f) || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e)
      || (code >= 0x2060 && code <= 0x206f) || code === 0xfeff || code === 0x061c);
    expect(literal).toEqual([]);
  });
});
