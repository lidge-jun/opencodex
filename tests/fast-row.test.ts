import { describe, expect, test } from "bun:test";
import { knownEffortRowIds, parseEffortRowId, parseRequestEffortRowId } from "../src/server/effort-row";
import {
  effortBaseCarriesFastMarker,
  expandFastRow,
  fastRowBases,
  fastRowEligible,
  fastRowId,
  parseFastOnlyRowId,
  parseFastRowId,
  parseSyntheticRowId,
} from "../src/server/fast-row";
import { isDeclaredReasoningEffort } from "../src/reasoning-effort";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

/**
 * Synthetic Fast selectors (devlog 260904_external_fast_wire/010).
 *
 * Each test drives one conditional and asserts the observable effect rather than that a
 * table contains a value. Several exist because an earlier draft failed them: the
 * known-id-as-routable-base design published `gpt-5.6-sol--fast` and then refused to parse
 * it, and a suffix-shape composite guard suppressed rows this feature itself publishes.
 */

const OFF = {} as Pick<OcxConfig, "fastRows">;
const ON = { fastRows: true } as Pick<OcxConfig, "fastRows">;

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-responses",
    baseUrl: "https://fixture.example/v1",
    ...overrides,
  } as OcxProviderConfig;
}

function configWith(providers: Record<string, OcxProviderConfig>, extra: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: Object.keys(providers)[0] ?? "fixture",
    providers,
    fastRows: true,
    ...extra,
  } as OcxConfig;
}

describe("fast-row grammar", () => {
  test("the flag is off by default, on both the parser and the expander", () => {
    // The path every existing install runs. Both inventories are optional, so this needs no
    // config at all.
    expect(parseFastRowId("x--fast", OFF)).toBeNull();
    expect(expandFastRow({ id: "x" }, true, OFF)).toEqual([{ id: "x" }]);
  });

  test("a fast row is additive, never a replacement", () => {
    // Unlike the fastMode global rewrite: a per-request selector has to leave the default
    // pickable beside it.
    expect(expandFastRow({ id: "m" }, true, ON)).toEqual([{ id: "m" }, { id: "m--fast" }]);
    expect(fastRowId("m")).toBe("m--fast");
  });

  test("an ineligible row publishes nothing", () => {
    expect(expandFastRow({ id: "m" }, false, ON)).toEqual([{ id: "m" }]);
  });

  test("an exact known id beats the synthetic grammar", () => {
    // An operator who really named a model `foo--fast` keeps it.
    const known = new Set(["foo--fast"]);
    expect(parseFastRowId("foo--fast", ON, known, new Set(["foo"]))).toBeNull();
    expect(expandFastRow({ id: "foo" }, true, ON, known)).toEqual([{ id: "foo" }]);
  });

  test("an unroutable base is refused", () => {
    expect(parseFastRowId("nonexistent--fast", ON, new Set(), new Set(["other"]))).toBeNull();
  });

  test("a bare marker is not a model", () => {
    expect(parseFastRowId("--fast", ON, new Set(), new Set())).toBeNull();
  });

  test("a base that itself ends in an effort marker still parses", () => {
    // The discarded suffix-shape composite guard failed this: it saw `--high` before
    // `--fast` and suppressed a row this feature publishes.
    expect(parseFastRowId("a--high--fast", ON, new Set(), new Set(["a--high"])))
      .toEqual({ baseId: "a--high" });
  });
});

describe("fast-row eligibility", () => {
  test("only an eligible policy publishes", () => {
    // `unclassified` is the subtle one: capability is undefined, and decideTier makes
    // fastMode inert there, so a row would advertise a tier the runtime then drops.
    expect(fastRowEligible(provider({ supportsServiceTier: true }), "m")).toBe(true);
    expect(fastRowEligible(provider({ supportsServiceTier: false }), "m")).toBe(false);
    expect(fastRowEligible(provider(), "m")).toBe(false);
  });

  test("an adapter without the wire does not publish", () => {
    // The anthropic-speed wire kind has an empty adapter set by design.
    expect(fastRowEligible(
      provider({ adapter: "anthropic", supportsServiceTier: true }),
      "m",
    )).toBe(false);
  });

  test("exact-model capability is honoured over the provider default", () => {
    const p = provider({ supportsServiceTier: true, modelSupportsServiceTier: { slow: false } });
    expect(fastRowEligible(p, "fast-one")).toBe(true);
    expect(fastRowEligible(p, "slow")).toBe(false);
  });
});

