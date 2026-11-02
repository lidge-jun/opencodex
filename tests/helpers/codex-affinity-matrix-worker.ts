import { Database } from "bun:sqlite";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { acquireSpendLedgerOwner, assertStorageOwned, mintSpendLedgerStorage } from "../../src/lib/spend-ledger-owner";
import { readCodexAccountRecord, removeCodexAccountCredential, saveCodexAccountCredential, saveCodexAccountCredentialIfGeneration } from "../../src/codex/account-store";
import { codexPoolAffinityKey } from "../../src/codex/auth-context";
import { recordCodexThreadLineage } from "../../src/codex/lineage";
import { runPassiveRead } from "../../src/lib/passive-read";
import { recordCodexUpstreamOutcome, resolveCodexAccountForThread } from "../../src/codex/routing";
import { bindThreadAffinity, clearConversationStateIssuerMap, clearThreadAccountMap, clearThreadAccountMapForAccount, deleteThreadAffinity, deleteThreadAffinitiesForAccount, getThreadAffinity, handOffThreadAffinityGeneration, peekConversationStateIssuer, rememberConversationStateIssuer } from "../../src/codex/routing/thread-affinity";
import type { OcxConfig } from "../../src/types";

const action = process.argv[2]!;
const lease = acquireSpendLedgerOwner();
const config = { providers: {}, codexAccounts: ["a", "b"].map(id => ({ id, email: `${id}@test`, isMain: false })), activeCodexAccountId: "a", accountPoolStrategy: "round-robin", autoSwitchThreshold: 80, upstreamFailoverThreshold: 3 } as OcxConfig;
if (action === "passive") {
  const file = join(process.env.OPENCODEX_HOME!, "codex-affinity.sqlite");
  const before = readFileSync(file);
  await runPassiveRead(async () => {
    const passiveKey = codexPoolAffinityKey(new Headers({ "session-id": "restart-session", "thread-id": "restart-thread" }))!;
    getThreadAffinity(passiveKey);
    peekConversationStateIssuer(passiveKey);
    clearThreadAccountMap();
  });
  lease.release();
  console.log(JSON.stringify({ unchanged: before.equals(readFileSync(file)) }));
  process.exit(0);
}
const key = codexPoolAffinityKey(new Headers({ "session-id": "restart-session", "thread-id": "restart-thread" }))!;
const cred = (id: string) => ({ accessToken: `access-${id}`, refreshToken: `refresh-${id}`, expiresAt: Date.now() + 600_000, chatgptAccountId: `acct-${id}` });

