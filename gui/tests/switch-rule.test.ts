import { expect, test } from "bun:test";
import { Glob } from "bun";

/*
 * One switch look. v1 grew three switch drawings (.switch, .toggle and Remote Link's own
 * .remote-link-switch), each with its own size and knob colour, so the same on/off control
 * looked squashed on one page and roomy on the next. design/bridge.css now draws all three
 * from one spec. This rule keeps it that way:
 *   - every role="switch" control carries one of those three classes, so a fourth drawing
 *     cannot appear unnoticed (prefer the shared <Switch> from ui.tsx for new code);
 *   - the bridge still holds the rule that draws them alike.
 */
const SANCTIONED = /\b(switch|toggle|remote-link-switch)\b/;

function tagEnd(src: string, from: number): number {
  let depth = 0;
  let quote = "";
  for (let i = from; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === quote && src[i - 1] !== "\\") quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return i;
  }
  return src.length;
}

test("every role=switch control uses one of the sanctioned switch classes", async () => {
  const offenders: string[] = [];
  let seen = 0;
  for await (const file of new Glob("src/**/*.tsx").scan(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
    const path = new URL(`../${file.replace(/\\/g, "/")}`, import.meta.url);
    const src = await Bun.file(path).text();
    for (const m of src.matchAll(/<[a-z]+\b/g)) {
      const start = m.index! + m[0].length;
      const attrs = src.slice(start, tagEnd(src, start));
      if (!/\brole="switch"/.test(attrs)) continue;
      seen++;
      const className = attrs.match(/className=(\{`[^`]*`\}|"[^"]*"|\{[^}]*\})/)?.[1] ?? "";
      if (!SANCTIONED.test(className)) {
        offenders.push(`${file}:${src.slice(0, m.index).split("\n").length}`);
      }
    }
  }
  // The scan must actually reach the switches it guards, or it would pass vacuously.
  expect(seen).toBeGreaterThanOrEqual(5);
  expect(offenders).toEqual([]);
});

test("the bridge draws every sanctioned switch from one spec", async () => {
  const bridge = await Bun.file(new URL("../src/design/bridge.css", import.meta.url)).text();
  expect(bridge).toContain(":is(.switch, .toggle, .remote-link-switch) {");
  expect(bridge).toContain("width: 34px;");
  expect(bridge).toContain("height: 20px;");
  // The spec outranks v1's own state fills, so the on state must be restated for every class.
  expect(bridge).toContain(':is(.switch.on, .toggle.on, .remote-link-switch[aria-checked="true"]) { background: var(--toggle-on-bg);');
  expect(bridge).toContain(".switch.mixed { background: var(--amber-soft);");
});

test("badges carry words, so they are not set in monospace", async () => {
  const bridge = await Bun.file(new URL("../src/design/bridge.css", import.meta.url)).text();
  expect(bridge).toContain(".badge { font-family: var(--font-ui); letter-spacing: 0; }");
});
