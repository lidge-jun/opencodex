/**
 * Form-control rule: no native dropdowns, no unstyled text fields.
 *
 * Why. A native `<select>` and a bare `<input>`/`<textarea>` are painted by the browser, not by
 * the design system: grey boxes with the platform's own font, border and arrow. In dark mode
 * they render as light-grey slabs with dark text (or invisible text) on the dark page, and in
 * both themes they look like a different application. The user found exactly that on the
 * Advisor page (effort / policy dropdowns and the timeout box) and in model pickers, and asked
 * that it never come back.
 *
 * The rule, checked over every `src/**\/*.tsx`:
 *   (a) No native `<select>` anywhere except `src/ui.tsx`, the home of the app's own `Select`
 *       (button + portaled listbox, keyboard and type-ahead, disabled options, `required`).
 *       Use `Select` from `ui.tsx`; if it lacks something, extend it there.
 *   (b) Every text-like `<input>` (any type except checkbox, radio, hidden, file, range and
 *       color, including no type at all) and every `<textarea>` carries a `className`:
 *       `input` (the v1 field, repainted to v2 by the bridge), a v2 Tailwind class set, or a
 *       page class that styles it. An element with a `{...spread}` is trusted to pass one.
 *
 * Tags are read with a brace-aware scanner, because attribute values are JSX expressions that
 * can hold `>` (`onChange={e => …}`, `a > b`), quotes and nested braces. A `<select` or
 * `<input` only counts where JSX can start (after `(`, `{`, `}`, `>`, `?`, `:`, `&&`, `=`, `,`,
 * `return`, …), so prose in comments ("a native <select>") is not a hit.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const GUI_ROOT = join(import.meta.dir, "..");
const SRC = join(GUI_ROOT, "src");
const SELECT_HOME = "src/ui.tsx";
const EXEMPT_INPUT_TYPES = new Set(["checkbox", "radio", "hidden", "file", "range", "color"]);

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [path] : [];
  });
}

/** Characters (as the last non-space character before `<`) after which JSX may begin. */
const JSX_LEAD = new Set(["(", "{", "}", ">", "?", ":", "&", "|", "=", ",", ";", "["]);

function startsJsx(source: string, at: number): boolean {
  let i = at - 1;
  while (i >= 0 && /\s/.test(source[i]!)) i--;
  if (i < 0) return true;
  if (JSX_LEAD.has(source[i]!)) return true;
  return /\breturn$/.test(source.slice(Math.max(0, i - 6), i + 1));
}

/** Index just past a quoted string or template literal that opens at `at`. */
function skipString(source: string, at: number): number {
  const quote = source[at]!;
  let i = at + 1;
  while (i < source.length) {
    const c = source[i]!;
    if (c === "\\") { i += 2; continue; }
    if (c === quote) return i + 1;
    if (quote === "`" && c === "$" && source[i + 1] === "{") { i = skipBraces(source, i + 1); continue; }
    i++;
  }
  return i;
}

