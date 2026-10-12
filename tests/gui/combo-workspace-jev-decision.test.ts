import { describe, expect, test } from "bun:test";
import { localCleartextAddressAllowed } from "../../src/lib/provider-outbound";
import {
  JEV_DECISION_TIMEOUT_DEFAULT_MS as SERVER_TIMEOUT_DEFAULT_MS,
  JEV_DECISION_TIMEOUT_MAX_MS as SERVER_TIMEOUT_MAX_MS,
  JEV_DECISION_TIMEOUT_MIN_MS as SERVER_TIMEOUT_MIN_MS,
  isSystemOneEndpoint,
} from "../../src/combos/types";
import {
  JEV_DECISION_TIMEOUT_DEFAULT_MS,
  JEV_DECISION_TIMEOUT_MAX_MS,
  JEV_DECISION_TIMEOUT_MIN_MS,
  canCreateJevAutoFrom,
  jevDecisionMethod,
  jevDecisionModelForbidden,
  jevDecisionModelOptions,
  jevDecisionRowIssue,
} from "../../gui/src/jev-decision-service";
import {
  type ComboItem,
  draftEquals,
  jevAutoDraft,
  jevDecisionServiceOptions,
  jevDecisionSummary,
  parseComboList,
  toPutBody,
  validateComboDraft,
} from "../../gui/src/combo-workspace-data";
import {
  JEV_AUTO_CREATE_HASH,
  jevAutoCreateDecisionProvider,
  jevAutoCreateHash,
  resolveAppHashChange,
} from "../../gui/src/app-routing";

const providers = [
  { name: "a", adapter: "openai-chat", baseUrl: "https://a.example/v1" },
  { name: "jev", adapter: "jev-decision", baseUrl: "https://api.typesafe.ai/v1/systemone" },
  { name: "tev-local", adapter: "jev-decision", baseUrl: "http://127.0.0.1:11434/v1/systemone", models: ["tev1:4b"] },
  { name: "mytev", adapter: "jev-decision", baseUrl: "https://local.example/v1/systemone", defaultModel: "tev1:4b" },
];
const providerMap = Object.fromEntries(providers.map(({ name, ...row }) => [name, row]));

function parseOne(row: Record<string, unknown>): ComboItem {
  return parseComboList({ combos: [{ id: "tev-auto", targets: [{ provider: "a", model: "m1" }], ...row }] })[0]!;
}

