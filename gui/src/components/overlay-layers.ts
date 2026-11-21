/**
 * Which open overlay owns Escape (#8849). Several parts of the dashboard open overlays that can
 * coexist: the Add Provider modal card, plain confirmations (`.dialog-backdrop`), and native modal
 * `<dialog>`s. Escape belongs to the one the user sees on top:
 * - an open native modal dialog sits in the browser's top layer, above every in-page overlay, and
 *   the most recently opened one is on top;
 * - among in-page overlays, the higher computed z-index wins (`.dialog-backdrop` is 900,
 *   `.modal-overlay` uses --z-modal), and document order breaks ties.
 */
const OVERLAY_LAYERS = "dialog[open], .modal-overlay, .dialog-backdrop";

function zIndexOf(element: Element): number {
  const view = element.ownerDocument.defaultView;
  const value = view ? Number.parseInt(view.getComputedStyle(element).zIndex, 10) : Number.NaN;
  return Number.isFinite(value) ? value : 0;
}

export function topmostOverlayLayer(): Element | undefined {
  const open = [...document.querySelectorAll(OVERLAY_LAYERS)]
    .filter(node => node.tagName !== "DIALOG" || (node as HTMLDialogElement).open);
  const dialogs = open.filter(node => node.tagName === "DIALOG");
  if (dialogs.length > 0) return dialogs[dialogs.length - 1];
  let top: Element | undefined;
  for (const node of open) if (!top || zIndexOf(node) >= zIndexOf(top)) top = node;
  return top;
}

/** True when `layer` is the overlay Escape belongs to. */
export function isTopmostOverlayLayer(layer: Element | null): boolean {
  return layer !== null && topmostOverlayLayer() === layer;
}
