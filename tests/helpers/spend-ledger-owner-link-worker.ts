import { acquireSpendLedgerOwner, SpendLedgerOwnerError } from "../../src/lib/spend-ledger-owner";

// Acquire the owner for argv[2] in a fresh process, so a --preload can change how files are created
// before the owner module binds its imports. Prints the outcome code.
try {
  acquireSpendLedgerOwner(process.argv[2]!).release();
  console.log(JSON.stringify({ code: "acquired" }));
} catch (error) {
  console.log(JSON.stringify({ code: error instanceof SpendLedgerOwnerError ? error.code : "other" }));
}
