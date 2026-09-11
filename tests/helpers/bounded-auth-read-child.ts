import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Child-process fixture for the bounded startup policy-binding read. A regressed (unbounded)
// FIFO read would block forever, so the parent's spawn timeout is the hang detector; the child
// itself only reports bind outcomes.
const caseName = process.env.OCX_BOUNDED_READ_CASE!;
const root = mkdtempSync(join(tmpdir(), "ocx-bounded-auth-read-"));
const accountId = "bounded-read-account";
const bearer = `header.${Buffer.from(JSON.stringify({
  exp: Math.floor(Date.now() / 1000) + 86_400,
  "https://api.openai.com/auth": { chatgpt_account_id: accountId },
})).toString("base64url")}.signature`;
const validAuth = JSON.stringify({ tokens: {
  access_token: bearer, refresh_token: "bounded-read-refresh", account_id: accountId,
} });

const { initializeMainAccountPolicyBinding } = await import("../../src/codex/account-lifecycle");
const { matchesMainQuotaCredential } = await import("../../src/codex/main-account-cache");

const validPath = join(root, "auth-valid.json");
writeFileSync(validPath, validAuth);
const result: Record<string, unknown> = { case: caseName };

if (caseName === "valid") {
  result.bound = initializeMainAccountPolicyBinding(validPath);
  result.matched = matchesMainQuotaCredential(bearer, accountId);
} else if (caseName === "fifo-retained" || caseName === "fifo-hang-proof") {
  const fifoPath = join(root, "auth-fifo");
  execFileSync("mkfifo", [fifoPath]);
  if (caseName === "fifo-retained") result.firstBound = initializeMainAccountPolicyBinding(validPath);
  const startedAt = Date.now();
  result.bound = initializeMainAccountPolicyBinding(fifoPath);
  result.elapsedMs = Date.now() - startedAt;
  if (caseName === "fifo-retained") result.retained = matchesMainQuotaCredential(bearer, accountId);
} else if (caseName === "symlink") {
  // The link target is a fully valid auth file: following the link would bind, so a refused
  // bind proves the no-follow read rather than a content failure.
  const linkPath = join(root, "auth-link.json");
  symlinkSync(validPath, linkPath);
  result.bound = initializeMainAccountPolicyBinding(linkPath);
  result.matched = matchesMainQuotaCredential(bearer, accountId);
} else if (caseName === "oversize") {
  const bigPath = join(root, "auth-big.json");
  // Valid JSON whose tokens would bind if read: only the size cap can keep this false.
  writeFileSync(bigPath, JSON.stringify({ tokens: {
    access_token: bearer, refresh_token: "bounded-read-refresh", account_id: accountId,
  }, padding: "a".repeat(5 * 1024 * 1024) }));
  result.bound = initializeMainAccountPolicyBinding(bigPath);
} else if (caseName === "directory") {
  const dirPath = join(root, "auth-dir");
  mkdirSync(dirPath);
  result.bound = initializeMainAccountPolicyBinding(dirPath);
} else if (caseName === "missing") {
  result.bound = initializeMainAccountPolicyBinding(join(root, "auth-absent.json"));
} else {
  throw new Error(`unknown bounded-read case: ${caseName}`);
}
console.log("BOUNDED_READ_RESULT=" + JSON.stringify(result));
