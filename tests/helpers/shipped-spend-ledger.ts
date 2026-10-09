import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fixturePath, repoPath } from "./repo-root";
import { DEFAULT_SPEND_RESERVATION_POLICY, type SpendJournal, type SpendReservationPolicy } from "../../src/lib/spend-reservation-ledger";

// Freeze the complete shipped module; adapt relative imports only, never accounting code.
const source = readFileSync(fixturePath("spend-ledger-2-80-0.ts.txt"), "utf8");
if (createHash("sha256").update(source).digest("hex") !== "fccd58e3e70fde8c4e0b0df919b0718659f5e18893934583cd65338fedaf5b0e") {
  throw new Error("Shipped spend-ledger fixture changed");
}
const adapted = source.replace(/from "(\.[^"]+)"/g, (_, specifier: string) =>
  `from ${JSON.stringify(pathToFileURL(resolve(repoPath("src/lib"), specifier + ".ts")).href)}`);
const code = new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(adapted);
type ShippedModule = Pick<typeof import("../../src/lib/spend-reservation-ledger"), "createSpendReservationLedger" | "parseSpendJournalRecord" | "DEFAULT_SPEND_RESERVATION_POLICY">;
const shipped = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`) as ShippedModule;
export const loadShippedSpendLedger = (): ShippedModule => shipped;
export const createShippedSpendLedger = shipped.createSpendReservationLedger;
export const testSpendSalt = "5".repeat(64);
// Independent oracle for the specified salt/NUL/domain wire contract.
export const spendAlias = (kind: string, id: string): string => createHash("sha256")
  .update(testSpendSalt + "\0" + kind + "\0" + id).digest("hex").slice(0, 32);
export const spendTestPolicy = (overrides: Partial<SpendReservationPolicy> = {}): SpendReservationPolicy => ({
  ...DEFAULT_SPEND_RESERVATION_POLICY, pool: { maxTokens: 100 }, ...overrides,
});
export function spendTestJournal(records: unknown[] = []): SpendJournal & { lines: string[]; failAppend: boolean; failRewrite: boolean } {
  const lines = records.map(record => typeof record === "string" ? record : JSON.stringify(record));
  return { lines, failAppend: false, failRewrite: false, read() { return [...lines]; },
    append(line) { if (this.failAppend) throw new Error("append unavailable"); lines.push(line); },
    rewrite(next) { if (this.failRewrite) throw new Error("rewrite unavailable"); lines.splice(0, lines.length, ...next); } };
}
export const spendCheckpoint = (entries: Array<[string, number, number]>, seenAt = 1) => ({
  v: 1, kind: "checkpoint", at: seenAt,
  scopes: entries.map(([id, settled, unresolved]) => ({ scope: "pool", alias: spendAlias("pool", id), settled, unresolved, seenAt })), sends: [],
});
