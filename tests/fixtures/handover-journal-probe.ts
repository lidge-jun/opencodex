/** #7423 startup journal recovery probe: runs the real reconcileStartupJournal in an isolated child. */
import { spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [mode, root] = [process.argv[2] as "swap" | "off", process.argv[3]!];
const codex = join(root, "codex");
const ocx = join(root, "ocx");
for (const path of [codex, ocx]) mkdirSync(path, { recursive: true });
process.env.CODEX_HOME = codex;
process.env.OPENCODEX_HOME = ocx;
if (mode === "off") writeFileSync(join(ocx, "config.json"), JSON.stringify({ providers: {}, clientIntegrations: { codex: false } }));
const original = "# original\nmodel_provider = \"openai\"\n";
const injected = "# injected\nmodel_provider = \"opencodex\"\n";
const configPath = join(codex, "config.toml");
const journalPath = join(codex, "opencodex-journal.json");
const dead = 999_999_991;
const journal = {
  version: 1, originalConfig: Buffer.from(original).toString("base64"), originalProfile: null,
  injectedConfigHash: createHash("sha256").update(injected).digest("hex"), injectedProfileHash: null,
  pid: dead, owner: { kind: "process", pid: dead }, opencodexHome: ocx, timestamp: new Date().toISOString(),
};
writeFileSync(configPath, injected);
writeFileSync(journalPath, JSON.stringify(journal));
const receipts = await import("../../src/config/pending-teardown");
// A receipt left by an update whose stop exited long ago.
receipts.claimPendingTeardown({ hostname: "127.0.0.1", port: 10100 }, "exact", dead + 1, "update-restart");
// A replacement home bound to another live owner, installed after the journal was read.
const replacement = { ...journal, originalConfig: Buffer.from("# replacement baseline\n").toString("base64"), pid: process.pid, owner: { kind: "process", pid: process.pid } };
const kill = process.kill;
const spy = spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
  if ((pid !== dead && pid !== dead + 1) || signal !== 0) return kill.call(process, pid, signal);
  if (mode === "swap" && pid === dead) {
    renameSync(codex, join(root, "parked-codex"));
    mkdirSync(codex);
    writeFileSync(configPath, injected);
    writeFileSync(journalPath, JSON.stringify(replacement));
  }
  throw Object.assign(new Error("dead fixture owner"), { code: "ESRCH" });
}) as typeof process.kill);
try {
  (await import("../../src/cli/cross-home-owner")).reconcileStartupJournal();
} finally {
  spy.mockRestore();
}
console.log(JSON.stringify(mode === "swap"
  ? { replacementPreserved: readFileSync(journalPath, "utf8") === JSON.stringify(replacement) }
  : { config: readFileSync(configPath, "utf8"), journalExists: existsSync(journalPath) }));

