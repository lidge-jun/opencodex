import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { repoPath, repoRoot } from "./repo-root";
import { applicableMessagesOverflowFixtures, messagesOverflowLanes } from "./messages-overflow-cases";
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
{
  const existing = base ? new Set(git("ls-tree", "-r", "--name-only", "72e80d280", "--", "src").trim().split("\n")) : new Set<string>();
  const changed = base ? git("diff", "--name-only", "72e80d280", "--", "src").trim().split("\n").filter(path => existing.has(path))
    : ["src/claude/outbound.ts", "src/server/messages-native.ts", "src/protocols/encoders/messages.ts"];
  const overlays = new Map<string, string>();
  for (const path of changed) {
    let source = base ? git("show", `72e80d280:${path}`) : readFileSync(repoPath(path), "utf8");
    if (path === "src/claude/outbound.ts") {
      source = replaceOnce(source, "  const text = overflow ? claudePromptTooLongMessage(message) : message;",
        '  globalThis.__messagesOverflowRecord("writer", overflow);\n  const text = overflow ? claudePromptTooLongMessage(message) : message;');
      source = replaceOnce(source, "  if (isContextOverflowError(error, message)) return 400;",
        '  const overflow = isContextOverflowError(error, message);\n  globalThis.__messagesOverflowRecord("status", overflow);\n  if (overflow) return 400;');
    }
    if (path === "src/server/messages-native.ts" && base) {
      source = replaceOnce(source, 'if (isNativeOverflowError(error, text)) return fail(400, claudePromptTooLongMessage(text), "invalid_request_error");',
        'if (globalThis.__messagesOverflowRecord("native-fold", isNativeOverflowError(error, text))) return fail(400, claudePromptTooLongMessage(text), "invalid_request_error");');
      source = replaceOnce(source, '  const out = new Response(JSON.stringify(anthropicErrorBody(\n    status,\n    overflow ?',
        '  globalThis.__messagesOverflowRecord("native-http", overflow);\n  const out = new Response(JSON.stringify(anthropicErrorBody(\n    status,\n    overflow ?');
    }
    if (path === "src/protocols/encoders/messages.ts" && base) source = replaceOnce(source,
      '  return new Response(JSON.stringify(message), {\n    status: isError ?',
      '  globalThis.__messagesOverflowRecord("direct-collector", isError && translatedError?.code === "context_length_exceeded");\n  return new Response(JSON.stringify(message), {\n    status: isError ?');
    if (path === "src/server/messages-native.ts" && !base) {
      source = replaceOnce(source, "const baselineOverflow = isNativeOverflowError(error, text);",
        'const baselineOverflow = globalThis.__messagesOverflowRecord("native-fold", isNativeOverflowError(error, text));');
      source = replaceOnce(source, "\n  const overflow = messagesOverflowPresentation((legacy.error as Rec).message);",
        '\n  globalThis.__messagesOverflowRecord("native-http", legacyOverflow);\n  const overflow = messagesOverflowPresentation((legacy.error as Rec).message);');
    }
    if (path === "src/protocols/encoders/messages.ts" && !base) source = replaceOnce(source,
      '  const status = isError ? (baselineOverflow ? 400 : 502) : 200;',
      '  const status = isError ? (baselineOverflow ? 400 : 502) : 200;\n  globalThis.__messagesOverflowRecord("direct-collector", baselineOverflow);');
    const target = join(scratch, base ? "baseline" : "head", path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, source); overlays.set(repoPath(path), target);
  }
  const filter = new RegExp(`^(?:${[...overlays.keys()].map(path => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`);
  Bun.plugin({ name: "Messages overflow observations", setup(build) {
    build.onLoad({ filter }, ({ path }) => ({ contents: readFileSync(overlays.get(path)!, "utf8"), loader: "ts" }));
  } });
}
const { runMessagesOverflowCase } = await import("./messages-overflow-case");
const { upstreamMessagesRequestIdHeaders } = await import("../../src/server/messages-response-headers");
if (base && upstreamMessagesRequestIdHeaders(new Headers({ "request-id": "req_fixture" }))["request-id"] !== "req_fixture") throw new Error("Baseline modules were not loaded");
const rows = [];
for (const lane of messagesOverflowLanes) for (const input of applicableMessagesOverflowFixtures(lane)) {
  const observations = new Map<string, boolean[]>();
  (globalThis as any).__messagesOverflowRecord = (tag: string, value: boolean) => {
    const values = observations.get(tag) ?? []; values.push(value); observations.set(tag, values);
    return value;
  };
  const result = await runMessagesOverflowCase(lane, input);
  const passthrough = lane === "passthrough" || lane === "count_tokens";
  if (!passthrough && input.rawBody === undefined && observations.size === 0) throw new Error(`Missing baseline observation for ${lane}/${input.id}`);
  const internalDecisions: Record<string, boolean> = {};
  for (const [tag, values] of observations) {
    if (values.some(value => value !== values[0])) throw new Error(`Inconsistent ${tag} decisions for ${lane}/${input.id}`);
    internalDecisions[tag] = values[0]!;
  }
  rows.push({ lane, input, [base ? "base" : "head"]: { ...result, internalDecisions } });
}
delete (globalThis as any).__messagesOverflowRecord;
await Bun.write(output, JSON.stringify({ schemaVersion: 5, ...(base ? { baseCommit: "72e80d280d614bdf4f1aada9b233f6732404afec" } : {}), rows }) + "\n");
