import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fixturePath } from "./repo-root";
import { DEFAULT_SPEND_RESERVATION_POLICY, type SpendJournal, type SpendReservationLedger, type SpendReservationPolicy } from "../../src/lib/spend-reservation-ledger";

/** Execute immutable pre-continuity production code, with only its ordinary imports supplied. */
const source = readFileSync(fixturePath("spend-ledger-f7a50dc3.ts.txt"), "utf8");
const code = new Bun.Transpiler({ loader: "ts", target: "bun" })
  .transformSync(source.replaceAll("export function", "function"));
export const createLegacySpendLedger = new Function(
  "createHash", "DEFAULT_SPEND_RESERVATION_POLICY", "DEFAULT_MAX_TRACKED_SCOPES",
  "DEFAULT_MAX_TRACKED_SENDS", "DEFAULT_COMPACT_AFTER_RECORDS", "SpendLedgerOwnerError",
  `${code}\nreturn createSpendReservationLedger;`,
)(createHash, DEFAULT_SPEND_RESERVATION_POLICY, 4_096, 16_384, 8_192, class SpendLedgerOwnerError extends Error {}) as
  (options: { journal: SpendJournal; salt?: string; policy: SpendReservationPolicy; now: () => number }) =>
    Pick<SpendReservationLedger, "reserve" | "settle" | "snapshot" | "corruptRecords">;
