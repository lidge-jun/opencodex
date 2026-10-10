import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as snapshot from "../../src/providers/quota-decision-snapshot";
import { getCodexAccountCredential, loadCodexAccountRecordSnapshot, saveCodexAccountCredential } from "../../src/codex/account-store";
import { getMainAccountCredentialPresence, setMainAccountCredentialPresence } from "../../src/codex/main-account-cache";
import { createTempHome, type TempHome } from "../helpers/temp-home";

let home: TempHome;
let publish: ReturnType<typeof spyOn> | undefined;
beforeEach(() => { home = createTempHome("ocx-codex-quota-iso-"); snapshot.publishDecisionQuotaRoster("codex", []); });
afterEach(() => { publish?.mockRestore(); publish = undefined; home.remove(); });
const credential = { accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: 2_000_000_000_000, chatgptAccountId: "fixture-account" };
const accountFiles = () => readdirSync(home.configDir).filter(name => name.startsWith("codex-accounts"));
const failPublication = () => spyOn(snapshot, "publishDecisionQuotaRoster").mockImplementation(() => { throw new Error("injected publication failure"); });

test("a throwing quota publication neither empties a loaded Codex store nor backs the file up", () => {
  saveCodexAccountCredential("a1", credential);
  const before = JSON.stringify(loadCodexAccountRecordSnapshot());
  const bytes = readFileSync(join(home.configDir, "codex-accounts.json"), "utf-8");
  const files = accountFiles();
  publish = failPublication();
  expect(() => loadCodexAccountRecordSnapshot()).not.toThrow();
  expect(JSON.stringify(loadCodexAccountRecordSnapshot())).toBe(before);
  expect(getCodexAccountCredential("a1")?.accessToken).toBe("fixture-access");
  expect(accountFiles()).toEqual(files);
  expect(readFileSync(join(home.configDir, "codex-accounts.json"), "utf-8")).toBe(bytes);
  expect(publish).toHaveBeenCalled();
});

test("a throwing quota publication does not fail or undo Codex persistence, and withdraws the roster", () => {
  saveCodexAccountCredential("a1", credential);
  expect(snapshot.readLoadedDecisionQuotaPool("codex")).toHaveLength(1);
  publish = failPublication();
  expect(() => saveCodexAccountCredential("a1", { ...credential, accessToken: "replacement" })).not.toThrow();
  expect(snapshot.readLoadedDecisionQuotaPool("codex")).toBeUndefined();
  publish.mockRestore(); publish = undefined;
  expect(getCodexAccountCredential("a1")?.accessToken).toBe("replacement");
});

test("a throwing quota publication does not break main-credential presence transitions, and withdraws the main roster", () => {
  setMainAccountCredentialPresence(true);
  expect(snapshot.readLoadedDecisionQuotaPool("codex-main")).toHaveLength(1);
  publish = failPublication();
  expect(() => setMainAccountCredentialPresence(false)).not.toThrow();
  expect(getMainAccountCredentialPresence()).toBe(false);
  expect(snapshot.readLoadedDecisionQuotaPool("codex-main")).toBeUndefined();
});