describe("JEV decision service in the combo workspace", () => {
  test("GUI timeout bounds and default are the server constants", () => {
    expect(JEV_DECISION_TIMEOUT_MIN_MS).toBe(SERVER_TIMEOUT_MIN_MS);
    expect(JEV_DECISION_TIMEOUT_MAX_MS).toBe(SERVER_TIMEOUT_MAX_MS);
    expect(JEV_DECISION_TIMEOUT_DEFAULT_MS).toBe(SERVER_TIMEOUT_DEFAULT_MS);
    expect(SERVER_TIMEOUT_DEFAULT_MS).toBe(4000);
  });

  test("parse and PUT round-trip decisionProvider and decisionTimeoutMs", () => {
    const parsed = parseOne({ strategy: "jev", decisionProvider: "mytev", decisionTimeoutMs: 30000 });
    expect(parsed.decisionProvider).toBe("mytev");
    expect(parsed.decisionTimeoutMs).toBe(30000);
    const body = toPutBody(parsed).combo;
    expect(body.decisionProvider).toBe("mytev");
    expect(body.decisionTimeoutMs).toBe(30000);
    expect(draftEquals(parsed, parseOne({ strategy: "jev", decisionProvider: "mytev", decisionTimeoutMs: 30000 })))
      .toBe(true);
  });

  test("an unset JEV decision service is sent as explicit null so a save can clear it", () => {
    const parsed = parseOne({ strategy: "jev" });
    expect(parsed.decisionProvider ?? null).toBeNull();
    expect(parsed.decisionTimeoutMs ?? null).toBeNull();
    const body = toPutBody(parsed).combo;
    expect(Object.hasOwn(body, "decisionProvider")).toBe(true);
    expect(body.decisionProvider).toBeNull();
    expect(body.decisionTimeoutMs).toBeNull();

    // The canonical id is the default, never a stored value.
    expect(Object.hasOwn(parseOne({ strategy: "jev", decisionProvider: "jev" }), "decisionProvider")).toBe(false);
    expect(toPutBody({ ...parsed, decisionProvider: " jev " }).combo.decisionProvider).toBeNull();
  });

  test("editing either field marks the draft dirty and clearing restores it", () => {
    const baseline = parseOne({ strategy: "jev", decisionProvider: "mytev", decisionTimeoutMs: 30000 });
    expect(draftEquals(baseline, { ...baseline, decisionProvider: null })).toBe(false);
    expect(draftEquals(baseline, { ...baseline, decisionTimeoutMs: 4000 })).toBe(false);
    const cleared = { ...baseline, decisionProvider: null, decisionTimeoutMs: null };
    expect(toPutBody(cleared).combo).toMatchObject({ decisionProvider: null, decisionTimeoutMs: null });
    // Omitted and null both mean "default", so a combo created before these fields stays clean.
    const legacy: ComboItem = { ...cleared };
    delete legacy.decisionProvider;
    delete legacy.decisionTimeoutMs;
    expect(draftEquals(legacy, cleared)).toBe(true);
  });

  test("a jev -> other -> jev round trip keeps the draft's fields; only JEV sends them", () => {
    const jev = parseOne({ strategy: "jev", decisionProvider: "mytev", decisionTimeoutMs: 30000 });
    const failover: ComboItem = { ...jev, strategy: "failover" };
    const body = toPutBody(failover).combo;
    expect(Object.hasOwn(body, "decisionProvider")).toBe(false);
    expect(Object.hasOwn(body, "decisionTimeoutMs")).toBe(false);
    // A kept value is invisible outside JEV: it neither dirties the draft nor fails validation.
    expect(draftEquals(failover, { ...failover, decisionProvider: null, decisionTimeoutMs: null })).toBe(true);
    expect(validateComboDraft({ ...failover, decisionProvider: "gone", decisionTimeoutMs: 5 }, {
      existingIds: [], isCreate: false, providers: { a: {} },
    })).toBeNull();
    const back: ComboItem = { ...failover, strategy: "jev" };
    expect(draftEquals(back, jev)).toBe(true);
    expect(toPutBody(back).combo).toMatchObject({ decisionProvider: "mytev", decisionTimeoutMs: 30000 });
  });

  test("timeout validation follows the server bounds and applies only to jev", () => {
    const jev = parseOne({ strategy: "jev" });
    const validate = (item: ComboItem) => validateComboDraft(item, {
      existingIds: [],
      isCreate: false,
      providers: { a: {} },
    });
    expect(validate({ ...jev, decisionTimeoutMs: null })).toBeNull();
    expect(validate({ ...jev, decisionTimeoutMs: 1000 })).toBeNull();
    expect(validate({ ...jev, decisionTimeoutMs: 120000 })).toBeNull();
    expect(validate({ ...jev, decisionTimeoutMs: 999 })).toBe("invalidDecisionTimeout");
    expect(validate({ ...jev, decisionTimeoutMs: 120001 })).toBe("invalidDecisionTimeout");
    expect(validate({ ...jev, decisionTimeoutMs: 1500.5 })).toBe("invalidDecisionTimeout");
    expect(validate({ ...jev, strategy: "failover", decisionTimeoutMs: 5 })).toBeNull();
  });

  test("decision service options list TypeSafe first, then self-hosted jev-decision rows", () => {
    expect(jevDecisionServiceOptions(providers)).toEqual([
      { id: null },
      { id: "mytev", baseUrl: "https://local.example/v1/systemone" },
      { id: "tev-local", baseUrl: "http://127.0.0.1:11434/v1/systemone" },
    ]);
    // A stored id that is not a decision row stays listed, with why, instead of being rewritten.
    expect(jevDecisionServiceOptions(providers, "gone").at(-1)).toEqual({ id: "gone", issue: "missing" });
    expect(jevDecisionServiceOptions(providers, "a").at(-1)).toEqual({ id: "a", issue: "notDecision" });
    expect(jevDecisionServiceOptions(providers, "jev")).toHaveLength(3);
  });

  test("rows the server rejects or the runtime skips are annotated with a reason", () => {
    const bad = [
      { name: "off", adapter: "jev-decision", baseUrl: "http://127.0.0.1:1/v1/systemone", defaultModel: "m", disabled: true },
      { name: "path", adapter: "jev-decision", baseUrl: "http://127.0.0.1:1/v1", defaultModel: "m" },
      { name: "nomodel", adapter: "jev-decision", baseUrl: "http://127.0.0.1:1/v1/systemone", models: [" "] },
    ];
    expect(jevDecisionServiceOptions(bad).map(option => [option.id, option.issue])).toEqual([
      [null, undefined],
      ["nomodel", "model"],
      ["off", "disabled"],
      ["path", "endpoint"],
    ]);
    expect(jevDecisionRowIssue(undefined)).toBe("missing");
    expect(jevDecisionRowIssue({ adapter: "openai-chat" })).toBe("notDecision");

    const jev = parseOne({ strategy: "jev" });
    const map = { ...providerMap, ...Object.fromEntries(bad.map(({ name, ...row }) => [name, row])) };
    const validate = (decisionProvider: string | null) => validateComboDraft({ ...jev, decisionProvider }, {
      existingIds: [], isCreate: false, providers: map,
    });
    expect(validate(null)).toBeNull();
    expect(validate("mytev")).toBeNull();
    for (const id of ["off", "path", "nomodel", "a", "gone"]) expect(validate(id)).toBe("invalidDecisionProvider");
  });

  test("the GUI endpoint check is the server's", () => {
    for (const url of ["https://decisions.example/v1/decisions", "http://localhost/v1/systemone", "http://127.0.0.1/v1/systemone/", "http://h/v1", "not a url", ""]) {
      expect(jevDecisionRowIssue({ adapter: "jev-decision", baseUrl: url, defaultModel: "m" }) === null)
        .toBe(isSystemOneEndpoint(url));
    }
    for (const url of ["http://decisions.example/v1/systemone", "http://10.example.com/v1/systemone", "ftp://decisions.example/v1/systemone", "https://user:pass@example.test/v1/decisions", "https://decisions.example/v1/decisions?key=secret", "https://decisions.example/v1/decisions#fragment",
      "https://decisions.example/v1/decisions?", "https://decisions.example/v1/decisions#", "https://decisions.example/v1/decisions?#",
      "https://@decisions.example/v1/decisions", "https://:@decisions.example/v1/decisions",
      "https:\t//@decisions.example/v1/decisions", "https:\n//:@decisions.example/v1/decisions", "https://decisions.example/v1/de\rcisions"]) {
      expect(isSystemOneEndpoint(url)).toBeFalse();
    }
    expect(isSystemOneEndpoint("https://decisions.example/v1/user@decisions")).toBeTrue();
  });

  test("HTTP endpoint literals match the transport's local address allowlist", () => {
    for (const address of ["127.0.0.1", "127.255.255.254", "10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.1.1",
      "::1", "::ffff:127.0.0.1", "fc00::1", "fdff::1", "172.15.0.1", "172.32.0.1", "192.169.1.1", "8.8.8.8",
      "0.0.0.0", "100.64.0.1", "169.254.169.254", "198.18.0.1", "::", "fe80::1", "::ffff:10.0.0.1", "64:ff9b::1"]) {
      const host = address.includes(":") ? `[${address}]` : address;
      expect(isSystemOneEndpoint(`http://${host}/v1/systemone`)).toBe(localCleartextAddressAllowed(address));
    }
  });

  test("the read-only summary names the service, its endpoint and timeout", () => {
    expect(jevDecisionSummary(parseOne({ strategy: "failover" }), providers)).toBeNull();
    expect(jevDecisionSummary(parseOne({ strategy: "jev" }), providers))
      .toEqual({ provider: null, model: null, baseUrl: null, timeoutMs: null });
    expect(jevDecisionSummary(
      parseOne({ strategy: "jev", decisionProvider: "mytev", decisionTimeoutMs: 30000 }),
      providers,
    )).toEqual({ provider: "mytev", model: null, baseUrl: "https://local.example/v1/systemone", timeoutMs: 30000 });
    expect(jevDecisionSummary(parseOne({ strategy: "jev", decisionModel: " a/m1 " }), providers))
      .toEqual({ provider: null, model: "a/m1", baseUrl: null, timeoutMs: null });
  });

  test("JEV Auto pre-fills a self-hosted decision service and keeps TypeSafe by default", () => {
    const models = [{ provider: "openai", id: "gpt-6-astra" }];
    expect(jevAutoDraft(models).decisionProvider).toBeNull();
    expect(jevAutoDraft(models, undefined, "jev").decisionProvider).toBeNull();
    const selfHosted = jevAutoDraft(models, undefined, "tev-local");
    expect(selfHosted.decisionProvider).toBe("tev-local");
    expect(toPutBody(selfHosted).combo.decisionProvider).toBe("tev-local");
  });

  test("Create JEV Auto: key required for canonical jev only, and the deep link carries the row", () => {
    expect(canCreateJevAutoFrom({ name: "jev", adapter: "jev-decision", hasApiKey: true })).toBe(true);
    expect(canCreateJevAutoFrom({ name: "jev", adapter: "jev-decision", hasApiKey: false })).toBe(false);
    expect(canCreateJevAutoFrom({ name: "jev", adapter: "jev-decision", hasApiKey: true, disabled: true })).toBe(false);
    const tev = { name: "tev-local", adapter: "jev-decision", baseUrl: "http://127.0.0.1:11434/v1/systemone", defaultModel: "tev1:4b" };
    expect(canCreateJevAutoFrom({ ...tev, hasApiKey: false })).toBe(true);
    expect(canCreateJevAutoFrom({ ...tev, disabled: true })).toBe(false);
    expect(canCreateJevAutoFrom({ ...tev, baseUrl: "http://127.0.0.1:11434/v1" })).toBe(false);
    expect(canCreateJevAutoFrom({ ...tev, defaultModel: undefined })).toBe(false);
    expect(canCreateJevAutoFrom({ name: "a", adapter: "openai-chat", hasApiKey: true })).toBe(false);

    expect(jevAutoCreateHash("jev")).toBe(JEV_AUTO_CREATE_HASH);
    expect(jevAutoCreateHash()).toBe(JEV_AUTO_CREATE_HASH);
    const hash = jevAutoCreateHash("tev local");
    expect(hash).toBe(`${JEV_AUTO_CREATE_HASH}?decisionProvider=tev+local`);
    expect(jevAutoCreateDecisionProvider(`#${hash}`)).toBe("tev local");
    expect(jevAutoCreateDecisionProvider(`#${JEV_AUTO_CREATE_HASH}`)).toBeNull();
    expect(jevAutoCreateDecisionProvider("#models/combos")).toBeUndefined();
    // The router keeps the query on this action link instead of stripping it.
    expect(resolveAppHashChange(hash)).toEqual({ page: "models", replaceTo: null });
  });
});

