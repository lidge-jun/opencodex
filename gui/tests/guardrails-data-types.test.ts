import { expect, test } from "bun:test";
import { DICTS, LOCALES, type TKey } from "../src/i18n/shared";
import {
  GUARDRAILS_DATA_TYPES,
  GUARDRAILS_DATA_TYPE_KEYS,
} from "../src/pages/guardrails/constants";
import type { GuardrailsDataType } from "../src/pages/guardrails/types";

const EXPECTED_DATA_TYPES = [
  { id: 1, key: "guardrails.dataType.credentials", label: "Credentials" },
  { id: 2, key: "guardrails.dataType.apiKeys", label: "API keys" },
  { id: 3, key: "guardrails.dataType.accessTokens", label: "Access tokens" },
  { id: 4, key: "guardrails.dataType.ipAddresses", label: "IP addresses" },
  { id: 5, key: "guardrails.dataType.personal", label: "Personal data" },
  { id: 6, key: "guardrails.dataType.custom", label: "Custom" },
] as const satisfies readonly {
  id: GuardrailsDataType;
  key: TKey;
  label: string;
}[];

test("pins Guardrails numeric data types to their canonical labels", () => {
  expect(GUARDRAILS_DATA_TYPES).toEqual(
    EXPECTED_DATA_TYPES.map(({ id }) => id),
  );
  expect(
    EXPECTED_DATA_TYPES.map(({ id }) => {
      const key = GUARDRAILS_DATA_TYPE_KEYS[id];
      return { id, key, label: DICTS.en[key] };
    }),
  ).toEqual(EXPECTED_DATA_TYPES);
});

test("every locale provides all canonical Guardrails data type labels", () => {
  for (const { code } of LOCALES) {
    const labels = GUARDRAILS_DATA_TYPES.map(
      dataType => DICTS[code][GUARDRAILS_DATA_TYPE_KEYS[dataType]],
    );

    expect(labels.every(label => label.trim().length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(GUARDRAILS_DATA_TYPES.length);
  }
});

test("canonical configuration reference uses the runtime data-type mapping", async () => {
  const reference = await Bun.file(new URL(
    "../../docs-site/src/content/docs/reference/configuration.md",
    import.meta.url,
  )).text();

  for (const { id, label } of EXPECTED_DATA_TYPES) {
    expect(reference).toContain(`| \`${id}\` | ${label} |`);
  }
});
