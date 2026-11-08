import { expect, test } from "bun:test";
import { Glob } from "bun";
import ts from "typescript";

/*
 * One switch look. v1 grew three switch drawings (.switch, .toggle and Remote Link's own
 * .remote-link-switch), each with its own size and knob colour, so the same on/off control
 * looked squashed on one page and roomy on the next. design/bridge.css now draws all three
 * from one spec. This rule keeps it that way:
 *   - every role="switch" control carries one of those classes, or is a checkbox directly
 *     inside a .toggle track with a .slider sibling (prefer shared <Switch> for new code);
 *   - the bridge still holds the rule that draws them alike.
 */
const SANCTIONED = /\b(switch|toggle|remote-link-switch)\b/;

type JsxTag = ts.JsxOpeningElement | ts.JsxSelfClosingElement;
function attr(tag: JsxTag, name: string): ts.JsxAttribute | undefined {
  return tag.attributes.properties.find((item): item is ts.JsxAttribute => ts.isJsxAttribute(item) && item.name.getText() === name);
}
function literalText(initializer: ts.JsxAttribute["initializer"]): string | undefined {
  const value = initializer && ts.isJsxExpression(initializer) ? initializer.expression : initializer;
  return value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) ? value.text : undefined;
}
function plainToggle(tag: JsxTag): boolean {
  const value = literalText(attr(tag, "className")?.initializer);
  return tag.tagName.getText() === "span" && tag.attributes.properties.length === 1
    && value === "toggle";
}
function renderableSlider(tag: JsxTag): boolean {
  const className = literalText(attr(tag, "className")?.initializer);
  return tag.tagName.getText() === "span" && className === "slider" && tag.attributes.properties.every(property => ts.isJsxAttribute(property)
      && ["className", "aria-hidden"].includes(property.name.getText()));
}
function wrappedToggle(tag: JsxTag): boolean {
  const type = literalText(attr(tag, "type")?.initializer);
  const parent = tag.parent;
  if (tag.tagName.getText() !== "input" || type !== "checkbox"
      || tag.attributes.properties.some(property => !ts.isJsxAttribute(property)
        || ["hidden", "aria-hidden", "style", "className"].includes(property.name.getText()))
      || !ts.isJsxElement(parent) || !plainToggle(parent.openingElement)) return false;
  const children = parent.children.filter(child => !ts.isJsxText(child) || child.text.trim() !== "");
  const next = children[children.indexOf(tag as ts.JsxChild) + 1];
  return !!next && (ts.isJsxElement(next) && renderableSlider(next.openingElement)
    || ts.isJsxSelfClosingElement(next) && renderableSlider(next));
}
function scan(source: string, file: string): { offenders: string[]; seen: number } {
  const root = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const offenders: string[] = [];
  let seen = 0;
  function visit(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const role = literalText(attr(node, "role")?.initializer);
      if (role === "switch") {
        seen++;
        const className = attr(node, "className")?.initializer?.getText(root) ?? "";
        if (!SANCTIONED.test(className) && !wrappedToggle(node)) {
          offenders.push(`${file}:${root.getLineAndCharacterOfPosition(node.getStart(root)).line + 1}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  return { offenders, seen };
}

test("every role=switch control uses one of the sanctioned switch classes", async () => {
  const offenders: string[] = [];
  let seen = 0;
  for await (const file of new Glob("src/**/*.tsx").scan(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
    const path = new URL(`../${file.replace(/\\/g, "/")}`, import.meta.url);
    const src = await Bun.file(path).text();
    const result = scan(src, file);
    seen += result.seen;
    offenders.push(...result.offenders);
  }
  // The scan must actually reach the switches it guards, or it would pass vacuously.
  expect(seen).toBeGreaterThanOrEqual(5);
  expect(offenders).toEqual([]);
});

test("only a checkbox inside a real toggle track with a slider can use the wrapper exception", () => {
  const valid = '<span className="toggle"><input type="checkbox" role="switch" /><span className="slider" /></span>';
  expect(scan(valid, "valid.tsx").offenders).toEqual([]);
  const staticExpression = '<span className={"toggle"}><input type="checkbox" role="switch" /><span className="slider" /></span>';
  expect(scan(staticExpression, "valid-expression.tsx").offenders).toEqual([]);
  const staticTemplates = '<span className={`toggle`}><input type={"checkbox"} role={`switch`} /><span className={`slider`} /></span>';
  expect(scan(staticTemplates, "valid-template.tsx")).toEqual({ offenders: [], seen: 1 });
  for (const validExpression of [
    '<span className={"toggle"}><input type="checkbox" role="switch" /><span className={`slider`} /></span>',
    '<span className={`toggle`}><input type="checkbox" role="switch" /><span className={"slider"} /></span>',
  ]) expect(scan(validExpression, "valid-expression.tsx").offenders).toEqual([]);
  for (const invalid of [
    '<span className="toggle"><input type="checkbox" role="switch" /></span>',
    '<span className="other"><input type="checkbox" role="switch" /><span className="slider" /></span>',
    '<span className="toggle"><input type="text" role="switch" /><span className="slider" /></span>',
    '<span className="toggle"><span><input type="checkbox" role="switch" /></span><span className="slider" /></span>',
    '<span className="toggle"><span className="slider" /><input type="checkbox" role="switch" /></span>',
    '<span className="toggle"><input type="checkbox" role="switch" /><i /><span className="slider" /></span>',
    '<span className="toggle"><input type="checkbox" role="switch" /><input className="slider" /></span>',
    '<span className="toggle"><input type="checkbox" role="switch" /><CustomSlider className="slider" /></span>',
    '<span className="toggle"><input type="checkbox" role="switch" /><span className="slider" hidden /></span>',
    '<span className="toggle"><input type="checkbox" role="switch" /><span className="slider hidden" /></span>',
    '<span className="toggle"><input type="checkbox" role="switch" /><span className="slider" style={{ display: "none" }} /></span>',
    '<span className="toggle"><input type="checkbox" role="switch" hidden /><span className="slider" /></span>',
    '<span className="toggle"><input type="checkbox" role="switch" aria-hidden="true" /><span className="slider" /></span>',
    '<span className="toggle"><input type="checkbox" role="switch" style={{display:"none"}} /><span className="slider" /></span>',
    '<span className="toggle"><input type="checkbox" role="switch" {...props} /><span className="slider" /></span>',
    '<span className="toggle" hidden><input type="checkbox" role="switch" /><span className="slider" /></span>',
    '<span className="toggle" style={{display:"none"}}><input type="checkbox" role="switch" /><span className="slider" /></span>',
    '<span className="toggle" {...props}><input type="checkbox" role="switch" /><span className="slider" /></span>',
    '<span className="toggle hidden"><input type="checkbox" role="switch" /><span className="slider" /></span>',
    '<span className="toggle" aria-hidden="true"><input type="checkbox" role="switch" /><span className="slider" /></span>',
    '<span className={track}><input type="checkbox" role="switch" /><span className="slider" /></span>',
    '<span className="toggle"><input type="checkbox" role="switch" /><span className={slider} /></span>',
    '<span className={`toggle ${unsafe}`}><input type="checkbox" role="switch" /><span className="slider" /></span>',
  ]) expect(scan(invalid, "invalid.tsx").offenders).toHaveLength(1);
});

test("the bridge draws every sanctioned switch from one spec", async () => {
  const bridge = await Bun.file(new URL("../src/design/bridge.css", import.meta.url)).text();
  // A labeled button must size around its text; only its pseudo-element is a track.
  expect(bridge).toContain(":is(.switch:where(:not(.switch-labeled)), .toggle, .remote-link-switch) {");
  expect(bridge).toContain("width: 34px;");
  expect(bridge).toContain("height: 20px;");
  // The spec outranks v1's own state fills, so the on state must be restated for every class.
  expect(bridge).toContain(':is(.switch.on:where(:not(.switch-labeled)), .toggle.on, .remote-link-switch[aria-checked="true"]) { background: var(--toggle-on-bg);');
  expect(bridge).toContain(".switch.mixed:where(:not(.switch-labeled)) { background: var(--amber-soft);");
});

test("badges carry words, so they are not set in monospace", async () => {
  const bridge = await Bun.file(new URL("../src/design/bridge.css", import.meta.url)).text();
  expect(bridge).toContain(".badge { font-family: var(--font-ui); letter-spacing: 0; }");
});
