import { expect, test } from "bun:test";
import {
  createBuiltinGuardrailsRegistry,
  createGuardrailsRegistry,
  demaskGuardrailsText,
  GuardrailsMatchAmbiguityError,
  GuardrailsRuleCompileError,
  maskGuardrailsText,
  scanGuardrailsText,
} from "../src/guardrails";
import { WrappedRE2 } from "../src/guardrails/re2-runtime";
import { validateGuardrailsCustomRulesCompatibility } from "../src/guardrails/registry";
import {
  MAX_GUARDRAILS_REGEX_INPUT_BYTES,
  MAX_GUARDRAILS_SCANNABLE_LEAF_BYTES,
  createGuardrailsScanBudget,
} from "../src/guardrails/scanner";
import { provenGuardrailsPrefilterKeywords } from "../src/guardrails/prefilter";
import { RE2 } from "../src/guardrails/re2-runtime";
import type {
  CompiledGuardrailsRule,
  GuardrailsCustomRule,
  GuardrailsRegistry,
} from "../src/guardrails/types";
import { validateGuardrailsCandidate } from "../src/guardrails/validators";
import { GUARDRAILS_CONFIRMED_MISS_ANALOGS } from "./helpers/guardrails-confirmed-miss-analogs";

function registryWithOnlyBuiltinRule(ruleId: string) {
  const allBuiltinRules = createBuiltinGuardrailsRegistry().rules;
  return createGuardrailsRegistry({
    disabledBuiltinRuleIds: allBuiltinRules
      .map(rule => rule.ruleId)
      .filter(candidate => candidate !== ruleId),
  });
}

function customRule(
  regex: string,
  captureGroups: number[],
  ruleId = "custom.test",
): GuardrailsCustomRule {
  return {
    ruleId,
    name: "Custom test",
    dataType: 6,
    group: "CUSTOM",
    groupPriority: 0,
    displayName: "Custom test",
    description: "Test-only custom rule",
    regex,
    keywords: [],
    banlist: [],
    validators: [],
    masking: { captureGroups, placeholderType: "CUSTOM_TEST" },
  };
}

function registryWithProofRule(
  regex: string,
  keywords: readonly string[],
  ruleId: string,
): GuardrailsRegistry {
  const matcher = new RE2(regex, "gu");
  const rule: CompiledGuardrailsRule = {
    ruleId,
    name: ruleId,
    dataType: 1,
    group: "TEST",
    groupPriority: 0,
    displayName: ruleId,
    description: "Recall-preserving prefilter regression",
    regex,
    keywords,
    banlist: [],
    validators: [],
    masking: { captureGroups: [], placeholderType: "PREFILTER_TEST" },
    source: "manual",
    matcher,
    prefilterKeywords: provenGuardrailsPrefilterKeywords(regex, keywords),
  };
  return {
    rules: [rule],
    groups: [],
    keywordPrefilterEnabled: true,
    dispose() {
      const disposable = matcher as unknown as { wrapper?: { delete?: () => void } };
      disposable.wrapper?.delete?.();
    },
  };
}

test("builtin Guardrails registry compiles every pinned donor rule exactly once", () => {
  const registry = createBuiltinGuardrailsRegistry();
  const donorRules = registry.rules.filter(rule => rule.source !== "opencodex");
  const supplementalRules = registry.rules.filter(rule => rule.source === "opencodex");

  expect(donorRules).toHaveLength(266);
  expect(supplementalRules).toHaveLength(5);
  expect(new Set(registry.rules.map(rule => rule.ruleId)).size).toBe(271);
  expect(registry.rules.some(rule => rule.ruleId === "api_keys.stripe-key")).toBe(true);
  expect(registry.rules.some(rule => rule.ruleId === "credentials.github-oauth.gl")).toBe(true);
});

