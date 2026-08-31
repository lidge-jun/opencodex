import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DICTS,
  I18nContext,
  interpolate,
  type TFn,
} from "../src/i18n/shared";
import { GuardrailsStatusBadges } from "../src/pages/guardrails/status-badges";
import type {
  GuardrailsMode,
  GuardrailsOverview,
} from "../src/pages/guardrails/types";

const t: TFn = (key, vars) => interpolate(DICTS.en[key], vars);

function overviewFixture({
  enabled = true,
  mode = "enforce",
  registryStatus = "ready",
  effectiveRuleCount = 266,
  enabledDataTypes = [1, 2, 3, 4, 5, 6],
  keywordPrefilterEnabled = false,
  disabledBuiltinRuleIds = [],
  providerScope = { mode: "all" },
  configuredEnabled = enabled,
}: {
  enabled?: boolean;
  mode?: GuardrailsMode;
  registryStatus?: GuardrailsOverview["registry"]["status"];
  effectiveRuleCount?: number;
  enabledDataTypes?: GuardrailsOverview["enabledDataTypes"];
  keywordPrefilterEnabled?: boolean;
  disabledBuiltinRuleIds?: string[];
  providerScope?: GuardrailsOverview["providerScope"];
  configuredEnabled?: boolean;
} = {}): GuardrailsOverview {
  return {
    activation: { status: enabled ? "active" : "disabled" },
    configuredEnabled,
    customRuleCount: 0,
    disabledBuiltinRuleIds,
    enabled,
    enabledDataTypes,
    failurePolicy: "block",
    keywordPrefilterEnabled,
    mode,
    providerOptions: [
      { id: "openai", kind: "configured", configured: true, disabled: false },
    ],
    providerScope,
    revision: "rev-1",
    registry: {
      status: registryStatus,
      generation: registryStatus === "ready" ? 1 : null,
      policyRevision: "policy-1",
      effectiveRuleCount,
    },
    ruleSummary: { total: 266, builtin: 266, custom: 0 },
    overview: {
      counters: {
        scanned: 0,
        masked: 0,
        detected: 0,
        blocked: 0,
        passthrough: 0,
        demaskWarning: 0,
        toolArgumentRestoreSkipped: 0,
      },
      topRules: [],
      topCategories: [],
      recentEvents: [],
      lastPassthroughAt: null,
      retention: {
        kind: "in-memory",
        ttlMs: 3_600_000,
        maxEvents: 1_000,
        maxBytes: 2_097_152,
        currentEvents: 0,
        currentBytes: 0,
        evictedEvents: 0,
        oldestAt: null,
        lastEventAt: null,
      },
    },
  };
}

test("Guardrails status reports actual traffic protection instead of configured enabled", () => {
  const cases = [
    {
      overview: overviewFixture(),
      label: "Protected",
      className: "badge-green",
    },
    {
      overview: overviewFixture({ mode: "detect" }),
      label: "Detect only",
      className: "badge-amber",
    },
    {
      overview: overviewFixture({ enabledDataTypes: [1, 2, 3, 4, 5] }),
      label: "Reduced coverage",
      className: "badge-amber",
    },
    {
      overview: overviewFixture({ keywordPrefilterEnabled: true }),
      label: "Protected",
      className: "badge-green",
    },
    {
      overview: overviewFixture({
        providerScope: { mode: "selected", providerIds: ["openai"] },
      }),
      label: "Reduced coverage",
      className: "badge-amber",
    },
    {
      overview: overviewFixture({
        providerScope: { mode: "selected", providerIds: ["removed-provider"] },
      }),
      label: "No providers protected",
      className: "badge-amber",
    },
    {
      overview: overviewFixture({ disabledBuiltinRuleIds: ["api_keys.stripe-key"] }),
      label: "Reduced coverage",
      className: "badge-amber",
    },
    {
      overview: overviewFixture({ registryStatus: "failed", effectiveRuleCount: 0 }),
      label: "Registry unavailable",
      className: "badge-amber",
    },
    {
      overview: overviewFixture({ effectiveRuleCount: 0 }),
      label: "No active rules",
      className: "badge-amber",
    },
    {
      overview: overviewFixture({
        enabled: false,
        configuredEnabled: true,
        registryStatus: "failed",
        effectiveRuleCount: 0,
      }),
      label: "Registry unavailable",
      className: "badge-amber",
    },
    {
      overview: overviewFixture({
        enabled: false,
        registryStatus: "disabled",
        effectiveRuleCount: 0,
      }),
      label: "Disabled",
      className: "badge-muted",
    },
  ] as const;

  for (const fixture of cases) {
    const markup = renderToStaticMarkup(
      createElement(
        I18nContext.Provider,
        { value: { locale: "en", setLocale: () => {}, t } },
        createElement(GuardrailsStatusBadges, { overview: fixture.overview }),
      ),
    );
    expect(markup).toContain(fixture.className);
    expect(markup).toContain(`>${fixture.label}</span>`);
  }
});