describe("JEV decision model in the combo workspace", () => {
  const jevRouter = parseComboList({
    combos: [{ id: "router-combo", alias: "router", strategy: "jev", targets: [{ provider: "a", model: "m1" }] }],
  })[0]!;
  const coding = parseComboList({
    combos: [{ id: "coding", strategy: "failover", targets: [{ provider: "a", model: "m1" }] }],
  })[0]!;
  const validate = (item: ComboItem, extra: { decisionModels?: readonly string[] } = {}) => validateComboDraft(item, {
    existingIds: [],
    isCreate: false,
    providers: { a: {} },
    combos: [jevRouter, coding],
    ...extra,
  });

  test("decisionModel round-trips and replaces the decision provider on save", () => {
    const parsed = parseOne({ strategy: "jev", decisionModel: " a/m1 ", decisionTimeoutMs: 8000 });
    expect(parsed.decisionModel).toBe("a/m1");
    expect(toPutBody(parsed).combo).toMatchObject({ decisionProvider: null, decisionModel: "a/m1", decisionTimeoutMs: 8000 });
    // Both selectors set in a draft: the model wins and the provider is sent as an explicit clear.
    expect(toPutBody({ ...parsed, decisionProvider: "mytev" }).combo).toMatchObject({ decisionProvider: null, decisionModel: "a/m1" });
    // Without a model a JEV save still clears it explicitly, so switching back to a service sticks.
    const service = toPutBody(parseOne({ strategy: "jev", decisionProvider: "mytev" })).combo;
    expect(Object.hasOwn(service, "decisionModel")).toBe(true);
    expect(service).toMatchObject({ decisionProvider: "mytev", decisionModel: null });
    expect(Object.hasOwn(toPutBody({ ...parsed, strategy: "failover" }).combo, "decisionModel")).toBe(false);
    expect(Object.hasOwn(parseOne({ strategy: "jev", decisionModel: "  " }), "decisionModel")).toBe(false);
    // A blank model input sends the stored service, never a provider-and-model clear that means TypeSafe.
    for (const decisionModel of ["", "   "]) {
      expect(toPutBody({ ...parsed, decisionModel, decisionProvider: "mytev" }).combo)
        .toMatchObject({ decisionProvider: "mytev", decisionModel: null });
    }
  });

  test("a decisionModel change dirties a JEV draft only", () => {
    const parsed = parseOne({ strategy: "jev", decisionModel: "a/m1" });
    expect(draftEquals(parsed, { ...parsed, decisionModel: "a/m0" })).toBe(false);
    expect(draftEquals(parsed, { ...parsed, decisionModel: null })).toBe(false);
    const failover: ComboItem = { ...parsed, strategy: "failover" };
    expect(draftEquals(failover, { ...failover, decisionModel: null })).toBe(true);
  });

  test("the method follows the stored selector", () => {
    expect(jevDecisionMethod({})).toBe("typesafe");
    expect(jevDecisionMethod({ decisionProvider: "jev" })).toBe("typesafe");
    expect(jevDecisionMethod({ decisionProvider: "mytev" })).toBe("systemone");
    // An empty model keeps the model method selected until the field is filled.
    expect(jevDecisionMethod({ decisionModel: "" })).toBe("model");
    expect(jevDecisionMethod({ decisionProvider: "mytev", decisionModel: "a/m1" })).toBe("model");
  });

  test("model validation refuses empty, self, and JEV routes and allows ordinary ones", () => {
    const jev = parseOne({ strategy: "jev" });
    expect(jev.model).toBe("combo/tev-auto");
    expect(validate({ ...jev, decisionModel: "a/m1" })).toBeNull();
    expect(validate({ ...jev, decisionModel: "combo/coding" })).toBeNull();
    expect(validate({ ...jev, decisionModel: "" })).toBe("invalidDecisionModel");
    expect(validate({ ...jev, decisionModel: "x".repeat(513) })).toBe("invalidDecisionModel");
    expect(validate({ ...jev, decisionModel: "combo/tev-auto" })).toBe("invalidDecisionModel");
    expect(validate({ ...jev, decisionModel: "router" })).toBe("invalidDecisionModel");
    expect(validate({ ...jev, decisionModel: "combo/router-combo" })).toBe("invalidDecisionModel");
    expect(validate({ ...jev, decisionModel: "a/m1", decisionProvider: "mytev" })).toBe("invalidDecisionModel");
    expect(validate({ ...jev, decisionModel: "a/m9" }, { decisionModels: ["a/m1"] })).toBe("invalidDecisionModel");
    expect(validate({ ...jev, decisionModel: "a/m1" }, { decisionModels: ["a/m1"] })).toBeNull();
    // Off JEV the stored model is inert.
    expect(validate({ ...jev, strategy: "failover", decisionModel: "combo/tev-auto" })).toBeNull();
  });

  test("the GUI refuses only exact self/JEV selectors and leaves synthetic suffixes to the server", () => {
    const self = { id: "tev-auto", alias: null, model: "combo/tev-auto" };
    const combos = [
      { id: "router-combo", alias: "router", model: "router", strategy: "jev" },
      { id: "coding", alias: null, model: "combo/coding", strategy: "failover" },
    ];
    expect(jevDecisionModelForbidden("combo/tev-auto", combos, self)).toBe(true);
    expect(jevDecisionModelForbidden(" router ", combos, self)).toBe(true);
    expect(jevDecisionModelForbidden("combo/router-combo", combos, self)).toBe(true);
    expect(jevDecisionModelForbidden("combo/coding", combos, self)).toBe(false);
    // Whether a suffix is a synthetic selector depends on server settings and known ids.
    expect(jevDecisionModelForbidden("combo/tev-auto--fast", combos, self)).toBe(false);
    expect(jevDecisionModelForbidden("router--high", combos, self)).toBe(false);
  });

  test("model options list enabled routable models and non-JEV combos only", () => {
    const models = [
      { provider: "a", id: "m1" },
      { provider: "a", id: "m0", namespaced: "a/m0-ns" },
      { provider: "a", id: "gone", disabled: true },
      { provider: "off", id: "x" },
      { provider: "tev-local", id: "tev1:4b" },
      { provider: "combo", id: "coding" },
    ];
    const rows = [...providers, { name: "off", adapter: "openai-chat", disabled: true }];
    const combos = [
      { id: "tev-auto", alias: null, model: "combo/tev-auto", strategy: "jev" },
      { id: "router-combo", alias: "router", model: "router", strategy: "jev" },
      { id: "coding", alias: null, model: "combo/coding", strategy: "failover" },
    ];
    expect(jevDecisionModelOptions(models, rows, combos, { id: "tev-auto", alias: null, model: "combo/tev-auto" }))
      .toEqual(["a/m0-ns", "a/m1", "combo/coding"]);
    // A non-JEV combo never lists itself.
    expect(jevDecisionModelOptions(models, rows, combos, { id: "coding", alias: null, model: "combo/coding" }))
      .toEqual(["a/m0-ns", "a/m1"]);
  });
});
