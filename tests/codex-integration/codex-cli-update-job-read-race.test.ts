import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitCodexCliUpdateJob, readCodexCliUpdateJob } from "../../src/codex/cli-update-job";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * A job status read while another process rewrites the POSIX job ledger.
 *
 * The ledger is replaced atomically (a private temporary file renamed over jobs.json), and readers take
 * no lock: the management status route and `ocx system codex-cli-update status` read while an owner
 * process records its transitions. The read opens the file and then checks that the path still names
 * that file. A rename landing between the open and that check made a reader refuse the store as
 * unsafe, so the status route answered 503 job_state_unavailable for a healthy job (dev run
 * 43496185962, test 1/5: a restarted management server read an old owner's job while the owner
 * recorded it as running). A replaced file is now read again; every other unsafe store still refuses.
 *
 * The Windows ledger is a different store with its own tests.
 */
let root = "";
afterEach(() => { if (root) removeTreeWithRetry(root); root = ""; });

const WRITER = [
  "const { readFileSync, renameSync, statSync, writeFileSync } = require('node:fs');",
  "const file = process.argv[1]; const body = readFileSync(file); const mode = statSync(file).mode & 0o777;",
  "let n = 0; console.log('ready');",
  "setInterval(() => { const temp = file + '.race-' + (n++); writeFileSync(temp, body, { mode }); renameSync(temp, file); }, 1);",
].join("\n");

test.skipIf(process.platform === "win32")("a job read concurrent with an atomic ledger rewrite never reports the store unsafe", async () => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-cli-job-read-race-")));
  const configDir = join(root, "ocx");
  mkdirSync(configDir); chmodSync(configDir, 0o700);
  const admitted = await admitCodexCliUpdateJob({ requestId: "read-race-request-01", planId: "c".repeat(32), confirmed: true, configDir });
  const ledger = join(configDir, "codex-cli-update-jobs", "jobs.json");
  const writer = Bun.spawn([process.execPath, "-e", WRITER, ledger], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = writer.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("ready");
    reader.releaseLock();
    let reads = 0; const failures: string[] = [];
    for (const end = Date.now() + 1_000; Date.now() < end;) {
      try {
        const job = await readCodexCliUpdateJob(admitted.job.jobId, configDir);
        if (job?.jobId !== admitted.job.jobId) failures.push("missing");
      } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
      reads++;
    }
    expect({ failed: failures.length, first: failures.slice(0, 3) }).toEqual({ failed: 0, first: [] });
    expect(reads).toBeGreaterThan(100);
  } finally {
    writer.kill("SIGKILL");
    await writer.exited;
  }
});