test("supplemental assignment rules mask complete synthetic semantic values", () => {
  const registry = createBuiltinGuardrailsRegistry();
  const supplementalOnly = createGuardrailsRegistry({
    disabledBuiltinRuleIds: registry.rules
      .filter(rule => rule.source !== "opencodex")
      .map(rule => rule.ruleId),
  });
  const apiKey = ["SynApi", "9x", "Qp7vLm2"].join("_");
  const password = ["Synthetic", "Pass", "42#"].join("");
  const keyring = JSON.stringify({ primary: ["SynSecret", "8y", "Rt6wQm3"].join("_") });
  const hmac = ["9f4a7c2e1d8b6a3f", "5c0e9d7b4a2c8e6f"].join("");
  const privateKey = `${"Ab9+".repeat(10)}Ab9=`;
  const longPassword = "SyntheticLongPassword".repeat(30);
  const uri = `socks5h://synthetic-user:${password}@192.0.2.10:1080`;
  const uriWithMaskedHost = `socks5h://synthetic-user:${password}@<IPV4_1>`;
  const uriWithMaskedIpv6Host = `socks5h://synthetic-user:${password}@<IPV6_1>:1080/proxy`;
  const uriWithMaximumMaskedHost = `socks5h://synthetic-user:${password}@<${"A".repeat(128)}>`;
  const cases = [
    [`SERVICE_API_KEY=${apiKey}`, apiKey, "OPENCODEX_API_KEY"],
    [`пароль: ${password}`, password, "OPENCODEX_PASSWORD"],
    [`SERVICE_SECRET_KEYS='${keyring}'`, keyring, "OPENCODEX_SECRET"],
    [`- \`HMAC_SIGNING_SECRET=${hmac}\``, hmac, "OPENCODEX_SECRET"],
    [`- Private key: \`${privateKey}\``, privateKey, "OPENCODEX_PRIVATE_KEY"],
    [`PROXY_URL=${uri}`, uri, "OPENCODEX_URL_WITH_CREDS"],
    [`PROXY_URL=${uriWithMaskedHost}`, uriWithMaskedHost, "OPENCODEX_URL_WITH_CREDS"],
    [`Proxy ${uriWithMaskedHost}.`, uriWithMaskedHost, "OPENCODEX_URL_WITH_CREDS"],
    [`Proxy ${uriWithMaskedHost}: continue`, uriWithMaskedHost, "OPENCODEX_URL_WITH_CREDS"],
    [`Proxy ${uriWithMaskedHost}?mode=remote`, uriWithMaskedHost, "OPENCODEX_URL_WITH_CREDS"],
    [`Proxy ${uriWithMaskedHost}#fragment`, uriWithMaskedHost, "OPENCODEX_URL_WITH_CREDS"],
    [`PROXY_URL=${uriWithMaskedIpv6Host}`, uriWithMaskedIpv6Host, "OPENCODEX_URL_WITH_CREDS"],
    [`PROXY_URL=${uriWithMaximumMaskedHost}`, uriWithMaximumMaskedHost, "OPENCODEX_URL_WITH_CREDS"],
    [`API_KEY:\n  ${apiKey}`, apiKey, "OPENCODEX_API_KEY"],
    [`PASSWORD="${longPassword}"`, longPassword, "OPENCODEX_PASSWORD"],
  ] as const;

  for (const [input, value, placeholderType] of cases) {
    const supplementalFindings = scanGuardrailsText(supplementalOnly, input);
    expect(supplementalFindings).toHaveLength(1);
    expect(supplementalFindings[0]).toMatchObject({
      start: input.indexOf(value),
      end: input.indexOf(value) + value.length,
      value,
      placeholderType,
    });
    expect(scanGuardrailsText(registry, input)).toEqual([
      expect.objectContaining({
        start: input.indexOf(value),
        end: input.indexOf(value) + value.length,
        value,
      }),
    ]);
  }
});