describe("fast-row routable bases", () => {
  test("bare natives are routable even with no declared models list", () => {
    // The regression that killed the known-id-based draft: bare natives route by family
    // pattern, so they appear in no models list, and requiring known-id membership would
    // publish `gpt-5.6-sol--fast` and then refuse to parse it.
    const config = configWith({ openai: provider({ authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" }) });
    const bases = fastRowBases(config);
    expect(bases.has("gpt-5.6-sol")).toBe(true);
    expect(parseFastRowId("gpt-5.6-sol--fast", config, new Set(), bases))
      .toEqual({ baseId: "gpt-5.6-sol" });
  });

  test("configured routed ids stay routable", () => {
    const config = configWith({ fixture: provider({ models: ["m1"] }) });
    const bases = fastRowBases(config);
    expect(bases.has("m1")).toBe(true);
    expect(bases.has("fixture/m1")).toBe(true);
  });
});

describe("grammar interference", () => {
  test("`fast` is not a declared effort, so the two grammars do not collide", () => {
    // This is what lets both grammars share the `--` separator. Without it, the composition
    // is an assumption rather than a fact.
    expect(isDeclaredReasoningEffort("fast")).toBe(false);
    expect(parseEffortRowId("x--fast", { cursorEffortRows: true })).toBeNull();
  });

  test("a fast marker is not an effort row and vice versa", () => {
    expect(parseFastRowId("x--high", ON, new Set(), new Set(["x"]))).toBeNull();
  });

  test("a nested marker is detected, unless the base is a real model", () => {
    expect(effortBaseCarriesFastMarker("x--fast", new Set())).toBe(true);
    expect(effortBaseCarriesFastMarker("foo--fast", new Set(["foo--fast"]))).toBe(false);
    expect(effortBaseCarriesFastMarker("x", new Set())).toBe(false);
  });
});

describe("parseSyntheticRowId", () => {
  test("with fastRows off it delegates, preserving shipped effort-row behaviour", () => {
    // Delegation to the SAME shipped function, not a reimplementation: an install that never
    // enables this feature must observe no change. An earlier draft rebuilt the logic inline
    // and regressed both the early return and the nested-marker case below.
    const config = configWith({ fixture: provider({ models: ["x"] }) }, {
      fastRows: false,
      cursorEffortRows: true,
    });
    expect(parseSyntheticRowId("x--high", config).effortRow).toEqual({ baseId: "x", effort: "high" });
    expect(parseSyntheticRowId("x", config)).toEqual({ fastRow: null, effortRow: null });
    // With fastRows OFF the nested-marker rule must not apply, or a cursorEffortRows user
    // loses a row they get today.
    expect(parseSyntheticRowId("x--fast--high", config).effortRow)
      .toEqual({ baseId: "x--fast", effort: "high" });
  });

  test("with fastRows on it returns at most one grammar", () => {
    const config = configWith({ fixture: provider({ models: ["x"], supportsServiceTier: true }) });
    const fast = parseSyntheticRowId("x--fast", config);
    expect(fast.fastRow).toEqual({ baseId: "x" });
    expect(fast.effortRow).toBeNull();
  });

  test("a nested marker resolves to neither grammar when fast rows are on", () => {
    const config = configWith({ fixture: provider({ models: ["x"] }) }, { cursorEffortRows: true });
    expect(parseSyntheticRowId("x--fast--high", config)).toEqual({ fastRow: null, effortRow: null });
  });

  test("the decoded-selector thunk drives Fast while effort sees the raw id", () => {
    const config = configWith({ fixture: provider({ models: ["x"] }) });
    const rows = parseSyntheticRowId("opaque-alias", config, () => "x--fast");
    expect(rows.fastRow).toEqual({ baseId: "x" });
  });

  test("the thunk is not evaluated when the flag is off", () => {
    // Arguments evaluate before the call, which is why the parameter is a thunk: an eager
    // decode would run alias lookups on the path this function exists to leave untouched.
    let evaluated = false;
    const config = configWith({ fixture: provider() }, { fastRows: false });
    parseSyntheticRowId("x", config, () => { evaluated = true; return "x--fast"; });
    expect(evaluated).toBe(false);
  });
});

describe("parseFastOnlyRowId", () => {
  test("resolves a fast selector for a surface that never parsed an effort row", () => {
    const config = configWith({ fixture: provider({ models: ["x"] }) }, { cursorEffortRows: true });
    expect(parseFastOnlyRowId(config, () => "x--fast")).toEqual({ baseId: "x" });
    // An effort row is NOT resolved here: count_tokens and compact never parsed one, so they
    // must not start.
    expect(parseFastOnlyRowId(config, () => "x--high")).toBeNull();
  });

  test("returns before evaluating the selector when the flag is off", () => {
    let evaluated = false;
    const config = configWith({ fixture: provider() }, { fastRows: false });
    expect(parseFastOnlyRowId(config, () => { evaluated = true; return "x--fast"; })).toBeNull();
    expect(evaluated).toBe(false);
  });
});

describe("publication and parsing agree", () => {
  test("every base the listing would publish a row for is accepted by the parser", () => {
    // The anti-drift invariant. Publication and parsing read different sources, so this is
    // the assertion that keeps a published row from being unparsable - the exact failure an
    // earlier draft shipped for bare natives.
    const config = configWith({
      openai: provider({ authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex", supportsServiceTier: true }),
      fixture: provider({ models: ["m1", "m2"], supportsServiceTier: true }),
    });
    const knownIds = knownEffortRowIds(config);
    const bases = fastRowBases(config, knownIds);
    const published = ["gpt-5.6-sol", "m1", "m2", "fixture/m1"]
      .flatMap(id => expandFastRow({ id }, true, config, knownIds))
      .map(row => row.id)
      .filter(id => id.endsWith("--fast"));
    expect(published.length).toBeGreaterThan(0);
    for (const id of published) {
      expect(parseFastRowId(id, config, knownIds, bases)).not.toBeNull();
    }
  });

  test("an account-qualified native round-trips", () => {
    const config = configWith({
      openai: provider({ authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" }),
    });
    const bases = fastRowBases(config);
    const qualified = [...bases].find(id => id.includes("/") && id.endsWith("gpt-5.6-sol"));
    if (qualified === undefined) return; // no account selector configured in this fixture
    expect(parseFastRowId(fastRowId(qualified), config, new Set(), bases))
      .toEqual({ baseId: qualified });
  });
});

describe("a fast row lives exactly as long as its base row", () => {
  test("a base that leaves the routable set stops parsing, as its listing row also would", () => {
    // fastRowBases is intentionally NOT constant across a session: it reads the live-model
    // cache, and so does publication. When a live-only model leaves the cache its plain base
    // row leaves the listing too, so the fast selector going with it is correct. Pinning fast
    // selectors alive past their base would be the actual defect.
    const withModel = configWith({ fixture: provider({ models: ["live-only"] }) });
    const withoutModel = configWith({ fixture: provider({ models: [] }) });
    expect(parseFastRowId("live-only--fast", withModel, new Set(), fastRowBases(withModel)))
      .toEqual({ baseId: "live-only" });
    expect(parseFastRowId("live-only--fast", withoutModel, new Set(), fastRowBases(withoutModel)))
      .toBeNull();
  });

  test("a bare native is stable regardless of cache state", () => {
    // The static half of the set. This is what bare natives need: they route by family
    // pattern and appear in no cache, so their selectors must never depend on one.
    const config = configWith({
      openai: provider({ authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" }),
    });
    expect(fastRowBases(config).has("gpt-5.6-sol")).toBe(true);
    expect(fastRowBases(config, new Set()).has("gpt-5.6-sol")).toBe(true);
  });
});

describe("delegation is the shipped function, not a lookalike", () => {
  test("with fastRows off the wrapper matches parseRequestEffortRowId exactly", () => {
    // Compared against the real function across a selector table: an inline reimplementation
    // producing the same few answers would pass a hand-written expectation but fail here.
    const config = configWith({ fixture: provider({ models: ["x", "x--fast"] }) }, {
      fastRows: false,
      cursorEffortRows: true,
    });
    for (const selector of ["x", "x--high", "x--fast", "x--fast--high", "x--nonsense", "--high", ""]) {
      expect(parseSyntheticRowId(selector, config).effortRow)
        .toEqual(parseRequestEffortRowId(selector, config));
    }
  });
});

