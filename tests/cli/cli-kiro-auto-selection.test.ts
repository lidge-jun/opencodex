import { expect, test } from "bun:test";
import { fetchRows, type AccountDeps } from "../../src/cli/account-api";
import { cmdAccount, formatAccountTable } from "../../src/cli/account";

function deps(accounts: unknown[]): AccountDeps {
  return {
    baseUrl: "http://127.0.0.1:10100",
    loadConfigImpl: () => ({ providers: { kiro: { adapter: "kiro", authMode: "oauth" } } }) as never,
    fetchImpl: (async () => new Response(JSON.stringify({ activeAccountId: "a", accounts }),
      { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
  };
}

test("Kiro list prints a closed reason and carries it in JSON", async () => {
  const d = deps([{ id: "a", active: true, autoSelectable: false, skipReason: "suspended" }]);
  const result = await fetchRows(d, d.baseUrl!, "kiro", "oauth");
  expect(result.rows[0]).toMatchObject({ autoSelectable: false, skipReason: "suspended" });
  expect(formatAccountTable(result.rows)).toContain("not-auto-selected(suspended)");
  const output: string[] = [];
  const old = console.log;
  console.log = (...parts: unknown[]) => output.push(parts.map(String).join(" "));
  try {
    expect(await cmdAccount(["list", "kiro", "--json"], d)).toBe(0);
  } finally { console.log = old; }
  expect(JSON.parse(output.join("\n")).accounts[0]).toMatchObject({
    autoSelectable: false, skipReason: "suspended",
  });
});

test("older or malformed reason degrades without emitting upstream text", async () => {
  const result = await fetchRows(deps([
    { id: "a", autoSelectable: false, skipReason: "upstream secret" },
    { id: "b", skipReason: "suspended" },
  ]), "http://127.0.0.1:10100", "kiro", "oauth");
  expect(result.rows[0]).toMatchObject({ autoSelectable: false });
  expect(result.rows[0]!.skipReason).toBeUndefined();
  expect(result.rows[1]!.autoSelectable).toBeUndefined();
  expect(formatAccountTable(result.rows)).toContain("not-auto-selected");
  expect(formatAccountTable(result.rows)).not.toContain("upstream secret");
});

test("non-Kiro account text retains its old shape", async () => {
  const result = await fetchRows(deps([{ id: "a", autoSelectable: false,
    skipReason: "cooldown" }]), "http://127.0.0.1:10100", "xai", "oauth");
  expect(result.rows[0]!.autoSelectable).toBeUndefined();
  expect(result.rows[0]!.skipReason).toBeUndefined();
  expect(formatAccountTable(result.rows)).not.toContain("not-auto-selected");
});

test("a paused generic OAuth account is listed as paused in text and JSON", async () => {
  const result = await fetchRows(deps([
    { id: "a", active: true, paused: false },
    { id: "b", active: false, paused: true },
  ]), "http://127.0.0.1:10100", "google-antigravity", "oauth");
  expect(result.rows[0]!.paused).toBeUndefined();
  expect(result.rows[1]!.paused).toBe(true);
  const table = formatAccountTable(result.rows);
  expect(table.split("\n").filter(line => line.includes("paused"))).toHaveLength(1);
});

test("a paused Kiro account names the pause once instead of repeating it as a skip reason", async () => {
  const result = await fetchRows(deps([{ id: "a", active: false, paused: true, autoSelectable: false,
    skipReason: "paused" }]), "http://127.0.0.1:10100", "kiro", "oauth");
  expect(result.rows[0]).toMatchObject({ paused: true, autoSelectable: false, skipReason: "paused" });
  const table = formatAccountTable(result.rows);
  expect(table).toContain("paused");
  expect(table).not.toContain("not-auto-selected(paused)");
});
