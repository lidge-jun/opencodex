import { Database } from "bun:sqlite";
import { join } from "node:path";
import { codexConversationKeyFor, recordCodexThreadLineage } from "../../src/codex/lineage";
import { acquireSpendLedgerOwner } from "../../src/lib/spend-ledger-owner";
import { bindThreadAffinity, getThreadAffinity } from "../../src/codex/routing/thread-affinity";
import { resolveCodexAccountForThread } from "../../src/codex/routing";
import type { OcxConfig } from "../../src/types";

const homeA = process.env.OPENCODEX_HOME!;
const homeB = process.argv[2]!;
const config = { providers: {}, codexAccounts: ["a", "b"].map(id => ({ id, email: `${id}@test`, isMain: false })), activeCodexAccountId: "a", accountPoolStrategy: "round-robin" } as OcxConfig;
let lease = acquireSpendLedgerOwner();
const oldHeaders = new Headers({ "thread-id": "old-thread", "x-codex-parent-thread-id": "old-family" });
const oldKey = recordCodexThreadLineage(oldHeaders)!.conversationKey;
bindThreadAffinity(oldKey, "a", Date.now()); // deliberately unflushed
process.env.OPENCODEX_HOME = homeB;
const freshKey = codexConversationKeyFor("new-family", "new-thread"); // retires A while its write is pending
lease.release();
lease = acquireSpendLedgerOwner();
// Derive again under B's owner, then route B's first request.
codexConversationKeyFor("new-family", "new-thread");
const first = resolveCodexAccountForThread(freshKey, config);
bindThreadAffinity(oldKey, "b", Date.now()); // no anchor for A's key in B
lease.release();
const dbB = new Database(join(homeB, "codex-affinity.sqlite"));
const rowsB = (dbB.query("SELECT count(*) AS n FROM threads").get() as { n: number }).n;
dbB.close();
process.env.OPENCODEX_HOME = homeA;
codexConversationKeyFor("switch", "switch");
process.env.OPENCODEX_HOME = homeB;
lease = acquireSpendLedgerOwner();
const restoredB = getThreadAffinity(codexConversationKeyFor("new-family", "new-thread"))?.accountId;
const oldInB = getThreadAffinity(recordCodexThreadLineage(oldHeaders)!.conversationKey)?.accountId;
lease.release();
process.env.OPENCODEX_HOME = homeA;
lease = acquireSpendLedgerOwner();
const oldInA = getThreadAffinity(recordCodexThreadLineage(oldHeaders)!.conversationKey)?.accountId;
const newInA = getThreadAffinity(codexConversationKeyFor("new-family", "new-thread"))?.accountId;
lease.release();
console.log(JSON.stringify({ first, rowsB, restoredB, oldInB, oldInA, newInA }));
