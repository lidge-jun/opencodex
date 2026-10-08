import { expect, test } from "bun:test";
import { MAX_PANES, openPane, pane, paneIds, parseLayout, reconcileLayout, removePane, resizeSplit, splitPane, type PaneLayout } from "../src/components/remote-workspace/split-layout";

test("drop edges choose correct order and axis", () => {
  for (const edge of ["left", "right", "up", "down"] as const) {
    const tree = splitPane(pane("a"), "b", "a", edge)!;
    if (tree.type !== "split") throw new Error("expected split");
    expect(tree.axis).toBe(edge === "left" || edge === "right" ? "row" : "column");
    expect(paneIds(tree)).toEqual(edge === "left" || edge === "up" ? ["b", "a"] : ["a", "b"]);
  }
});

test("moves visible sessions without duplication and repairs removed branches", () => {
  let tree = splitPane(pane("a"), "b", "a", "right")!;
  tree = splitPane(tree, "c", "b", "down")!;
  tree = splitPane(tree, "b", "a", "left")!;
  expect(paneIds(tree)).toEqual(["b", "a", "c"]);
  expect(paneIds(removePane(tree, "b"))).toEqual(["a", "c"]);
  expect(splitPane(tree, "a", "a", "right")).toBe(tree);
});

test("moving B beside A gives its divider a distinct ID from the A/B ancestor", () => {
  let tree = splitPane(pane("a"), "b", "a", "right")!;
  tree = splitPane(tree, "c", "b", "down")!;
  tree = splitPane(tree, "b", "a", "right")!;
  if (tree.type !== "split" || tree.first.type !== "split") throw new Error("expected nested split");
  expect(tree.first.id).not.toBe(tree.id);
  const resized = resizeSplit(tree, tree.first.id, 0.7);
  if (resized.type !== "split" || resized.first.type !== "split") throw new Error("expected nested split");
  expect(resized.ratio).toBe(0.5);
  expect(resized.first.ratio).toBe(0.7);
});

test("four-pane limit rejects new panes but still allows existing-pane moves", () => {
  let tree: PaneLayout = pane("a");
  for (const id of ["b", "c", "d"]) tree = splitPane(tree, id, "a", "right")!;
  expect(paneIds(tree)).toHaveLength(MAX_PANES);
  expect(splitPane(tree, "e", "a", "down")).toBe(tree);
  expect(paneIds(splitPane(tree, "b", "d", "up"))).toHaveLength(MAX_PANES);
  expect(paneIds(openPane(tree, "e", "d"))).toContain("e");
  expect(paneIds(openPane(tree, "b", "d"))).toEqual(paneIds(tree));
});

test("restoration prunes unknown sessions and validates untrusted storage", () => {
  const tree = splitPane(pane("a"), "b", "a", "down")!;
  expect(parseLayout(JSON.stringify(tree))).toEqual(tree);
  expect(reconcileLayout(tree, ["b", "c"])).toEqual(pane("b"));
  expect(reconcileLayout(tree, ["c", "d"], "c")).toEqual(pane("c"));
  expect(parseLayout("bad json")).toBeNull();
  expect(parseLayout(JSON.stringify({ type: "split", id: "x", axis: "row", ratio: 0.5, first: pane("a"), second: pane("a") }))).toBeNull();
  if (tree.type !== "split") throw new Error("expected split");
  const inner = { ...tree, first: pane("c"), second: pane("d") };
  expect(parseLayout(JSON.stringify({ ...tree, first: inner }))).toBeNull();
  const bounded = resizeSplit(tree, tree.id, 2);
  expect(bounded.type === "split" && bounded.ratio).toBe(0.8);
});
