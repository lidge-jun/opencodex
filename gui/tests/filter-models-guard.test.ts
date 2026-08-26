import { expect, test } from "bun:test";
import { filterModels } from "../src/provider-workspace/report";

test("filterModels coerces non-array live/configured/custom inputs instead of crashing", () => {
  // Regression: Providers → Models crashed with `r.filter is not a function` when a
  // mis-shaped selected-models payload reached the chip list.
  expect(filterModels(undefined as never, "def", "", undefined, undefined as never, false)).toEqual(["def"]);
  expect(filterModels({ oops: true } as never, undefined, "", "not-array" as never, null as never, true)).toEqual([]);
  expect(filterModels(["live-a", "live-b"], undefined, "b", ["cfg"], ["custom-b"], true))
    .toEqual(["live-b", "custom-b"]);
  expect(filterModels([], "fallback", "", ["cfg-a", "cfg-b"], [], false))
    .toEqual(["cfg-a", "cfg-b"]);
});
