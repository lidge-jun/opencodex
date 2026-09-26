import { expect, test } from "bun:test";
import {
  oauthAccountDisplayLabel,
  oauthAccountSecondaryIdentity,
} from "../src/provider-workspace/auth";
import type { TFn } from "../src/i18n/shared";

const t = ((key: string, vars?: Record<string, string | number>) => {
  if (key === "prov.accountId") return "ID";
  if (key === "pws.accountOrdinal") return `Account ${vars?.count ?? "1"}`;
  return key;
}) as TFn;

test("OAuth account identity does not repeat an email when there is no alias", () => {
  const account = { id: "account-1234", email: "user@example.test" };
  expect(oauthAccountDisplayLabel([account], account, t)).toBe("user@example.test");
  expect(oauthAccountSecondaryIdentity(account, "account-…1234", t)).toBe("ID: account-…1234");
});

test("OAuth account identity keeps the email below an explicit alias", () => {
  const account = { id: "account-1234", email: "user@example.test", alias: "Work" };
  expect(oauthAccountDisplayLabel([account], account, t)).toBe("Work");
  expect(oauthAccountSecondaryIdentity(account, "account-…1234", t)).toBe(
    "user@example.test · ID: account-…1234",
  );
});
