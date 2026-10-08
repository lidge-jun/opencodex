export type SplitEdge = "left" | "right" | "up" | "down";
export type PaneLayout = { type: "pane"; sessionId: string } | {
  type: "split"; id: string; axis: "row" | "column"; ratio: number; first: PaneLayout; second: PaneLayout;
};
export const MAX_PANES = 4;
export const paneIds = (tree: PaneLayout | null): string[] => !tree ? [] : tree.type === "pane"
  ? [tree.sessionId] : [...paneIds(tree.first), ...paneIds(tree.second)];
export const pane = (sessionId: string): PaneLayout => ({ type: "pane", sessionId });

export function removePane(tree: PaneLayout | null, sessionId: string): PaneLayout | null {
  if (!tree) return null;
  if (tree.type === "pane") return tree.sessionId === sessionId ? null : tree;
  const first = removePane(tree.first, sessionId), second = removePane(tree.second, sessionId);
  return !first ? second : !second ? first : first === tree.first && second === tree.second ? tree : { ...tree, first, second };
}

function replacePane(tree: PaneLayout, sessionId: string, next: PaneLayout): PaneLayout {
  if (tree.type === "pane") return tree.sessionId === sessionId ? next : tree;
  return { ...tree, first: replacePane(tree.first, sessionId, next), second: replacePane(tree.second, sessionId, next) };
}

export function openPane(tree: PaneLayout | null, sessionId: string, active: string): PaneLayout {
  if (!tree) return pane(sessionId);
  if (paneIds(tree).includes(sessionId)) return tree;
  return replacePane(tree, paneIds(tree).includes(active) ? active : paneIds(tree)[0]!, pane(sessionId));
}

export function splitPane(tree: PaneLayout | null, sessionId: string, targetId: string, edge: SplitEdge): PaneLayout | null {
  if (!tree) return pane(sessionId);
  const ids = paneIds(tree);
  if (sessionId === targetId || !ids.includes(targetId) || (ids.length >= MAX_PANES && !ids.includes(sessionId))) return tree;
  const withoutSource = removePane(tree, sessionId)!;
  const before = edge === "left" || edge === "up";
  const splitIds = new Set<string>();
  const collect = (node: PaneLayout): void => {
    if (node.type === "pane") return;
    splitIds.add(node.id); collect(node.first); collect(node.second);
  };
  collect(withoutSource);
  let sequence = 1;
  while (splitIds.has(`split-${sequence}`)) sequence++;

  const split: PaneLayout = {
    type: "split", id: `split-${sequence}`, axis: edge === "left" || edge === "right" ? "row" : "column", ratio: 0.5,
    first: pane(before ? sessionId : targetId), second: pane(before ? targetId : sessionId),
  };
  return replacePane(withoutSource, targetId, split);
}

export function resizeSplit(tree: PaneLayout, id: string, ratio: number): PaneLayout {
  if (tree.type === "pane") return tree;
  if (tree.id === id) return { ...tree, ratio: Math.min(0.8, Math.max(0.2, ratio)) };
  return { ...tree, first: resizeSplit(tree.first, id, ratio), second: resizeSplit(tree.second, id, ratio) };
}

export function reconcileLayout(tree: PaneLayout | null, ids: string[], fallback?: string): PaneLayout | null {
  let next = tree;
  for (const id of paneIds(tree)) if (!ids.includes(id)) next = removePane(next, id);
  return next ?? (fallback && ids.includes(fallback) ? pane(fallback) : ids.length ? pane(ids[ids.length - 1]!) : null);
}

/** Storage contains only layout identifiers, never prompts or model output. */
export function parseLayout(raw: string | null): PaneLayout | null {
  if (!raw || raw.length > 8192) return null;
  const seen = new Set<string>();
  const splits = new Set<string>();
  function parse(value: unknown, depth: number): PaneLayout | null {
    if (!value || typeof value !== "object" || depth > MAX_PANES) return null;
    const node = value as Record<string, unknown>;
    if (node.type === "pane" && typeof node.sessionId === "string" && node.sessionId.length > 0 && node.sessionId.length < 200 && !seen.has(node.sessionId)) {
      seen.add(node.sessionId);
      return seen.size <= MAX_PANES ? pane(node.sessionId) : null;
    }
    if (node.type !== "split" || typeof node.id !== "string" || node.id.length > 400 || (node.axis !== "row" && node.axis !== "column") || typeof node.ratio !== "number" || !Number.isFinite(node.ratio)) return null;
    if (splits.has(node.id)) return null;
    splits.add(node.id);
    const first = parse(node.first, depth + 1), second = parse(node.second, depth + 1);
    return first && second ? { type: "split", id: node.id, axis: node.axis, ratio: Math.min(0.8, Math.max(0.2, node.ratio)), first, second } : null;
  }
  try { return parse(JSON.parse(raw), 0); } catch { return null; }
}