if (action.startsWith("depth-")) {
  const child = new Headers({ "thread-id": "child", "x-codex-parent-thread-id": "root" });
  const grandchild = new Headers({ "thread-id": "grandchild", "x-codex-parent-thread-id": "child" });
  if (action === "depth-write") {
    const lineage = recordCodexThreadLineage(child)!;
    bindThreadAffinity(lineage.conversationKey, "a", Date.now());
    if (recordCodexThreadLineage(grandchild)!.conversationKey !== lineage.conversationKey) throw new Error("lineage did not converge");
    lease.release();
  } else {
    resolveCodexAccountForThread("advance-cursor", config);
    const headers = action === "depth-one" ? child : grandchild;
    const selected = resolveCodexAccountForThread(codexPoolAffinityKey(headers)!, config);
    lease.release();
    console.log(JSON.stringify({ selected }));
  }
  process.exit(0);
} else if (action.startsWith("race-")) {
  const record = readCodexAccountRecord("a")!;
  bindThreadAffinity(key, "a", Date.now());
  if (action === "race-relogin" || action === "race-issuer") saveCodexAccountCredential("a", cred("a"));
  if (action === "race-delete-add") {
    removeCodexAccountCredential("a");
    saveCodexAccountCredential("a", cred("a"));
  }
  if (action === "race-refresh" || action === "race-external") {
    if (!saveCodexAccountCredentialIfGeneration("a", record.generation, { ...cred("a"), accessToken: "rotated" })) throw new Error("refresh failed");
    if (action === "race-refresh" && !handOffThreadAffinityGeneration("a", record.generation, record.generation + 1)) throw new Error("handoff failed");
  }
  if (action === "race-issuer") rememberConversationStateIssuer(key, "a", undefined, { generation: record.generation, chatgptAccountId: record.credential!.chatgptAccountId });
} else if (action === "write-main") {
  bindThreadAffinity(key, "__main__", Date.now());
  rememberConversationStateIssuer(key, "__main__");
} else if (action === "lease") {
  const second = acquireSpendLedgerOwner();
  const token = mintSpendLedgerStorage("codex-affinity.sqlite");
  bindThreadAffinity(key, "a", Date.now());
  lease.release();
  const db = new Database(join(process.env.OPENCODEX_HOME!, "codex-affinity.sqlite"));
  const before = db.query("SELECT count(*) AS n FROM threads").get() as { n: number };
  db.close();
  second.release();
  const again = acquireSpendLedgerOwner();
  let rejected = false;
  try { assertStorageOwned(token); } catch { rejected = true; }
  again.release();
  console.log(JSON.stringify({ before: before.n, rejected }));
  process.exit(0);
} else {
  if (action === "removed") removeCodexAccountCredential("a");
  if (action === "relogin") saveCodexAccountCredential("a", cred("a"));
  if (action === "paused") config.pausedCodexAccountIds = ["a"];
  if (action === "plan") {
    config.codexAccounts = [{ id: "a", email: "a@test", isMain: false, plan: "free" }, { id: "b", email: "b@test", isMain: false, plan: "plus" }];
    config.codexPool = { excludedPlans: ["free"] };
  }
  if (action === "reauth" || action === "cooldown" || action === "transient") {
    if (getThreadAffinity(key)?.accountId !== "a") throw new Error("expected restored affinity");
    const status = action === "reauth" ? 401 : action === "cooldown" ? 429 : 503;
    for (let i = 0; i < (action === "transient" ? 3 : 1); i++) recordCodexUpstreamOutcome(config, "a", status, { now: Date.now() });
  }
  if (action === "bind") bindThreadAffinity(key, "b", Date.now());
  if (action === "delete") deleteThreadAffinity(key);
  if (action === "delete-account") deleteThreadAffinitiesForAccount(key, "a");
  if (action === "clear-account") clearThreadAccountMapForAccount("a");
  if (action === "clear") clearThreadAccountMap();
  if (action === "clear-issuer") clearConversationStateIssuerMap();
  if (action === "issuer") {
    const record = readCodexAccountRecord("b")!;
    rememberConversationStateIssuer(key, "b", undefined, { generation: record.generation, chatgptAccountId: record.credential!.chatgptAccountId });
  }
  if (action === "touch") {
    const timestamp = Date.now();
    resolveCodexAccountForThread(key, config, timestamp);
    lease.release();
    const db = new Database(join(process.env.OPENCODEX_HOME!, "codex-affinity.sqlite"));
    const row = db.query("SELECT last_used_at AS timestamp FROM threads").get();
    db.close();
    console.log(JSON.stringify({ timestamp, row }));
    process.exit(0);
  }
  const before = getThreadAffinity(key)?.accountId;
  const issuer = peekConversationStateIssuer(key);
  resolveCodexAccountForThread("advance-cursor", config);
  const selected = resolveCodexAccountForThread(key, config);
  const after = getThreadAffinity(key)?.accountId;
  lease.release();
  const db = new Database(join(process.env.OPENCODEX_HOME!, "codex-affinity.sqlite"));
  const rows = db.query("SELECT account_id FROM threads WHERE account_id='a'").all().length;
  const issuers = db.query("SELECT count(*) AS n FROM issuers").get() as { n: number };
  db.close();
  console.log(JSON.stringify({ before, issuer, selected, after, rows, issuers: issuers.n }));
  process.exit(0);
}
lease.release();
