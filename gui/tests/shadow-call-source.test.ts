import { describe, expect, test } from "bun:test";
import {
  shadowSourceModelBadge,
  shadowSourceModelLabel,
  shadowSourceModelList,
} from "../src/pages/shadow-call-source";

/**
 * The GUI used to spell the intercepted slug into six locale files, which went
 * stale every time Codex changed its helper model. It now renders whatever the
 * runtime reports, so the cases that matter are: the runtime reported a list,
 * the runtime is too old to report one, and the operator configured an override.
 * Without these, a fallback or formatting regression ships silently green.
 */
describe("shadowSourceModelList", () => {
  test("renders the models the runtime reported", () => {
    expect(shadowSourceModelList(["gpt-5.4-mini", "gpt-5.6-luna"]))
      .toEqual(["gpt-5.4-mini", "gpt-5.6-luna"]);
  });

  test("renders a configured override rather than the defaults", () => {
    expect(shadowSourceModelList(["gpt-6-helper"])).toEqual(["gpt-6-helper"]);
  });

  test("falls back when a runtime too old to report sourceModels omits it", () => {
    expect(shadowSourceModelList(undefined)).toEqual(["gpt-5.6-luna"]);
  });

  // An empty array is what a runtime sends when every configured entry was
  // rejected; showing nothing there would read as "nothing is intercepted",
  // which is the opposite of the truth.
  test("falls back on an empty list instead of rendering nothing", () => {
    expect(shadowSourceModelList([])).toEqual(["gpt-5.6-luna"]);
  });

  test("drops blank entries and trims the rest", () => {
    expect(shadowSourceModelList([" gpt-5.6-luna ", "", "   "])).toEqual(["gpt-5.6-luna"]);
  });

  test("falls back when the field is not an array at all", () => {
    expect(shadowSourceModelList("gpt-5.6-luna" as unknown as string[]))
      .toEqual(["gpt-5.6-luna"]);
  });
});

describe("shadow source model rendering", () => {
  test("label joins every reported model", () => {
    expect(shadowSourceModelLabel(["gpt-5.4-mini", "gpt-5.6-luna"]))
      .toBe("gpt-5.4-mini, gpt-5.6-luna");
  });

  test("badge drops the shared gpt- prefix to keep the row compact", () => {
    expect(shadowSourceModelBadge(["gpt-5.4-mini", "gpt-5.6-luna"]))
      .toBe("5.4-mini, 5.6-luna");
  });

  test("badge leaves a non-gpt id untouched", () => {
    expect(shadowSourceModelBadge(["helper-x"])).toBe("helper-x");
  });

  test("both renderings use the fallback when the runtime reported nothing", () => {
    expect(shadowSourceModelLabel(undefined)).toBe("gpt-5.6-luna");
    expect(shadowSourceModelBadge(undefined)).toBe("5.6-luna");
  });
});
