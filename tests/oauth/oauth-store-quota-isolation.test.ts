import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as snapshot from "../../src/providers/quota-decision-snapshot";
import { getAccountSet, loadAuthStore, saveCredential } from "../../src/oauth/store";
import { createTempHome, type TempHome } from "../helpers/temp-home";

let home: TempHome;
let publish: ReturnType<typeof spyOn> | undefined;
beforeEach(() => { home = createTempHome("ocx-auth-quota-iso-"); snapshot.publishDecisionQuotaRoster("anthropic", []); });
afterEach(() => { publish?.mockRestore(); publish = undefined; home.remove(); });
const credential = { access: "fixture-access", refresh: "fixture-refresh", expires: 2_000_000_000_000 };
const authFiles = () => readdirSync(home.configDir).filter(name => name.startsWith("auth"));

test("a throwing quota publication neither empties a loaded auth store nor backs the file up", async () => {
  await saveCredential("anthropic", credential);
  const before = JSON.stringify(loadAuthStore());
  const bytes = readFileSync(join(home.configDir, "auth.json"), "utf-8");
  const files = authFiles();
  publish = spyOn(snapshot, "publishDecisionQuotaRoster").mockImplementation(() => { throw new Error("injected publication failure"); });
  expect(JSON.stringify(loadAuthStore())).toBe(before);
  expect(loadAuthStore().anthropic?.accounts).toHaveLength(1);
  expect(authFiles()).toEqual(files);
  expect(readFileSync(join(home.configDir, "auth.json"), "utf-8")).toBe(bytes);
  expect(publish).toHaveBeenCalled();
});

test("a throwing quota publication does not fail or undo auth persistence, and withdraws the roster", async () => {
  await saveCredential("anthropic", credential);
  expect(snapshot.readLoadedDecisionQuotaPool("anthropic")).toHaveLength(1);
  publish = spyOn(snapshot, "publishDecisionQuotaRoster").mockImplementation(() => { throw new Error("injected publication failure"); });
  await saveCredential("anthropic", { ...credential, access: "replacement" });
  expect(snapshot.readLoadedDecisionQuotaPool("anthropic")).toBeUndefined();
  publish.mockRestore(); publish = undefined;
  expect(getAccountSet("anthropic")?.accounts[0]?.credential.access).toBe("replacement");
});
