import { describe, expect, test } from "bun:test";
import {
  shadowBackgroundModelBadge,
  shadowSourceOptionActive,
  shadowSourceModelBadge,
  shadowSourceModelLabel,
  shadowSourceModelList,
  toggleShadowCallSource,
  type ShadowCallSourceOption,
} from "../src/pages/shadow-call-source";
import { shadowCallSaveErrorKey } from "../src/pages/models-shared";

/**
 * The settings endpoint answers several different 400s with the same status, so the message
 * has to come from the stable `code`. These cases pin the three operator-visible outcomes and
 * keep an unknown code (older runtime, proxy error page) on the neutral text rather than
 * blaming a target the operator may not have touched.
 */
describe("shadowCallSaveErrorKey", () => {
  test("maps a target conflict to the replacement target message", () => {
    expect(shadowCallSaveErrorKey("shadow_call_target_invalid"))
      .toBe("models.shadowCallTargetInvalid");
  });

  test("maps an invalid source selection to the source message", () => {
    expect(shadowCallSaveErrorKey("shadow_call_source_invalid"))
      .toBe("models.shadowCallSourceInvalid");
  });

  test.each([undefined, null, "", "upstream_error"])(
    "falls back to the neutral save message for %p",
    code => {
      expect(shadowCallSaveErrorKey(code)).toBe("models.shadowCallSaveFailed");
    },
  );
});

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
    expect(shadowSourceModelList(undefined)).toEqual(["gpt-6-luna", "gpt-5.6-luna"]);
  });

  // An empty array is what a runtime sends when every configured entry was
  // rejected; showing nothing there would read as "nothing is intercepted",
  // which is the opposite of the truth.
  test("falls back on an empty list instead of rendering nothing", () => {
    expect(shadowSourceModelList([])).toEqual(["gpt-6-luna", "gpt-5.6-luna"]);
  });

  test("drops blank entries and trims the rest", () => {
    expect(shadowSourceModelList([" gpt-5.6-luna ", "", "   "])).toEqual(["gpt-5.6-luna"]);
  });

  test("falls back when the field is not an array at all", () => {
    expect(shadowSourceModelList("gpt-5.6-luna" as unknown as string[]))
      .toEqual(["gpt-6-luna", "gpt-5.6-luna"]);
  });

  test("drops a routed prefix that can never match a bare helper id", () => {
    expect(shadowSourceModelList(["openai/gpt-5.6-luna"])).toEqual([]);
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
    expect(shadowSourceModelLabel(undefined)).toBe("gpt-6-luna, gpt-5.6-luna");
    expect(shadowSourceModelBadge(undefined)).toBe("6-luna, 5.6-luna");
  });
});

describe("shadowBackgroundModelBadge", () => {
  test("adds the separately routed memory model to the shadow source list", () => {
    expect(shadowBackgroundModelBadge(["gpt-6-luna", "gpt-5.6-luna"], "Konsolidierung: Terra"))
      .toBe("6-luna, 5.6-luna (+ Konsolidierung: Terra)");
  });

  test("uses the runtime fallback for the shadow sources", () => {
    expect(shadowBackgroundModelBadge(undefined, "Consolidation: Terra"))
      .toBe("6-luna, 5.6-luna (+ Consolidation: Terra)");
  });

  test("keeps a configured source override while adding the memory model", () => {
    expect(shadowBackgroundModelBadge(["custom-helper"], "Terra"))
      .toBe("custom-helper (+ Terra)");
  });

  test("does not list the memory model twice when it is an explicit source", () => {
    expect(shadowBackgroundModelBadge(["gpt-6-luna", "gpt-5.6-luna", "gpt-5.6-terra"], "Memory: Terra"))
      .toBe("6-luna, 5.6-luna, 5.6-terra");
  });

  test("does not list the newer Terra twice when it is an explicit source", () => {
    expect(shadowBackgroundModelBadge(["gpt-6-luna", "gpt-5.6-luna", "gpt-6.1-terra"], "Memory: Terra"))
      .toBe("6-luna, 5.6-luna, 6.1-terra");
  });

  test("treats a broader source prefix as covering the memory model", () => {
    expect(shadowBackgroundModelBadge(["gpt-5.6"], "Memory: Terra")).toBe("5.6");
  });
});

const terra: ShadowCallSourceOption = { id: "gpt-5.6-terra", role: "memory", defaultIntercepted: false };
const terra61: ShadowCallSourceOption = { id: "gpt-6.1-terra", role: "memory", defaultIntercepted: false };
const luna: ShadowCallSourceOption = { id: "gpt-5.6-luna", role: "helper", defaultIntercepted: true };

describe("shadow source toggles", () => {
  test("an option is active when any configured prefix covers it", () => {
    expect(shadowSourceOptionActive("gpt-5.6-terra", ["gpt-5.6"])).toBe(true);
    expect(shadowSourceOptionActive("gpt-5.6-terra", ["gpt-6-luna"])).toBe(false);
  });

  test("switching an inactive source on appends its exact prefix", () => {
    expect(toggleShadowCallSource(terra, ["gpt-6-luna", "gpt-5.6-luna"])).toEqual({
      sourceModels: ["gpt-6-luna", "gpt-5.6-luna", "gpt-5.6-terra"],
    });
  });

  test("switching the newer Terra on appends its exact prefix", () => {
    expect(toggleShadowCallSource(terra61, ["gpt-6-luna", "gpt-5.6-luna"])).toEqual({
      sourceModels: ["gpt-6-luna", "gpt-5.6-luna", "gpt-6.1-terra"],
    });
  });

  test("switching an active source off removes only its exact prefix", () => {
    expect(toggleShadowCallSource(luna, ["gpt-6-luna", "gpt-5.6-luna"]))
      .toEqual({ sourceModels: ["gpt-6-luna"] });
  });

  test("the last active source cannot be switched off", () => {
    expect(toggleShadowCallSource(terra, ["gpt-5.6-terra"])).toEqual({ blocked: "last" });
  });

  test("a broader custom prefix blocks a covered option instead of changing siblings", () => {
    expect(toggleShadowCallSource(terra, ["gpt-5.6", "custom-helper"]))
      .toEqual({ blocked: "covered", prefix: "gpt-5.6" });
  });

  test("a covered option stays blocked when the exact prefix comes first", () => {
    expect(toggleShadowCallSource(terra, ["gpt-5.6-terra", "gpt-5.6"]))
      .toEqual({ blocked: "covered", prefix: "gpt-5.6" });
  });

  test("a custom entry can be switched off by its exact prefix", () => {
    const custom: ShadowCallSourceOption = { id: "custom-helper", role: "custom", defaultIntercepted: false };
    expect(toggleShadowCallSource(custom, ["gpt-6-luna", "custom-helper"]))
      .toEqual({ sourceModels: ["gpt-6-luna"] });
  });
});
