import { expect, test } from "bun:test";
import { effectiveDeclaration, withoutComments } from "./helpers/css-declarations";

test("Models provider headers use wrap-safe classes and a sibling toggle boundary", async () => {
  const src = await Bun.file(new URL("../src/pages/Models.tsx", import.meta.url)).text();
  expect(src).toContain("models-provider-head");
  expect(src).toContain("models-provider-actions");
  expect(src).toContain("models-provider-toggle");
  // Collapse lives on a sibling button; the actions row no longer needs stopPropagation.
  expect(src).toMatch(/className="row models-provider-toggle"/);
  expect(src).toMatch(/className="row models-provider-actions"/);
  expect(src).not.toMatch(/className="row models-provider-actions"\s+onClick=\{e => e\.stopPropagation\(\)\}/);
  // Both Classic and Workspace share renderGroup — no duplicate unclassed group-head for providers.
  const providerHeads = src.match(/models-provider-head/g) ?? [];
  expect(providerHeads.length).toBeGreaterThanOrEqual(1);
  expect(src).toContain("models.allOn");
  expect(src).toContain("models.allOff");
});

test("Models workspace stacks via content-width container query before mobile drawer", async () => {
  const css = await Bun.file(new URL("../src/styles-models-workspace.css", import.meta.url)).text();
  expect(css).toContain("container-name: models-workspace");
  expect(css).toContain("container-type: inline-size");
  expect(css).toContain("@container models-workspace (max-width: 720px)");
  expect(css).toContain(".models-provider-head");
  expect(css).toContain(".models-provider-actions");
  expect(css).toContain(".models-provider-toggle");
  expect(css).toMatch(/\.models-provider-head\s*\{[^}]*flex-wrap:\s*wrap/s);
  expect(css).toMatch(/\.models-provider-actions\s*\{[^}]*flex-wrap:\s*wrap/s);
  expect(css).toMatch(/\.models-provider-toggle\s*\{[^}]*min-width:\s*0/s);
  // Mobile media rule retained for drawer layouts.
  expect(css).toContain("@media (max-width: 768px)");
});

test("Models exposes provider and per-model context-window controls (#1073)", async () => {
  const page = await Bun.file(new URL("../src/pages/Models.tsx", import.meta.url)).text();
  const groups = await Bun.file(new URL("../src/models-groups.ts", import.meta.url)).text();

  expect(groups).toContain("contextWindow?: number");
  expect(groups).toContain("modelContextWindows?: Record<string, number>");
  expect(page).toContain('t("models.contextSettings")');
  expect(page).toContain("modelContextWindows");
  expect(page).toMatch(/\/api\/providers\?name=.*method:\s*"PATCH"/s);
  expect(page).toContain('className="models-context-fields"');

  const css = await Bun.file(new URL("../src/styles-models-workspace.css", import.meta.url)).text();
  expect(css).toMatch(/\.models-context-fields\s*\{[^}]*gap:\s*var\(--space-4\)/s);
});

/**
 * The provider header collapsed at 1040-1380px: the name box measured 0.0px and painted
 * its glyphs across the active count, and the alias chip broke into a six-line blob
 * (Korean permits a break between Hangul syllables, so its min-content width is about
 * one syllable). Both symptoms were one cause - the toggle's inline `flex: 1` resolves
 * to `flex: 1 1 0%`, and a zero base size never reports a content requirement, so the
 * header's own `flex-wrap: wrap` never learned the toggle needed room and handed it the
 * 31px the actions cluster left over.
 *
 * These are source-text assertions. The rendered proof - 20/20 cells green across
 * ko/ru/fr/en/de x 1440/1280/1100/1024, containment at -2 on five stress cases, and a
 * 14px chevron - was measured in a real browser over CDP and is recorded in
 * `devlog/_plan/260830_models_provider_header/010_toggle_basis_and_shrink.md`. What this
 * file can do is stop the specific declarations from being removed or narrowed silently.
 */
test("the provider toggle keeps a real flex basis so the header can wrap (#2958)", async () => {
  const page = await Bun.file(new URL("../src/pages/Models.tsx", import.meta.url)).text();

  // Scoped to the toggle's own style object on purpose. A file-wide search for `flex: 1`
  // would be wrong: an unrelated `style={{ flex: 1 }}` on the alias-row `<code>` is
  // legitimate, so a global negative assertion would fail on correct code.
  const toggle = page.match(/className="row models-provider-toggle"[\s\S]{0,400}?style=\{\{([^}]*)\}\}/);
  expect(toggle).not.toBeNull();
  const toggleStyle = toggle![1];
  expect(toggleStyle).toMatch(/flex:\s*"1 1 auto"/);
  // `flex: 1` is the defect itself - zero basis - and must not come back here.
  expect(toggleStyle).not.toMatch(/flex:\s*1\s*,/);
});