test("all 23 confirmed-miss analogs resolve to one complete supplemental finding", () => {
  const registry = createBuiltinGuardrailsRegistry();

  for (const analog of GUARDRAILS_CONFIRMED_MISS_ANALOGS) {
    const findings = scanGuardrailsText(registry, analog.input);
    const matching = findings.filter(finding =>
      finding.value === analog.value
    );
    expect(matching, analog.ruleId).toEqual([
      expect.objectContaining({
        start: analog.input.indexOf(analog.value),
        end: analog.input.indexOf(analog.value) + analog.value.length,
      }),
    ]);
  }
});

test("supplemental assignment rules reject non-secret control fields and public identifiers", () => {
  const registry = createBuiltinGuardrailsRegistry();
  const syntheticPassword = "SyntheticPass42#";
  const publicKey = `${"PublicMaterial".repeat(3)}=`;
  const revision = `${"0123456789abcdef".repeat(2)}01234567`;
  const cases = [
    "TOKEN_PERSISTENT_MODE=enabled",
    "TOKEN_ENABLED=true",
    `PUBLIC_KEY=${publicKey}`,
    "SSH_FINGERPRINT=SHA256:syntheticFingerprintValue",
    `SOURCE_REVISION=${revision}`,
    "PROXY_URL=socks5h://synthetic-host.example:1080",
    "PROXY_URL=socks5h://synthetic-user@<IPV4_1>",
    `PROXY_URL=socks5h://synthetic-user:${syntheticPassword}@<IPV4_1`,
    `PROXY_URL=socks5h://synthetic-user:${syntheticPassword}@<${"A".repeat(129)}>`,
  ];

  for (const input of cases) {
    expect(scanGuardrailsText(registry, input)
      .filter(finding => finding.ruleId.startsWith("opencodex."))).toEqual([]);
  }
});

test("infrastructure URI masking with a placeholder host remains literal and reversible", () => {
  const registry = registryWithOnlyBuiltinRule("opencodex.credentials.infrastructure-uri-userinfo");
  const uri = "socks5h://synthetic-user:SyntheticPass42#@<IPV4_1>";
  const input = `Proxy ${uri}.`;
  const masked = maskGuardrailsText(input, scanGuardrailsText(registry, input));

  expect(masked.maskedText).toBe("Proxy <OPENCODEX_URL_WITH_CREDS_1>.");
  expect(demaskGuardrailsText(masked.maskedText, masked.state)).toBe(input);
});

test("supplemental assignment rules honor data-type and rule toggles", () => {
  const apiKeyInput = "SERVICE_API_KEY=SynApi_9x-Qp7vLm2";
  const disabledType = createGuardrailsRegistry({ enabledDataTypes: [1, 3, 4, 5, 6] });
  const disabledRule = createGuardrailsRegistry({
    disabledBuiltinRuleIds: ["opencodex.api-keys.assignment"],
  });

  expect(scanGuardrailsText(disabledType, apiKeyInput)
    .filter(finding => finding.ruleId === "opencodex.api-keys.assignment")).toEqual([]);
  expect(scanGuardrailsText(disabledRule, apiKeyInput)
    .filter(finding => finding.ruleId === "opencodex.api-keys.assignment")).toEqual([]);
});

test("declarative entropy and banlist constraints normalize into validators once", () => {
  const registry = createBuiltinGuardrailsRegistry();
  const passwordRule = registry.rules.find(rule => rule.ruleId === "credentials.password");
  const entropyRules = registry.rules.filter(rule => rule.entropy !== undefined);
  const banlistRules = registry.rules.filter(rule => rule.banlist.length > 0);

  expect(entropyRules.length).toBeGreaterThan(0);
  expect(banlistRules.length).toBeGreaterThan(0);
  expect(entropyRules.every(rule => rule.validators.filter(item => item === "entropy").length === 1)).toBe(true);
  expect(banlistRules.every(rule => rule.validators.filter(item => item === "banlist").length === 1)).toBe(true);
  expect(passwordRule?.validators).toEqual(expect.arrayContaining(["entropy", "banlist"]));

  const passwordOnly = registryWithOnlyBuiltinRule("credentials.password");
  expect(scanGuardrailsText(passwordOnly, "password=aaaaaaaa")).toEqual([]);
  expect(scanGuardrailsText(passwordOnly, "password=Synthetic!Pass42")).toEqual([
    expect.objectContaining({ ruleId: "credentials.password", value: "Synthetic!Pass42" }),
  ]);
});

