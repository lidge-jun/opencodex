import { describe, expect, test } from "bun:test";
import {
  appendOcxProviderTableBlock,
  extractOcxProviderTableBlock,
  hasOcxProviderTable,
  removeOcxSection,
} from "../../src/codex/inject/remove";

const header = "[model_providers.opencodex]\n";

describe("lossless retained provider tables", () => {
  test.each(['"""', "'''"])("different multiline contents remain a conflict (%s)", delimiter => {
    const captured = header + `name = ${delimiter}first\n\n\nlast${delimiter}\n`;
    const restored = header + `name = ${delimiter}first\n\nlast${delimiter}\n`;
    expect(extractOcxProviderTableBlock(captured)).toBe(captured);
    expect(() => appendOcxProviderTableBlock(restored, captured)).toThrow("different [model_providers.opencodex] table");
  });

  test.each(['"""', "'''"])("header-shaped data stays within the captured string (%s)", delimiter => {
    const block = header + `name = ${delimiter}first\n[foreign]\n# Auto-injected by opencodex\n\n\nlast${delimiter}\n`;
    const foreign = '[unrelated]\nvalue = "keep"\n';
    expect(extractOcxProviderTableBlock(block + foreign)).toBe(block);
    expect(removeOcxSection(block + foreign)).toBe(foreign);
    expect(appendOcxProviderTableBlock(foreign, block)).toContain(block);
  });

  test("a fake provider header inside unrelated multiline data is not captured or removed", () => {
    const content = 'instructions = """start\n[model_providers.opencodex]\nname = "fake"\nend"""\n';
    expect(hasOcxProviderTable(content)).toBe(false);
    expect(extractOcxProviderTableBlock(content)).toBeNull();
    expect(removeOcxSection(content)).toBe(content);
  });

  test("capture resumes for separated child tables without swallowing foreign content", () => {
    const root = header + 'name = "retained"\n';
    const foreign = '[other]\nnote = """a\n\n\nb"""\n';
    const child = '[model_providers.opencodex.http_headers]\n"x-fixture" = "value"\n';
    const captured = root + child;
    expect(extractOcxProviderTableBlock(root + foreign + child)).toBe(captured);
    expect(removeOcxSection(root + foreign + child)).toBe(foreign);
    expect(appendOcxProviderTableBlock(root + foreign + child, captured)).toBe(root + foreign + child);
  });

  test("cosmetic formatting and quoted table paths preserve current bytes", () => {
    const captured = header + 'name = "retained"\nflag = true\n';
    const current = '["model_providers" . \'opencodex\'] # retained\nflag=true\n\n\nname=\'retained\' # comment\n';
    expect(appendOcxProviderTableBlock(current, captured)).toBe(current);
  });

  test("capture does not parse unrelated integers outside JavaScript's safe range", () => {
    const prefix = "model_context_window = 9223372036854775807\n";
    const block = header + 'name = "retained"\n';
    expect(extractOcxProviderTableBlock(prefix + block)).toBe(block);
    expect(appendOcxProviderTableBlock(prefix + block, block)).toBe(prefix + block);
    expect(removeOcxSection(prefix + block)).toBe(prefix);
  });

  test("arrays and inline tables containing header-shaped multiline data stay opaque", () => {
    const block = header + 'name = "retained"\nvalues = [\n"""[foreign]\n\n\nlast""",\n{ label = "[another]" }\n]\n';
    const foreign = '[other]\nvalue = "keep"\n';
    expect(extractOcxProviderTableBlock(block + foreign)).toBe(block);
    expect(removeOcxSection(block + foreign)).toBe(foreign);
    expect(appendOcxProviderTableBlock(block, block)).toBe(block);
  });

  test.each(['"""', "'''"])("closing quote runs and escaped quote text remain lossless (%s)", delimiter => {
    const quote = delimiter[0]!;
    const block = header + `name = ${delimiter}first\n\n\nlast${quote}${quote}${delimiter}\n`;
    const foreign = '[other]\nvalue = "keep"\n';
    expect(extractOcxProviderTableBlock(block + foreign)).toBe(block);
    expect(removeOcxSection(block + foreign)).toBe(foreign);
  });

  test("CRLF multiline content survives capture and reattachment", () => {
    const block = '[model_providers.opencodex]\r\nname = """first\r\n\r\n\r\nlast"""\r\n';
    expect(extractOcxProviderTableBlock(block)).toBe(block);
    expect(appendOcxProviderTableBlock("", block)).toContain(block);
  });

  test("a leading BOM stays at the document boundary rather than moving with the table", () => {
    const block = header + 'name = "retained"\n';
    const foreign = '[other]\nvalue = "keep"\n';
    expect(extractOcxProviderTableBlock("\uFEFF" + block + foreign)).toBe(block);
    expect(removeOcxSection("\uFEFF" + block + foreign)).toBe("\uFEFF" + foreign);
    expect(appendOcxProviderTableBlock("\uFEFF" + foreign, block)).toBe("\uFEFF" + foreign + "\n" + block);
  });

  test.each([
    header + 'name = "unterminated\n',
    header + 'name = """unterminated\n',
    header + 'name = "one"\n' + header + 'name = "two"\n',
    '[[model_providers.opencodex]]\nname = "array"\n',
  ])("malformed or duplicate owned tables refuse before retention", content => {
    const valid = header + 'name = "retained"\n';
    expect(() => appendOcxProviderTableBlock(content, valid)).toThrow();
    expect(() => appendOcxProviderTableBlock("", content)).toThrow();
  });

  test.each([
    'model_providers.opencodex = { name = "inline" }\n',
    '"model_providers"."openco\\u0064ex" = { name = "inline" }\n',
    '[model_providers]\nopencodex = { name = "inline" }\n',
  ])("unsupported inline definitions are refused rather than duplicated", content => {
    expect(() => appendOcxProviderTableBlock(content, header + 'name = "retained"\n')).toThrow();
  });
});