test("every provider-toggle child can shrink, and the chevron cannot (#2958)", async () => {
  const css = withoutComments(await Bun.file(new URL("../src/styles-models-workspace.css", import.meta.url)).text());

  // Quantified over the children rather than enumerating them. Four earlier designs
  // bounded this row by naming the children that could overflow it - name, then alias
  // chip, then the count and badge - and each revision found another one. Narrowing this
  // selector back to specific children reintroduces that failure mode.
  expect(effectiveDeclaration(css, ".models-provider-toggle > *", "min-width")).toBe("0");
  expect(effectiveDeclaration(css, ".models-provider-toggle > *", "overflow")).toBe("hidden");
  expect(effectiveDeclaration(css, ".models-provider-toggle > *", "text-overflow")).toBe("ellipsis");
  expect(effectiveDeclaration(css, ".models-provider-toggle > *", "white-space")).toBe("nowrap");

  // Asserted separately from the rule above because it looks redundant and is not. The
  // universal rule also matches the chevron `<svg>`, whose inline `width: 14` is not a
  // flex floor - it keeps `flex-shrink: 1`. Without this exemption the adversarial stress
  // row rendered the chevron at 2.5px while the containment check still reported success:
  // the row fit because a control had been destroyed. Text children abbreviate; icons
  // have nothing to truncate.
  expect(effectiveDeclaration(css, ".models-provider-toggle > svg", "flex")).toBe("none");

  // The floor on the toggle itself is kept, not replaced by the child rule.
  expect(effectiveDeclaration(css, ".models-provider-toggle", "min-width")).toBe("0");
});

test("provider-toggle children stay element-wrapped, which is what the child rule needs (#2958)", async () => {
  const page = await Bun.file(new URL("../src/pages/Models.tsx", import.meta.url)).text();

  // `> *` selects ELEMENT children. A bare interpolated string inside the button would
  // become an anonymous flex item that no selector can reach, and it would keep its own
  // min-content floor - silently reopening the defect the child rule closes. This is the
  // invariant that bound actually rests on, so it is asserted rather than assumed.
  // Slice from the END of the opening tag: the button's own attribute list contains
  // interpolations (`aria-expanded={!isCollapsed}`, the inline style object) which are not
  // children at all, and an earlier version of this test reported them as violations.
  const open = page.match(/<button[^>]*className="row models-provider-toggle"[\s\S]*?\n\s*>/);
  expect(open).not.toBeNull();
  const afterOpen = page.slice(open!.index! + open![0].length);
  const end = afterOpen.indexOf("</button>");
  expect(end).toBeGreaterThan(0);
  const children = afterOpen.slice(0, end);

  // Only TOP-LEVEL interpolations matter. An interpolation nested inside a child element -
  // `<span>{t("models.discoveryFailedBadge")}</span>` - is that span's text content, and the
  // span is the flex item. So the scan tracks element depth and inspects depth 0 only; a
  // line-based version of this check reported that nested span as a violation.
  const topLevel: string[] = [];
  let depth = 0;
  for (let i = 0; i < children.length; i += 1) {
    if (children[i] === "<") {
      if (children[i + 1] === "/") depth -= 1;
      else depth += 1;
      // A self-closing tag opens and closes in one go.
      const close = children.indexOf(">", i);
      if (close !== -1 && children[close - 1] === "/") depth -= 1;
      i = close === -1 ? i : close;
      continue;
    }
    if (children[i] === ">") continue;
    if (depth > 0) continue;
    if (children[i] === "{") {
      // Capture the balanced interpolation so a nested object literal does not end it early.
      let brace = 1;
      let j = i + 1;
      for (; j < children.length && brace > 0; j += 1) {
        if (children[j] === "{") brace += 1;
        else if (children[j] === "}") brace -= 1;
      }
      const expr = children.slice(i, j);
      i = j - 1;
      if (!expr.startsWith("{/*")) topLevel.push(expr.replace(/\s+/g, " ").trim());
    }
  }

  // Every top-level interpolation must produce an element, never a bare string: it has to
  // contain a tag. `{cond && <span/>}` qualifies; `{t("x")}` would not.
  const bareText = topLevel.filter((expr) => !expr.includes("<"));
  expect(bareText).toEqual([]);
  // Guard against the scan silently matching nothing and passing vacuously.
  expect(topLevel.length).toBeGreaterThan(0);
});