test("scanner returns UTF-16 spans for captured values after astral Unicode", () => {
  const registry = registryWithOnlyBuiltinRule("api_keys.stripe-key");
  const value = "sk_live_abcdefghijklmnopqrstuvwx";
  const input = `before 💡 ${value} after`;

  const findings = scanGuardrailsText(registry, input);
  const finding = findings.find(entry => entry.ruleId === "api_keys.stripe-key");

  expect(finding).toBeDefined();
  expect(finding).toMatchObject({
    start: input.indexOf(value),
    end: input.indexOf(value) + value.length,
    value,
    placeholderType: "STRIPE_API_KEY",
  });
});

test("scanner preserves UTF-16 spans across multiple matches separated by astral Unicode", () => {
  const registry = createGuardrailsRegistry({
    customRules: [customRule("(token_[a-z]+)", [1])],
  });
  const input = "😀 token_one 😀 token_two";

  const findings = scanGuardrailsText(registry, input)
    .filter(finding => finding.ruleId === "custom.test");

  expect(findings.map(finding => [finding.start, finding.end, finding.value])).toEqual([
    [input.indexOf("token_one"), input.indexOf("token_one") + "token_one".length, "token_one"],
    [input.indexOf("token_two"), input.indexOf("token_two") + "token_two".length, "token_two"],
  ]);
  registry.dispose();
});

test("scanner fails closed when the selected capture value has an ambiguous offset", () => {
  const registry = createGuardrailsRegistry({
    customRules: [customRule("(secret):(secret)", [2])],
  });

  expect(() => scanGuardrailsText(registry, "secret:secret"))
    .toThrow(GuardrailsMatchAmbiguityError);
  registry.dispose();
});

test("registry rejects a custom rule that references a missing capture group", () => {
  expect(() => createGuardrailsRegistry({
    customRules: [customRule("(secret)", [2])],
  })).toThrow(GuardrailsRuleCompileError);
});

test("RE2 preflight preserves slash, Unicode escape, and named-group translation", () => {
  const registry = createGuardrailsRegistry({
    customRules: [
      customRule("(?<token>foo/\\u0041+)", [1]),
    ],
  });

  expect(scanGuardrailsText(registry, "prefix foo/AAA suffix")
    .filter(item => item.ruleId === "custom.test")
    .map(item => item.value)).toEqual(["foo/AAA"]);
  registry.dispose();
});

test("RE2 preflight rejects invalid syntax and duplicate named groups", () => {
  expect(() => validateGuardrailsCustomRulesCompatibility([
    customRule("(", []),
  ])).toThrow(GuardrailsRuleCompileError);
  expect(() => validateGuardrailsCustomRulesCompatibility([
    customRule("(?<same>a)(?<same>b)", [1]),
  ])).toThrow(GuardrailsRuleCompileError);
});

test("RE2 preflight releases every invalid WASM wrapper deterministically", () => {
  type DeleteMethod = (this: object) => void;
  const prototype = WrappedRE2.prototype as unknown as { delete: DeleteMethod };
  const originalDelete = prototype.delete;
  let deleteCalls = 0;
  prototype.delete = function wrappedDelete(this: object): void {
    deleteCalls += 1;
    originalDelete.call(this);
  };

  try {
    for (let index = 0; index < 32; index += 1) {
      expect(() => validateGuardrailsCustomRulesCompatibility([
        customRule("(", [], `custom.invalid-${index}`),
      ])).toThrow(GuardrailsRuleCompileError);
    }
  } finally {
    prototype.delete = originalDelete;
  }
  expect(deleteCalls).toBe(32);
});

