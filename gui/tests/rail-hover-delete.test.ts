import { expect, test } from "bun:test";

/**
 * WP4 (devlog/_plan/260725_gui_view_consolidation/040_rail_hover_delete.md):
 * hovering a provider row in the Providers rail reveals a delete accelerator.
 *
 * The row itself is a <button role="option">, so the control must be a SIBLING inside a
 * positioned wrapper. Nesting it would be invalid HTML, would let one click both select
 * and delete, and would break the listbox's `el.contains(active)` focus tracking.
 */

const read = (p: string) => Bun.file(new URL(p, import.meta.url)).text();

test("the delete control is a sibling of the row, never a child", async () => {
  const shell = await read("../src/components/provider-workspace/ProviderWorkspaceShell.tsx");
  const rail = await read("../src/components/provider-workspace/ProviderRail.tsx");

  // Wrapper exists and holds both the row and the control.
  expect(shell).toContain('className="pws-rail-row-wrap"');
  expect(shell).toContain('className="pws-rail-row-remove"');

  // The row markup itself gained no interactive descendant.
  expect(rail).not.toContain("pws-rail-row-remove");
  expect(rail).toContain('role="option"');

  // Selecting must not be triggered by the delete click.
  expect(shell).toContain("event.stopPropagation();");
});

test("the accelerator stays out of the tab order and the accessibility tree", async () => {
  const shell = await read("../src/components/provider-workspace/ProviderWorkspaceShell.tsx");
  const removeButton = shell.slice(
    shell.indexOf('className="pws-rail-row-remove"'),
    shell.indexOf("</button>", shell.indexOf('className="pws-rail-row-remove"')),
  );

  // Keyboard and screen-reader users already have the labelled control in the detail
  // header; duplicating it here would disturb option roving in the listbox.
  expect(removeButton).toContain("tabIndex={-1}");
  expect(removeButton).toContain('aria-hidden="true"');
});

test("deleting routes through the existing confirmation dialog", async () => {
  const shell = await read("../src/components/provider-workspace/ProviderWorkspaceShell.tsx");
  const providers = await read("../src/pages/Providers.tsx");
  const crud = await read("../src/pages/use-providers-crud.ts");
  const modals = await read("../src/pages/providers-page-modals.tsx");

  // Providers hands the rail the same callback the detail header uses...
  expect(providers).toContain("onRemoveProvider={removeProvider}");
  expect(shell).toContain("onRemoveProvider(item.name)");

  // ...and that callback only opens the dialog; it never deletes directly.
  // CRUD lives in the extracted hook after the Providers split.
  const handler = crud.slice(
    crud.indexOf("const removeProvider = useCallback"),
    crud.indexOf("const confirmRemoveProvider"),
  );
  expect(handler).toContain("setRemoveConfirmName(name)");
  expect(handler).not.toContain("method: \"DELETE\"");
  expect(modals).toContain("<RemoveConfirmDialog");
});

test("the accelerator is hidden where hover does not exist", async () => {
  const css = await read("../src/styles/provider-workspace-shell.css");
  const rule = (selector: string) => css.slice(css.indexOf(selector), css.indexOf("}", css.indexOf(selector)));

  expect(css).toContain(".pws-rail-row-wrap {");
  expect(css).toContain("position: relative;");
  // Revealed on hover, plus focus-within so the control does not vanish while the row
  // itself holds focus. It is NOT keyboard-reachable (tabIndex=-1) — keyboard users take
  // the labelled control in the detail header.
  expect(css).toContain(".pws-rail-row-wrap:hover .pws-rail-row-remove");
  expect(css).toContain(".pws-rail-row-wrap:focus-within .pws-rail-row-remove");
  // Hidden by default, revealed on hover — assert the actual declarations, not just
  // that the selectors exist.
  expect(rule(".pws-rail-row-remove {")).toContain("opacity: 0;");
  expect(rule(".pws-rail-row-remove {")).toContain("pointer-events: none;");
  expect(rule(".pws-rail-row-wrap:hover .pws-rail-row-remove")).toContain("opacity: 1;");
  // The floating control overlays the trailing star/status area. Hide those markers
  // while the control is visible so the default star cannot be partially cropped.
  expect(css).toContain(".pws-rail-row-wrap:hover .providers-workspace-rail-trail");
  expect(rule(".pws-rail-row-wrap:hover .providers-workspace-rail-trail")).toContain("opacity: 0;");

  // Touch devices have no hover, so it would otherwise be permanently visible.
  expect(css).toContain("@media (hover: none)");
  expect(css.slice(css.indexOf("@media (hover: none)"))).toContain("display: none;");
});
