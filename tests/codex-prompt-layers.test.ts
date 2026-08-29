/**
 * Encoding and inventory contract for src/codex/prompt-layers.ts.
 *
 * The encoding cases exist because `Bun.TOML.parse` cannot be trusted as a
 * verifier here: on Bun 1.3.14 it transposes `\t` and `\f`, rejects `\u0007`,
 * and does not trim the newline after an opening `'''`. Codex parses with Rust
 * `toml_edit`, so these assertions are deliberately BYTE-level — they check
 * what we emit, not what a JS parser makes of it.
 */
import { describe, expect, test } from "bun:test";
import {
  LAYER_INVENTORY,
  TOGGLE_IDS,
  computeRevision,
  decodeBasicString,
  encodeBasicString,
  findInvalidCharacter,
  isToggleId,
  normalizeBody,
} from "../src/codex/prompt-layers";

/** TOML basic-string grammar, hand-written so it does not share code with the encoder. */
const BASIC_STRING = /^"(?:[^"\\\u0000-\u001f]|\\["\\bfnrt]|\\u[0-9A-Fa-f]{4})*"$/;

describe("inventory", () => {
  test("every id is classified exactly once", () => {
    const ids = LAYER_INVENTORY.map(d => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every config-toggle carries a key, and the toggle set matches", () => {
    const toggles = LAYER_INVENTORY.filter(d => d.class === "config-toggle");
    for (const d of toggles) expect(d.key).not.toBeNull();
    expect(toggles.map(d => d.id).sort()).toEqual([...TOGGLE_IDS].sort());
  });

  test("only config-toggle rows are writable", () => {
    for (const d of LAYER_INVENTORY) {
      expect(isToggleId(d.id)).toBe(d.class === "config-toggle");
    }
  });

  test("plugins is runtime-conditional, not feature-gated", () => {
    // core/src/mcp.rs:200 — selected_plugin_available || !summaries.is_empty().
    // [features] plugins feeds only the right operand.
    const plugins = LAYER_INVENTORY.find(d => d.id === "plugins");
    expect(plugins?.class).toBe("runtime-conditional");
    expect(plugins?.key).toBeNull();
  });

  test("base instructions are class base and never toggleable", () => {
    const base = LAYER_INVENTORY.find(d => d.id === "base-instructions");
    expect(base?.class).toBe("base");
    expect(isToggleId("base-instructions")).toBe(false);
  });

  test("git-attribution is runtime-conditional with no key and no fixed order", () => {
    // The layer ext/git-attribution contributes. Its shape is the whole assertion:
    // `runtime-conditional` because lib.rs:33-80 resolves enablement from the auth
    // server rather than a config key (features/src/lib.rs:277 records the old flag as
    // removed), and `order: null` because it registers through
    // extensions.context_contributors(), whose position is registration-order dependent.
    //
    // Refusal at the route is NOT re-asserted here: codex-prompt-route.test.ts case 5
    // already drives the real endpoint table-driven over every non-config-toggle
    // descriptor, so a second guard would duplicate coverage rather than add it.
    const layer = LAYER_INVENTORY.find(d => d.id === "git-attribution");
    expect(layer).toBeDefined();
    expect(layer?.class).toBe("runtime-conditional");
    expect(layer?.key).toBeNull();
    expect(layer?.order).toBeNull();
    expect(layer?.default).toBeNull();
    expect(isToggleId("git-attribution")).toBe(false);
  });
});

describe("normalization", () => {
  test("tab becomes four spaces", () => {
    expect(normalizeBody("a\tb")).toBe("a    b");
  });

  test("CRLF and lone CR become LF", () => {
    expect(normalizeBody("a\r\nb\rc")).toBe("a\nb\nc");
  });

  test("newlines and non-BMP text survive", () => {
    expect(normalizeBody("a\nb 😀")).toBe("a\nb 😀");
  });
});

describe("character policy", () => {
  test("accepts printable text, newlines, non-BMP and U+2028/U+2029", () => {
    // U+2028/U+2029 are not TOML line terminators and cannot end a basic string.
    expect(findInvalidCharacter("plain\nline 😀 é \u2028\u2029")).toBeNull();
  });

  test("rejects C0 controls with a code-point position", () => {
    const found = findInvalidCharacter("ab\u0007cd");
    expect(found).toEqual({ position: 2, reason: "control", codePoint: 7 });
  });

  test("rejects DEL and C1 controls", () => {
    expect(findInvalidCharacter("a\u007f")?.reason).toBe("control");
    expect(findInvalidCharacter("a\u0085")?.reason).toBe("control");
  });

  test("rejects an unpaired surrogate", () => {
    // UTF-8 encoding would replace it with U+FFFD and silently alter the prompt.
    expect(findInvalidCharacter("a\ud800b")?.reason).toBe("unpaired-surrogate");
    expect(findInvalidCharacter("a\udc00b")?.reason).toBe("unpaired-surrogate");
  });

  test("a well-formed surrogate pair is not flagged", () => {
    expect(findInvalidCharacter("😀")).toBeNull();
  });

  test("position counts code points, not UTF-16 units", () => {
    // "😀" is one code point but two UTF-16 units.
    expect(findInvalidCharacter("😀\u0007")?.position).toBe(1);
  });
});

describe("encoding", () => {
  const bodies = [
    "plain",
    'has """ triple quotes',
    "back \\ slash",
    "trailing backslash \\",
    "line1\nline2",
    "emoji 😀 and é",
    "# >>> ocx-layer:abc123",     // the retired fence text is now inert
    "'''literal'''",
    'quote " inside',
    "\\n literal backslash-n",
  ];

  for (const body of bodies) {
    test(`emits one grammar-valid line: ${JSON.stringify(body).slice(0, 32)}`, () => {
      const line = encodeBasicString(body);
      expect(line.includes("\n")).toBe(false);
      expect(BASIC_STRING.test(line)).toBe(true);
    });

    test(`round-trips through our own decoder: ${JSON.stringify(body).slice(0, 32)}`, () => {
      expect(decodeBasicString(encodeBasicString(body))).toBe(body);
    });
  }

  test("a 64 KiB body stays one line", () => {
    const line = encodeBasicString("a".repeat(65536));
    expect(line.includes("\n")).toBe(false);
    expect(line.length).toBe(65538);
  });
});

describe("decoder is deliberately narrow", () => {
  test("refuses escapes we never emit", () => {
    for (const literal of ['"a\\tb"', '"a\\fb"', '"a\\bb"', '"a\\rb"', '"a\\u00e9b"']) {
      expect(decodeBasicString(literal)).toBeNull();
    }
  });

  test("refuses unterminated or unquoted input", () => {
    expect(decodeBasicString('"abc')).toBeNull();
    expect(decodeBasicString("abc")).toBeNull();
    expect(decodeBasicString("'''abc'''")).toBeNull();
  });

  test("refuses an unescaped interior quote", () => {
    expect(decodeBasicString('"a"b"')).toBeNull();
  });
});

describe("revision", () => {
  test("absent and empty files are distinguishable", () => {
    expect(computeRevision(null, null)).not.toBe(computeRevision("", ""));
  });

  test("changes when only the marker is removed", () => {
    const withMarker = '# Auto-injected by opencodex\ndeveloper_instructions = "x"\n';
    const without = 'developer_instructions = "x"\n';
    expect(computeRevision(withMarker, "{}")).not.toBe(computeRevision(without, "{}"));
  });

  test("changes when the config is deleted", () => {
    expect(computeRevision("a", "{}")).not.toBe(computeRevision(null, "{}"));
  });

  test("is stable for identical bytes", () => {
    expect(computeRevision("a", "{}")).toBe(computeRevision("a", "{}"));
  });

  /**
   * The revision is compared in commit() to decide whether a write may proceed, and
   * it feeds the prompt probe's admission key. A collision is therefore both a
   * stale-write and a stale-read defect, so the boundary between the two files has
   * to be unforgeable by their contents.
   */
  test("config bytes cannot imitate the store field boundary", () => {
    expect(computeRevision("left", "right\nstore:tail"))
      .not.toBe(computeRevision("left\nstore:right", "tail"));
  });

  test("an absent file is not a file containing the old absence sentinel", () => {
    expect(computeRevision(null, "{}")).not.toBe(computeRevision("\u0000absent", "{}"));
    expect(computeRevision("a", null)).not.toBe(computeRevision("a", "\u0000absent"));
  });
});