test("keyword prefilter only skips rules with absent keywords", () => {
  const stripeRule = registryWithOnlyBuiltinRule("api_keys.stripe-key").rules[0]!;
  const registry = createGuardrailsRegistry({
    disabledBuiltinRuleIds: createBuiltinGuardrailsRegistry().rules
      .map(rule => rule.ruleId)
      .filter(ruleId => ruleId !== stripeRule.ruleId),
    keywordPrefilterEnabled: true,
  });
  const value = "sk_live_abcdefghijklmnopqrstuvwx";

  expect(scanGuardrailsText(registry, value)).toEqual(expect.arrayContaining([
    expect.objectContaining({ ruleId: "api_keys.stripe-key" }),
  ]));
});

test("keyword prefilter proves only recall-preserving built-in literals", () => {
  expect(provenGuardrailsPrefilterKeywords(
    "(hv[sbr]\\.[a-z0-9]{5})",
    ["vault"],
  )).toEqual([]);
  expect(provenGuardrailsPrefilterKeywords(
    "(?:tokenA|tokenB)-[0-9]+",
    ["token"],
  )).toEqual(["token"]);
  expect(provenGuardrailsPrefilterKeywords(
    "(?:passport|pass\\.?)\\s*(\\d{4})",
    ["passport"],
  )).toEqual([]);
  expect(provenGuardrailsPrefilterKeywords(
    "(?i)ΣΤΑ",
    ["ΣΤΑ"],
  )).toEqual([]);
  expect(provenGuardrailsPrefilterKeywords("\\n", ["n"])).toEqual([]);
  expect(provenGuardrailsPrefilterKeywords("\\t", ["t"])).toEqual([]);
  expect(provenGuardrailsPrefilterKeywords("\\0", ["0"])).toEqual([]);
});

test("keyword prefilter keeps external, alternation, and Unicode-fold matches", () => {
  const cases = [
    {
      ruleId: "prefilter.external",
      regex: "(hv[sbr]\\.[a-z0-9]{5})",
      keywords: ["vault"],
      text: "token=hvs.ab3cd",
    },
    {
      ruleId: "prefilter.alternation",
      regex: "(?:passport|pass\\.?)\\s*(\\d{4})",
      keywords: ["passport"],
      text: "pass. 4509",
    },
    {
      ruleId: "prefilter.unicode",
      regex: "(?i)ΣΤΑ",
      keywords: ["ΣΤΑ"],
      text: "value ςτα here",
    },
    {
      ruleId: "prefilter.control-escape",
      regex: "\\n",
      keywords: ["n"],
      text: "\n",
    },
  ] as const;

  for (const candidate of cases) {
    const registry = registryWithProofRule(
      candidate.regex,
      candidate.keywords,
      candidate.ruleId,
    );
    try {
      expect(registry.rules[0]?.prefilterKeywords).toEqual([]);
      expect(scanGuardrailsText(registry, candidate.text)).toEqual([
        expect.objectContaining({ ruleId: candidate.ruleId }),
      ]);
    } finally {
      registry.dispose();
    }
  }
});

test("custom rules are always scanned even when their literal is provable", () => {
  const rule = {
    ...customRule("secret=([a-z]+)", [1], "custom.prefilter"),
    keywords: ["secret"],
  };
  const registry = createGuardrailsRegistry({
    customRules: [rule],
    keywordPrefilterEnabled: true,
  });
  try {
    expect(registry.rules.find(candidate => candidate.ruleId === rule.ruleId)?.prefilterKeywords).toEqual([]);
    expect(scanGuardrailsText(registry, "secret=value")).toEqual([
      expect.objectContaining({ ruleId: rule.ruleId, value: "value" }),
    ]);
  } finally {
    registry.dispose();
  }
});