/** Index just past the `}` matching the `{` at `at`, skipping strings and comments inside. */
function skipBraces(source: string, at: number): number {
  let depth = 0;
  let i = at;
  while (i < source.length) {
    const c = source[i]!;
    if (c === "\"" || c === "'" || c === "`") { i = skipString(source, i); continue; }
    if (c === "/" && source[i + 1] === "/") { i = source.indexOf("\n", i); if (i < 0) return source.length; continue; }
    if (c === "/" && source[i + 1] === "*") { i = source.indexOf("*/", i + 2); if (i < 0) return source.length; i += 2; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return i;
}

interface Attr { name: string; value: string | null }

/** The attributes of the JSX tag whose name ends at `at`, up to its closing `>`/`/>`. */
function readAttributes(source: string, at: number): Attr[] {
  const attrs: Attr[] = [];
  let i = at;
  while (i < source.length) {
    const c = source[i]!;
    if (c === ">" || (c === "/" && source[i + 1] === ">")) return attrs;
    if (/\s/.test(c)) { i++; continue; }
    if (c === "{") {
      // `{...spread}` (or a stray expression): opaque, recorded as a spread.
      const end = skipBraces(source, i);
      attrs.push({ name: "{...}", value: source.slice(i, end) });
      i = end;
      continue;
    }
    const name = /^[\w:.-]+/.exec(source.slice(i))?.[0];
    if (!name) { i++; continue; }
    i += name.length;
    while (/\s/.test(source[i] ?? "")) i++;
    if (source[i] !== "=") { attrs.push({ name, value: null }); continue; }
    i++;
    while (/\s/.test(source[i] ?? "")) i++;
    const start = i;
    if (source[i] === "\"" || source[i] === "'") i = skipString(source, i);
    else if (source[i] === "{") i = skipBraces(source, i);
    attrs.push({ name, value: source.slice(start, i) });
  }
  return attrs;
}

interface Tag { tag: "select" | "input" | "textarea"; line: number; attrs: Attr[] }

function scanFormControls(source: string): Tag[] {
  const tags: Tag[] = [];
  const pattern = /<(select|input|textarea)(?=[\s/>])/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    if (!startsJsx(source, match.index)) continue;
    tags.push({
      tag: match[1] as Tag["tag"],
      line: source.slice(0, match.index).split("\n").length,
      attrs: readAttributes(source, match.index + match[0].length),
    });
  }
  return tags;
}

function staticValue(value: string | null): string | null {
  if (value === null) return null;
  const quoted = /^["'](.*)["']$/s.exec(value) ?? /^\{\s*["'`]([^"'`$]*)["'`]\s*\}$/s.exec(value);
  return quoted ? quoted[1]! : null;
}

function formControlViolations(file: string, source: string): string[] {
  const out: string[] = [];
  for (const { tag, line, attrs } of scanFormControls(source)) {
    const where = `${file}:${line}`;
    if (tag === "select") {
      if (file !== SELECT_HOME) out.push(`${where} native <select>: use Select from src/ui.tsx`);
      continue;
    }
    if (tag === "input") {
      const type = attrs.find(attr => attr.name === "type");
      const typeName = type ? staticValue(type.value) : "text";
      if (typeName !== null && EXEMPT_INPUT_TYPES.has(typeName.toLowerCase())) continue;
    }
    if (attrs.some(attr => attr.name === "{...}")) continue;
    const className = attrs.find(attr => attr.name === "className");
    const empty = className && (className.value === null || staticValue(className.value)?.trim() === "");
    if (!className || empty) out.push(`${where} <${tag}> without a className: give it "input" or v2 classes`);
  }
  return out;
}

test("the scanner reads JSX attributes that contain arrows, quotes and nested braces", () => {
  const source = [
    "const a = (",
    "  <input value={x} onChange={e => set(e.target.value > 1 ? \"}\" : `${y}>`)} className=\"input\" />",
    ");",
    "// a native <select> in prose is not a tag",
    "const b = cond && <textarea rows={2} onChange={() => { if (a > b) go(); }} />;",
    "const c = <input type=\"checkbox\" />;",
    "const d = <select value={v}>{opts}</select>;",
    "const e = <input type={kind} {...rest} />;",
  ].join("\n");
  expect(scanFormControls(source).map(({ tag, line }) => `${tag}@${line}`))
    .toEqual(["input@2", "textarea@5", "input@6", "select@7", "input@8"]);
  expect(formControlViolations("src/x.tsx", source)).toEqual([
    "src/x.tsx:5 <textarea> without a className: give it \"input\" or v2 classes",
    "src/x.tsx:7 native <select>: use Select from src/ui.tsx",
  ]);
});

test("no native <select> and no unstyled text field anywhere in src", () => {
  const violations = tsxFiles(SRC).flatMap(path => {
    const file = relative(GUI_ROOT, path).split(sep).join("/");
    return formControlViolations(file, readFileSync(path, "utf8"));
  });
  expect(violations).toEqual([]);
});
