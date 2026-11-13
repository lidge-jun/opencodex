import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoPath, repoRoot } from "./repo-root";
import { messagesSseCaseHash, SSE_BASE } from "./messages-sse-cases";
const [mode, scratch, output, selectedLane, offset = "0", count = "12"] = process.argv.slice(2);
if (mode !== "head" && mode !== "--generate-base") throw new Error("Expected head or --generate-base");
const hashes: Record<string, string> = {};
if (mode === "--generate-base") {
  const git = (...args: string[]) => {
    const child = Bun.spawnSync(["git", ...args], { cwd: repoRoot() });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    return child.stdout.toString();
  };
  if (git("rev-parse", SSE_BASE).trim() !== SSE_BASE) throw new Error("Wrong base commit");
  const existing = new Set(git("ls-tree", "-r", "--name-only", SSE_BASE, "--", "src").trim().split("\n"));
  const paths = new Set([
    "src/server/messages-native.ts", "src/server/messages-native-tool-guard.ts", "src/server/messages-shared.ts",
    "src/server/claude-messages.ts", "src/server/sse-payload-rewrite.ts", "src/lib/messages-error-body.ts",
    "src/claude/outbound.ts", "src/lib/client-error-body.ts",
    ...git("diff", "--name-only", SSE_BASE, "--", "src").trim().split("\n").filter(path => existing.has(path)),
  ]);
  // Exact git-show bytes are overlaid at the original module identities, before imports.
  const sources = new Map<string, string>();
  const { createHash } = await import("node:crypto");
  for (const path of paths) {
    const source = git("show", `${SSE_BASE}:${path}`);
    hashes[path] = createHash("sha256").update(source).digest("hex");
    sources.set(repoPath(path), source);
  }
  const filter = new RegExp("^(?:" + [...sources.keys()].map(path => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")$");
  Bun.plugin({ name: "895a85989 exact source overlay", setup(build) {
    build.onLoad({ filter }, ({ path }) => {
      const contents = sources.get(path);
      if (contents === undefined) throw new Error("Missing overlay source");
      return { contents, loader: path.endsWith(".ts") ? "ts" : "js" };
    });
  } });
}
const { applicableSseCases, runMessagesSseCase, sseLanes } = await import("./messages-sse-run");
const { createHash: recorderHash } = await import("node:crypto");
const recorderHashes = Object.fromEntries(["messages-sse-differential.ts", "messages-sse-run.ts", "messages-sse-observer.ts"].map(name => [name, recorderHash("sha256").update(readFileSync(join(import.meta.dir, name))).digest("hex")]));
const outcomes: Record<string, any> = {};
for (const lane of sseLanes.filter(lane => !selectedLane || lane === selectedLane)) {
  const inputs = mode === "--generate-base" ? applicableSseCases(lane) : applicableSseCases(lane).slice(Number(offset), Number(offset) + Number(count));
  for (const input of inputs) {
    if (mode === "--generate-base") process.stderr.write(`${lane}/${input.id}\n`);
    const { bytes, diagnostics, ...result } = await runMessagesSseCase(lane, input);
    const { createHash } = await import("node:crypto");
    outcomes[`${lane}/${input.id}`] = { ...result, diagnostics: diagnostics.map(row => ({ sha256: createHash("sha256").update(row.diagnostic ?? "").digest("hex"), recognizes: row.recognizes })),
      ...(mode === "--generate-base" ? { gzip: Buffer.from(Bun.gzipSync(bytes, { mtime: 0 })).toString("base64") } : { body: bytes.toString("base64") }) };
  }
}
let dictionaries: Record<string, any[]> | undefined;
if (mode === "--generate-base") {
  dictionaries = { traces: [], internals: [], diagnostics: [], bodies: [] };
  const intern = (name: string, value: unknown) => {
    const rows = dictionaries![name]!;
    const json = JSON.stringify(value);
    const index = rows.findIndex(row => JSON.stringify(row) === json);
    return index < 0 ? rows.push(value) - 1 : index;
  };
  for (const [key, row] of Object.entries(outcomes)) outcomes[key] = [row.status, row.bodySha256, row.bodyLength,
    intern("traces", row.chunks), row.readTurn, row.sends, intern("internals", row.internal), row.clientRecognizes,
    row.wirePhrase, intern("diagnostics", row.diagnostics), intern("bodies", row.gzip)];
}
mkdirSync(scratch!, { recursive: true });
await Bun.write(output!, JSON.stringify({ schemaVersion: 1, baseCommit: SSE_BASE, caseTableSha256: messagesSseCaseHash(),
  ...(mode === "--generate-base" ? { recorderHashes, dictionaries, columns: ["status", "bodySha256", "bodyLength", "trace", "readTurn", "sends", "internal", "clientRecognizes", "wirePhrase", "diagnostics", "body"], sourceHashes: hashes, sdk: { commit: "4f27519", streaming: "d936cbdc53e7e22221d151f66e25b49551ee94af7d474e5e836ba797a6b130cb", error: "36b53ac201abb7b759ddb61061b4de918cc35aff1d20e7f523a913a544b4ce97", claudeCode: "2.1.288" } } : {}), outcomes }) + "\n");
