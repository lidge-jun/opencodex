import { acquireSpendLedgerOwner } from "../../src/lib/spend-ledger-owner";
import { readCodexAccountRecord, saveCodexAccountCredential } from "../../src/codex/account-store";
import { codexPoolAffinityKey } from "../../src/codex/auth-context";
import { resolveCodexAccountForThread, rememberConversationStateIssuer, peekConversationStateIssuer } from "../../src/codex/routing";
import { applyAccountChangeConversationStateScrub, accountChangeFileReferenceRefusal } from "../../src/server/responses/account-change-state";
import type { OcxConfig } from "../../src/types";

const action = process.argv[2];
if (action === "touch-unknown" || action === "read-unknown") {
  const realNow = Date.now;
  Date.now = () => realNow() + (action === "touch-unknown" ? 23 : 25) * 60 * 60_000;
}
const lease = acquireSpendLedgerOwner();
for (const id of ["a", "b"]) if (!readCodexAccountRecord(id)) saveCodexAccountCredential(id, {
  accessToken: `access-${id}`, refreshToken: `refresh-${id}`, expiresAt: Date.now() + 600_000, chatgptAccountId: `acct-${id}`,
});
const config = { providers: {}, codexAccounts: ["a", "b"].map(id => ({ id, email: `${id}@test`, isMain: false })), activeCodexAccountId: "a", accountPoolStrategy: "round-robin", autoSwitchThreshold: 80, upstreamFailoverThreshold: 3 } as OcxConfig;
if (process.argv[2] === "read") resolveCodexAccountForThread("advance-cursor", config);
const key = codexPoolAffinityKey(new Headers({ "session-id": "restart-session", "thread-id": "restart-thread" }))!;
const issuer = peekConversationStateIssuer(key);
if (action === "touch-unknown" || action === "read-unknown") {
  lease.release();
  console.log(JSON.stringify({ issuer }));
  process.exit(0);
}
const account = resolveCodexAccountForThread(key, config)!;
const sameBody = { previous_response_id: "previous" };
const otherBody = { previous_response_id: "previous" };
const sameScrub = applyAccountChangeConversationStateScrub({ body: sameBody, bindingKey: key, servingAccountId: account });
const otherScrub = applyAccountChangeConversationStateScrub({ body: otherBody, bindingKey: key, servingAccountId: account === "a" ? "b" : "a" });
const fileBody = { previous_response_id: "previous", input: [{ type: "input_file", file_id: "file-test" }] };
const fileRefusal = accountChangeFileReferenceRefusal({ body: fileBody, bindingKey: key, servingAccountId: account })?.status;
const otherFileRefusal = accountChangeFileReferenceRefusal({ body: fileBody, bindingKey: key, servingAccountId: account === "a" ? "b" : "a" })?.status;
const retryRefusal = accountChangeFileReferenceRefusal({ body: fileBody, bindingKey: key, servingAccountId: account, priorAccountId: account === "a" ? "b" : "a" })?.status;
const record = readCodexAccountRecord(account)!;
rememberConversationStateIssuer(key, account, undefined, process.argv[2] === "unknown-write" ? undefined : { generation: record.generation, chatgptAccountId: record.credential!.chatgptAccountId });
if (process.argv[2] === "relogin") saveCodexAccountCredential(account, {
  accessToken: "new-access", refreshToken: "new-refresh", expiresAt: Date.now() + 600_000, chatgptAccountId: "new-identity",
});
if (process.argv[2] === "crash") {
  const store = await import("../../src/codex/routing/thread-affinity-store").catch(() => undefined);
  store?.flushCodexAffinityStoreForTests();
  process.kill(process.pid, "SIGKILL");
}
lease.release();
console.log(JSON.stringify({ account, issuer, sameScrub, otherScrub, fileRefusal, otherFileRefusal, retryRefusal }));
