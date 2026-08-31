import type { TKey } from "../../i18n/shared";
import type { GuardrailsDataType } from "./types";

export const GUARDRAILS_DATA_TYPES: readonly GuardrailsDataType[] = [1, 2, 3, 4, 5, 6];
export const GUARDRAILS_IMPORT_MAX_BYTES = 4 * 1024 * 1024;

export const GUARDRAILS_VALIDATORS = [
  "luhn",
  "snils",
  "inn_person",
  "inn_org",
  "ogrn",
  "ogrnip",
  "iban_mod97",
  "email_ascii",
  "payment_card",
  "payment_card_no_luhn",
  "entropy",
  "banlist",
  "ip_v4",
  "ip_v6",
  "ip_public",
  "ip_private",
] as const;

export const GUARDRAILS_DATA_TYPE_KEYS: Record<GuardrailsDataType, TKey> = {
  1: "guardrails.dataType.credentials",
  2: "guardrails.dataType.apiKeys",
  3: "guardrails.dataType.accessTokens",
  4: "guardrails.dataType.ipAddresses",
  5: "guardrails.dataType.personal",
  6: "guardrails.dataType.custom",
};
