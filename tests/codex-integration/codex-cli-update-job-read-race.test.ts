import { afterEach, expect, test } from "bun:test";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitCodexCliUpdateJob, readCodexCliUpdateJob, setCodexCliJobStoreReadHookForTests } from "../../src/codex/cli-update-job";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * A job status read while another process rewrites the POSIX job ledger.
 *
 * The ledger is replaced atomically (a private temporary file renamed over jobs.json), and readers take
 * no lock: the management status route and `ocx system codex-cli-update status` read while an owner
 * process records its transitions. A rename that lands after a read opened the file unlinks the file it
 * holds and makes the path name a newer one. Both were refused as an unsafe store, so the status route
 * answered 503 job_state_unavailable for a healthy job (dev run 43496185962, test 1/5: a restarted
 * management server read an old owner's job while the owner recorded it as running).
 *
 * The read seam places the replacement at each point deterministically. The Windows ledger is a
 * different store with its own tests.
 */
let root = "";
afterEach(() => {
  setCodexCliJobStoreReadHookForTests(null);
  if (root) removeTreeWithRetry(root);
  root = "";
});

async function ledgerWithJob() {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-cli-job-read-race-")));
  const configDir = join(root, "ocx");
  mkdirSync(configDir); chmodSync(configDir, 0o700);
  const admitted = await admitCodexCliUpdateJob({ requestId: "read-race-request-01", planId: "c".repeat(32), confirmed: true, configDir });
  const ledger = join(configDir, "codex-cli-update-jobs", "jobs.json");
  let replacements = 0;
  /** What a writer does: the same bytes in a private temp file, renamed over the ledger. */
  const replace = () => {
    const temp = `${ledger}.replacement-${replacements++}`;
    writeFileSync(temp, readFileSync(ledger), { mode: statSync(ledger).mode & 0o777 });
    renameSync(temp, ledger);
  };
  return { configDir, jobId: admitted.job.jobId, ledger, replace };
}

const posixStoreTest = test.skipIf(process.platform === "win32");

for (const stage of ["opened", "descriptor-checked"] as const) {
  posixStoreTest(`a ledger replaced once after the read reached "${stage}" is read again, not refused`, async () => {
    const { configDir, jobId, replace } = await ledgerWithJob();
    const seen: string[] = [];
    setCodexCliJobStoreReadHookForTests(at => {
      seen.push(at);
      if (at === stage && seen.filter(s => s === stage).length === 1) replace();
    });
    const job = await readCodexCliUpdateJob(jobId, configDir);
    expect(job?.jobId).toBe(jobId);
    // The first attempt saw the replacement; a second one read the new file.
    expect(seen.filter(s => s === "opened")).toHaveLength(2);
  });
}

posixStoreTest("a ledger replaced during every attempt is still refused after the last one", async () => {
  const { configDir, jobId, replace } = await ledgerWithJob();
  let attempts = 0;
  setCodexCliJobStoreReadHookForTests(at => { if (at === "opened") { attempts++; replace(); } });
  await expect(readCodexCliUpdateJob(jobId, configDir)).rejects.toThrow("unsafe_store");
  expect(attempts).toBe(5);
});

posixStoreTest("a hard-linked ledger is refused at once, without another attempt", async () => {
  const { configDir, jobId, ledger } = await ledgerWithJob();
  linkSync(ledger, `${ledger}.alias`);
  let attempts = 0;
  setCodexCliJobStoreReadHookForTests(at => { if (at === "opened") attempts++; });
  await expect(readCodexCliUpdateJob(jobId, configDir)).rejects.toThrow("unsafe_store");
  expect(attempts).toBe(1);
});
