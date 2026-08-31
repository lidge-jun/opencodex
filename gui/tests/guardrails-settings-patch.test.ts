import { expect, test } from "bun:test";
import {
  updateGuardrailsSettings,
} from "../src/pages/guardrails/guardrails-api";
import {
  GUARDRAILS_MUTABLE_SETTING_KEYS,
  type GuardrailsSettingsPatch,
} from "../src/pages/guardrails/types";

const validPatch: GuardrailsSettingsPatch = {
  enabled: true,
  mode: "enforce",
  failurePolicy: "block",
  providerScope: { mode: "all" },
  enabledDataTypes: [1, 2, 3, 4, 5, 6],
  disabledBuiltinRuleIds: [],
  keywordPrefilterEnabled: false,
};

function responseOnlyFieldsRemainRejected(): void {
  // @ts-expect-error revision is response metadata, not a mutable setting.
  const revision: GuardrailsSettingsPatch = { revision: "rev-1" };
  // @ts-expect-error activation is response metadata, not a mutable setting.
  const activation: GuardrailsSettingsPatch = { activation: { status: "active" } };
  // @ts-expect-error configuredEnabled is a normalized response field.
  const configured: GuardrailsSettingsPatch = { configuredEnabled: true };
  // @ts-expect-error customRuleCount is derived response metadata.
  const customRules: GuardrailsSettingsPatch = { customRuleCount: 1 };
  // @ts-expect-error providerOptions is derived response metadata.
  const providerOptions: GuardrailsSettingsPatch = { providerOptions: [] };
  void [revision, activation, configured, customRules, providerOptions];
}

void responseOnlyFieldsRemainRejected;

test("GuardrailsSettingsPatch contains only mutable settings", () => {
  expect([...GUARDRAILS_MUTABLE_SETTING_KEYS].sort()).toEqual([
    "disabledBuiltinRuleIds",
    "enabled",
    "enabledDataTypes",
    "failurePolicy",
    "keywordPrefilterEnabled",
    "mode",
    "providerScope",
  ]);
  expect(Object.keys(validPatch).sort()).toEqual(
    [...GUARDRAILS_MUTABLE_SETTING_KEYS].sort(),
  );
});

test("settings mutation serializes only mutable keys from widened objects", async () => {
  let sent: unknown;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    sent = JSON.parse(String(init?.body)) as unknown;
    return Response.json({
      activation: { status: "active" },
      configuredEnabled: true,
      customRuleCount: 0,
      disabledBuiltinRuleIds: [],
      enabled: true,
      enabledDataTypes: [1, 2, 3, 4, 5, 6],
      failurePolicy: "block",
      keywordPrefilterEnabled: false,
      mode: "enforce",
      providerOptions: [],
      providerScope: { mode: "all" },
      revision: "rev-2",
    });
  };
  try {
    const widened: GuardrailsSettingsPatch & {
      activation: { status: "active" };
      revision: string;
    } = {
      enabled: true,
      activation: { status: "active" },
      revision: "rev-1",
    };
    await updateGuardrailsSettings("/api", widened, "rev-1", "failed");
    expect(sent).toEqual({ enabled: true });
  } finally {
    globalThis.fetch = previousFetch;
  }
});
