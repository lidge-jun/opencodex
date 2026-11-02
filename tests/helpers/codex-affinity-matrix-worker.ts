import { Database } from "bun:sqlite";
import { join } from "node:path";
import { linkSync, readFileSync, symlinkSync } from "node:fs";
import { acquireSpendLedgerOwner, assertStorageOwned, mintSpendLedgerStorage } from "../../src/lib/spend-ledger-owner";
import { readCodexAccountRecord, removeCodexAccountCredential, saveCodexAccountCredential, saveCodexAccountCredentialIfGeneration } from "../../src/codex/account-store";
import { codexPoolAffinityKey } from "../../src/codex/auth-context";
import { recordCodexThreadLineage } from "../../src/codex/lineage";
import { runPassiveRead } from "../../src/lib/passive-read";
import { adoptStoredThreadRows, flushCodexAffinityStoreForTests } from "../../src/codex/routing/thread-affinity-store";
import { recordCodexUpstreamOutcome, resolveCodexAccountForThread, resolveCodexAccountForThreadDetailed } from "../../src/codex/routing";
import { bindThreadAffinity, clearConversationStateIssuerMap, clearThreadAccountMap, clearThreadAccountMapForAccount, deleteThreadAffinity, deleteThreadAffinitiesForAccount, getThreadAffinity, handOffThreadAffinityGeneration, peekConversationStateIssuer, rememberConversationStateIssuer } from "../../src/codex/routing/thread-affinity";
import type { OcxConfig } from "../../src/types";

const action = process.argv[2]!;
let hourly: (() => void) | undefined;
if (action === "hourly") {
  const original = globalThis.setInterval;
  globalThis.setInterval = ((callback: TimerHandler, delay?: number) => {
    if (delay === 3_600_000) hourly = callback as () => void;
    return original(callback, delay);
  }) as typeof setInterval;
}
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
  const unchanged = before.equals(readFileSync(file));
  lease.release();
  console.log(JSON.stringify({ unchanged }));
  process.exit(0);
}
const key = codexPoolAffinityKey(new Headers({ "session-id": "restart-session", "thread-id": "restart-thread" }))!;
const cred = (id: string) => ({ accessToken: `access-${id}`, refreshToken: `refresh-${id}`, expiresAt: Date.now() + 600_000, chatgptAccountId: `acct-${id}` });

if (action === "open-count" || action === "hourly") {
  const db = new Database(join(process.env.OPENCODEX_HOME!, "codex-affinity.sqlite"));
  if (action === "hourly") {
    const realNow = Date.now;
    Date.now = () => realNow() + 25 * 60 * 60_000;
    hourly?.();
  }
  const threads = db.query("SELECT count(*) AS n FROM threads").get();
  const issuers = db.query("SELECT count(*) AS n FROM issuers").get();
  const expired = db.query("SELECT count(*) AS n FROM threads WHERE row_key='expired'").get();
  db.close();
  lease.release();
  console.log(JSON.stringify({ threads, issuers, expired, scheduled: !!hourly }));
  process.exit(0);
}

if (action === "probe") {
  getThreadAffinity(key);
  lease.release();
  process.exit(0);
}
if (action === "late-journal-link" || action === "late-hard-link") {
  // The store is open (the lease opened it). A rollback journal exists only during a write, so a
  // link planted now is met by the next transaction, which must refuse it rather than follow it.
  // A second name for the database itself must stop writes the same way.
  const file = join(process.env.OPENCODEX_HOME!, "codex-affinity.sqlite");
  if (action === "late-hard-link") linkSync(file, join(process.env.OPENCODEX_HOME!, "outside-target"));
  else symlinkSync(join(process.env.OPENCODEX_HOME!, "outside-target"), `${file}-journal`);
  bindThreadAffinity(key, "b", Date.now());
  flushCodexAffinityStoreForTests();
  lease.release();
  console.log(JSON.stringify({ planted: true }));
  process.exit(0);
}
if (action.startsWith("late-")) {
  bindThreadAffinity(key, "a", Date.now());
  const record = readCodexAccountRecord("a")!;
  rememberConversationStateIssuer(key, "a", undefined, { generation: record.generation, chatgptAccountId: record.credential!.chatgptAccountId });
  lease.release();
  if (action === "late-bind") bindThreadAffinity(key, "b", Date.now());
  if (action === "late-delete") deleteThreadAffinity(key);
  if (action === "late-issuer") rememberConversationStateIssuer(key, "b");
  const next = acquireSpendLedgerOwner();
  const freshKey = codexPoolAffinityKey(new Headers({ "session-id": "restart-session", "thread-id": "restart-thread" }))!;
  const pin = getThreadAffinity(freshKey)?.accountId;
  const issuer = peekConversationStateIssuer(freshKey);
  next.release();
  console.log(JSON.stringify({ pin, issuer }));
  process.exit(0);
}
if (action === "shared-write") {
  bindThreadAffinity(key, "a", Date.now(), "shared");
  lease.release();
  process.exit(0);
}
if (action === "scopes") {
  const scopes = adoptStoredThreadRows(key, Date.now()).map(row => row.scope);
  lease.release();
  console.log(JSON.stringify({ scopes }));
  process.exit(0);
}

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
  const before = getThreadAffinity(key, action === "model-excluded" ? "shared" : undefined)?.accountId;
  const issuer = peekConversationStateIssuer(key);
  resolveCodexAccountForThread("advance-cursor", config);
  if (action === "model-excluded") {
    const result = resolveCodexAccountForThreadDetailed(key, config, Date.now(), "shared", { modelEligibleAccountIds: new Set(["b"]) }, "gpt-test");
    const shared = resolveCodexAccountForThread(key, config, Date.now(), "shared");
    lease.release();
    console.log(JSON.stringify({ before, result, shared }));
    process.exit(0);
  }
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
