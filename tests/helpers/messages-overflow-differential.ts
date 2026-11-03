import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { repoPath, repoRoot } from "./repo-root";
import { messagesOverflowFixtures, messagesOverflowLanes } from "./messages-overflow-cases";
const [mode, scratch, output] = process.argv.slice(2) as [string, string, string];
if (mode !== "head" && mode !== "--generate-base") throw new Error("Expected head or --generate-base");
const base = mode === "--generate-base";
function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: repoRoot() });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}
function replaceOnce(source: string, needle: string, replacement: string): string {
  if (source.split(needle).length !== 2) throw new Error(`Baseline observation anchor not unique: ${needle}`);
  return source.replace(needle, replacement);
}
if (base) {
  const existing = new Set(git("ls-tree", "-r", "--name-only", "72e80d280", "--", "src").trim().split("\n"));
  const changed = git("diff", "--name-only", "72e80d280", "--", "src").trim().split("\n").filter(path => existing.has(path));
  const overlays = new Map<string, string>();
  for (const path of changed) {
    let source = git("show", `72e80d280:${path}`);
    if (path === "src/claude/outbound.ts") {
      source = replaceOnce(source, "  const text = overflow ? claudePromptTooLongMessage(message) : message;",
        '  globalThis.__messagesOverflowRecord("writer", overflow);\n  const text = overflow ? claudePromptTooLongMessage(message) : message;');
      source = replaceOnce(source, "  if (isContextOverflowError(error, message)) return 400;",
        '  const overflow = isContextOverflowError(error, message);\n  globalThis.__messagesOverflowRecord("status", overflow && !isThroughputLimitText(message));\n  if (overflow) return 400;');
    }
    if (path === "src/server/messages-native.ts") {
      source = replaceOnce(source, 'if (isNativeOverflowError(error, text)) return fail(400, claudePromptTooLongMessage(text), "invalid_request_error");',
        'if (globalThis.__messagesOverflowRecord("native-fold", isNativeOverflowError(error, text))) return fail(400, claudePromptTooLongMessage(text), "invalid_request_error");');
      source = replaceOnce(source, '  const out = new Response(JSON.stringify(anthropicErrorBody(\n    status,\n    overflow ?',
        '  globalThis.__messagesOverflowRecord("native-http", overflow);\n  const out = new Response(JSON.stringify(anthropicErrorBody(\n    status,\n    overflow ?');
    }
    if (path === "src/protocols/encoders/messages.ts") source = replaceOnce(source,
      '  return new Response(JSON.stringify(message), {\n    status: isError ?',
      '  globalThis.__messagesOverflowRecord("direct-collector", isError && translatedError?.code === "context_length_exceeded");\n  return new Response(JSON.stringify(message), {\n    status: isError ?');
    const target = join(scratch, "baseline", path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, source); overlays.set(repoPath(path), target);
  }
  const filter = new RegExp(`^(?:${[...overlays.keys()].map(path => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`);
  Bun.plugin({ name: "Messages overflow baseline observations", setup(build) {
    build.onLoad({ filter }, ({ path }) => ({ contents: readFileSync(overlays.get(path)!, "utf8"), loader: "ts" }));
  } });
}
const { runMessagesOverflowCase } = await import("./messages-overflow-case");
const { upstreamMessagesRequestIdHeaders } = await import("../../src/server/messages-response-headers");
if (base && upstreamMessagesRequestIdHeaders(new Headers({ "request-id": "req_fixture" }))["request-id"] !== "req_fixture") throw new Error("Baseline modules were not loaded");
const rows = [];
for (const lane of messagesOverflowLanes) for (const input of messagesOverflowFixtures) {
  const decisions: boolean[] = [];
  (globalThis as any).__messagesOverflowRecord = (tag: string, value: boolean) => {
    const expected = lane === "native-http" || lane === "native-fold" || lane === "direct-collector" ? lane : lane === "direct-stream" || lane === "direct-fold" ? "status" : "writer";
    if (tag === expected) decisions.push(value);
    return value;
  };
  const result = await runMessagesOverflowCase(lane, input);
  const passthrough = lane === "passthrough" || lane === "count_tokens";
  if (base && !passthrough && decisions.length !== 1) throw new Error(`Expected one baseline decision for ${lane}/${input.id}: ${JSON.stringify(decisions)}`);
  rows.push({ lane, input, ...result, decision: base ? passthrough ? result.clientRecognizes : decisions[0] : result.compactionSentence });
}
delete (globalThis as any).__messagesOverflowRecord;
await Bun.write(output, JSON.stringify({ ...(base ? { baseCommit: "72e80d280d614bdf4f1aada9b233f6732404afec" } : {}), rows }) + "\n");
