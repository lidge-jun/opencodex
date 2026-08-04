import { expect, test } from "bun:test";
import { LANE_PAGE, LANE_SEARCH_MIN, laneView, rowStartsOpen, type LaneModel } from "../src/pages/claude-desktop-lane";

function models(count: number, overrides: Partial<Record<number, Partial<LaneModel>>> = {}): LaneModel[] {
  return Array.from({ length: count }, (_, index) => ({
    route: `provider/model-${index}`,
    label: `Model ${index}`,
    available: true,
    ...overrides[index],
  }));
}

test("a short lane gets no filter — showing one would be noise", () => {
  const lane = laneView(models(LANE_SEARCH_MIN), "", LANE_PAGE);
  expect(lane.showSearch).toBe(false);
  expect(lane.shown).toHaveLength(LANE_SEARCH_MIN);
  expect(lane.hidden).toBe(0);
});

test("the filter appears once a lane is long enough to need one", () => {
  expect(laneView(models(LANE_SEARCH_MIN + 1), "", LANE_PAGE).showSearch).toBe(true);
});

test("search matches on label and on route", () => {
  const list: LaneModel[] = [
    { route: "cursor/grok-4.5", label: "Grok 4.5", available: true },
    { route: "native/gpt-5.6-sol", label: "GPT 5.6 Sol", available: true },
  ];
  expect(laneView(list, "grok", LANE_PAGE).shown.map(m => m.route)).toEqual(["cursor/grok-4.5"]);
  expect(laneView(list, "native/", LANE_PAGE).shown.map(m => m.route)).toEqual(["native/gpt-5.6-sol"]);
  expect(laneView(list, "  SOL  ", LANE_PAGE).shown.map(m => m.route)).toEqual(["native/gpt-5.6-sol"]);
});

test("the pager holds back the tail and reports how much is left", () => {
  const lane = laneView(models(LANE_PAGE + 3), "", LANE_PAGE);
  expect(lane.shown).toHaveLength(LANE_PAGE);
  expect(lane.hidden).toBe(3);

  const expanded = laneView(models(LANE_PAGE + 3), "", LANE_PAGE * 2);
  expect(expanded.shown).toHaveLength(LANE_PAGE + 3);
  expect(expanded.hidden).toBe(0);
});

// The header must keep reporting the family's real size. Reporting the filtered count would
// make a user typing in the box believe models had been unassigned.
test("the reported total ignores the search", () => {
  const lane = laneView(models(10), "model-3", LANE_PAGE);
  expect(lane.total).toBe(10);
  expect(lane.shown).toHaveLength(1);
});

test("unavailable models sort below available ones, stably", () => {
  const list: LaneModel[] = [
    { route: "p/gone-a", label: "Gone A", available: false },
    { route: "p/live-a", label: "Live A", available: true },
    { route: "p/gone-b", label: "Gone B", available: false },
    { route: "p/live-b", label: "Live B", available: true },
  ];
  expect(laneView(list, "", LANE_PAGE).shown.map(m => m.route))
    .toEqual(["p/live-a", "p/live-b", "p/gone-a", "p/gone-b"]);
});

test("a lane with models but no matches is distinguishable from an empty lane", () => {
  expect(laneView(models(5), "nothing-matches-this", LANE_PAGE).noMatch).toBe(true);
  expect(laneView([], "", LANE_PAGE).noMatch).toBe(false);
  expect(laneView(models(5), "", LANE_PAGE).noMatch).toBe(false);
});

// Row disclosure starts the family default open — that is the row a user opens the page
// to change — and everything else closed. A family with no default opens nothing.
test("rowStartsOpen opens only the family's resolved default", () => {
  expect(rowStartsOpen("prov/first", "prov/first")).toBe(true);
  expect(rowStartsOpen("prov/second", "prov/first")).toBe(false);
  expect(rowStartsOpen("prov/first", null)).toBe(false);
});
