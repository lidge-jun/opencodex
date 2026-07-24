import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { computeSelectMenuStyle } from "../src/select-position";

const globals = ["window"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map((key) => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/", width: 1024, height: 800 });
  Object.defineProperty(globalThis, "window", { configurable: true, value: testWindow });
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

test("opens below by default when there is room under the trigger", () => {
  const style = computeSelectMenuStyle({
    top: 120,
    bottom: 156,
    left: 120,
    right: 320,
    width: 200,
    height: 36,
  }, { menuHeight: 180 });
  expect(style.top).toBe(160);
  expect(style.bottom).toBeUndefined();
  expect(style.left).toBe(120);
  expect(style.minWidth).toBe(200);
});

test("flips upward near the bottom of the viewport", () => {
  const style = computeSelectMenuStyle({
    top: 700,
    bottom: 736,
    left: 120,
    right: 320,
    width: 200,
    height: 36,
  }, { menuHeight: 180 });
  expect(style.bottom).toBe(108);
  expect(style.top).toBeUndefined();
  expect(style.maxHeight).toBe(688);
});

test("right placement opens beside the trigger", () => {
  const style = computeSelectMenuStyle({
    top: 700,
    bottom: 736,
    left: 120,
    right: 320,
    width: 200,
    height: 36,
  }, { placement: "right", menuHeight: 120 });
  expect(style.left).toBe(326);
  expect(style.top).toBe(700);
  expect(style.minWidth).toBe(160);
});

test("right placement flips above when the trigger is near the bottom edge", () => {
  const style = computeSelectMenuStyle({
    top: 700,
    bottom: 736,
    left: 120,
    right: 320,
    width: 200,
    height: 36,
  }, { placement: "right", menuHeight: 220 });
  expect(style.left).toBe(326);
  expect(style.bottom).toBe(108);
  expect(style.top).toBeUndefined();
});

test("right alignment anchors the menu to the trigger's right edge", () => {
  const style = computeSelectMenuStyle({
    top: 120,
    bottom: 156,
    left: 120,
    right: 320,
    width: 200,
    height: 36,
  }, { align: "right", menuHeight: 120 });
  expect(style.right).toBe(704);
  expect(style.left).toBeUndefined();
});