test("RE2 preflight rejects malformed control escapes without changing their semantics", () => {
  expect(() => validateGuardrailsCustomRulesCompatibility([
    customRule("\\c1", []),
  ])).toThrow(GuardrailsRuleCompileError);
  expect(() => validateGuardrailsCustomRulesCompatibility([
    customRule("\\ca", []),
  ])).toThrow(GuardrailsRuleCompileError);

  const registry = createGuardrailsRegistry({
    customRules: [customRule("\\cA", [])],
  });
  expect(scanGuardrailsText(registry, "\u0001")).toEqual([
    expect.objectContaining({ ruleId: "custom.test" }),
  ]);
  registry.dispose();
});

test("every built-in validator has positive and negative coverage", () => {
  const cases: Array<{
    bad: string;
    good: string;
    options?: { banlist?: string[]; entropy?: number };
    validators: Parameters<typeof validateGuardrailsCandidate>[1];
  }> = [
    { validators: ["luhn"], good: "4111111111111111", bad: "4111111111111112" },
    { validators: ["snils"], good: "112-233-445 95", bad: "112-233-445 96" },
    { validators: ["inn_person"], good: "500100732259", bad: "500100732258" },
    { validators: ["inn_org"], good: "7707083893", bad: "7707083894" },
    { validators: ["ogrn"], good: "1027700132195", bad: "1027700132196" },
    { validators: ["ogrnip"], good: "304500116000157", bad: "304500116000158" },
    {
      validators: ["iban_mod97"],
      good: "GB82 WEST 1234 5698 7654 32",
      bad: "GB82 WEST 1234 5698 7654 33",
    },
    { validators: ["email_ascii"], good: "test@example.com", bad: "тест@example.com" },
    { validators: ["payment_card"], good: "4111111111111111", bad: "4111111111111112" },
    { validators: ["payment_card_no_luhn"], good: "4111111111111112", bad: "123" },
    {
      validators: ["entropy"],
      good: "aB3$xY9!",
      bad: "aaaaaaaa",
      options: { entropy: 2.5 },
    },
    {
      validators: ["banlist"],
      good: "allowed",
      bad: "blocked",
      options: { banlist: ["blocked"] },
    },
    { validators: ["ip_v4", "ip_private"], good: "127.0.0.1", bad: "8.8.8.8" },
    { validators: ["ip_v6", "ip_private"], good: "::ffff:127.0.0.1", bad: "127.0.0.1" },
    { validators: ["ip_public"], good: "::ffff:8.8.8.8", bad: "::ffff:127.0.0.1" },
    { validators: ["ip_private"], good: "::ffff:127.0.0.1", bad: "::ffff:8.8.8.8" },
  ];
  for (const candidate of cases) {
    expect(validateGuardrailsCandidate(candidate.good, candidate.validators, candidate.options)).toBe(true);
    expect(validateGuardrailsCandidate(candidate.bad, candidate.validators, candidate.options)).toBe(false);
  }
});

test("scanner admits an exact 128 KiB leaf and rejects one byte more before RE2", () => {
  const emptyRegistry: GuardrailsRegistry = {
    rules: [],
    groups: [],
    keywordPrefilterEnabled: false,
    dispose() {},
  };
  expect(scanGuardrailsText(emptyRegistry, "x".repeat(MAX_GUARDRAILS_SCANNABLE_LEAF_BYTES))).toEqual([]);
  expect(() => scanGuardrailsText(
    emptyRegistry,
    "x".repeat(MAX_GUARDRAILS_SCANNABLE_LEAF_BYTES + 1),
  )).toThrow("Guardrails text field exceeds the maximum scannable leaf size");
});

test("scanner rejects regex work atomically before entering RE2", () => {
  const registry = registryWithOnlyBuiltinRule("api_keys.stripe-key");
  const budget = createGuardrailsScanBudget();
  budget.regexInputBytes = MAX_GUARDRAILS_REGEX_INPUT_BYTES - 1;

  expect(() => scanGuardrailsText(registry, "xx", budget))
    .toThrow("Guardrails logical turn exceeded the maximum regex work budget");
  expect(budget.regexInputBytes).toBe(MAX_GUARDRAILS_REGEX_INPUT_BYTES - 1);
});
