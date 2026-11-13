import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { repoPath, repoRoot } from "./repo-root";
import { applicableMessagesOverflowFixtures, messagesOverflowLanes, messagesOverflowCaseId, messagesOverflowCaseTableHash } from "./messages-overflow-cases";
const [mode, scratch, output, selectedLane, offset = "0", limit] = process.argv.slice(2) as [string, string, string, string?, string?, string?];
if (mode !== "head" && mode !== "--generate-base") throw new Error("Expected head or --generate-base");
const base = mode === "--generate-base";
if (base && selectedLane) throw new Error("Baseline generation requires the complete case table");
if (selectedLane && !(messagesOverflowLanes as readonly string[]).includes(selectedLane)) throw new Error("Unknown Messages lane");
const first = Number(offset); const count = limit === undefined ? Infinity : Number(limit);
if (!Number.isSafeInteger(first) || first < 0 || (count !== Infinity && (!Number.isSafeInteger(count) || count <= 0))) throw new Error("Invalid Messages slice");
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
    : ["src/server/claude-messages.ts", "src/claude/outbound.ts", "src/server/messages-native.ts", "src/protocols/encoders/messages.ts"];
  const overlays = new Map<string, string>();
  for (const path of changed) {
    let source = base ? git("show", `72e80d280:${path}`) : readFileSync(repoPath(path), "utf8");
    if (path === "src/server/claude-messages.ts") source = replaceOnce(source,
      "const upstream = await handleResponses(internalReq, ",
      "const upstream = globalThis.__messagesReplayResponse ? globalThis.__messagesReplayResponse() : await handleResponses(internalReq, ");
    if (path === "src/server/claude-messages.ts") source = replaceOnce(source,
      "message = await collectAnthropicMessage(anthropicSse,",
      "if (globalThis.__messagesCollectorStream) await anthropicSse.cancel();\n      message = await collectAnthropicMessage(globalThis.__messagesCollectorStream ?? anthropicSse,");
    if (path === "src/server/claude-messages.ts") source = replaceOnce(source,
      "body = await readAnthropicBody(req, translatorBudget, resolveInboundBodyLimitBytes(config.maxInboundBodyBytes));",
      "if (globalThis.__messagesReadFailure) throw globalThis.__messagesReadFailure.value;\n    body = await readAnthropicBody(req, translatorBudget, resolveInboundBodyLimitBytes(config.maxInboundBodyBytes));") + "\nexport { desktopMappingUnavailableResponse as __messagesSweepDesktop, translationFailure as __messagesSweepTranslation, claudeInboundDisabled as __messagesSweepDisabled };\n";
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
// Install before the request graph loads, so even an ACL verifier that returns
// after requesting termination cannot hide its still-live PowerShell child.
const spawnTracker = base ? undefined : (await import("./messages-overflow-spawn-tracker")).trackOverflowAsyncSpawns();
const { runMessagesOverflowCase } = await import("./messages-overflow-case");
const { acquireOwnedSpendHome } = await import("./owned-spend-home");
const { upstreamMessagesRequestIdHeaders } = await import("../../src/server/messages-response-headers");
if (base && upstreamMessagesRequestIdHeaders(new Headers({ "request-id": "req_fixture" }))["request-id"] !== "req_fixture") throw new Error("Baseline modules were not loaded");
const rows = [];
const decisions: Record<string, boolean>[] = [];
const types: (string | null)[] = [];
const codes: (string | null)[] = [];
const mediaTypes: (string | null)[] = [];
const outcomes: Record<string, unknown[]> = {};
function intern<T>(values: T[], value: T): number {
  const serialized = JSON.stringify(value);
  const index = values.findIndex(item => JSON.stringify(item) === serialized);
  if (index >= 0) return index;
  return values.push(value) - 1;
}
// A real server owns its spend home for its lifetime. Keep that same ownership
// across this sequential slice, avoiding a full journal replay for every row.
// Pure encoder lanes never acquire a lease; single-case helpers keep their default.
let releaseSpendHome: (() => void) | undefined;
const acquireSliceSpendHome = () => {
  releaseSpendHome ??= acquireOwnedSpendHome();
  return () => {}; // Borrowed by the row; the slice's finally owns release.
};
try {
  for (const lane of messagesOverflowLanes.filter(lane => !selectedLane || lane === selectedLane)) for (const input of applicableMessagesOverflowFixtures(lane).slice(first, first + count)) {
    const observations = new Map<string, boolean[]>();
    (globalThis as any).__messagesOverflowRecord = (tag: string, value: boolean) => {
      const values = observations.get(tag) ?? []; values.push(value); observations.set(tag, values);
      return value;
    };
    if (input.fault) process.stderr.write(`fixture ${lane}/${input.id}\n`);
    const result = await runMessagesOverflowCase(lane, input, acquireSliceSpendHome);
    const passthrough = lane === "passthrough" || lane === "count_tokens";
    if (!passthrough && input.rawBody === undefined && !input.fault && !input.localBranch && observations.size === 0) throw new Error(`Missing baseline observation for ${lane}/${input.id}`);
    const internalDecisions: Record<string, boolean> = {};
    for (const [tag, values] of observations) {
      if (values.some(value => value !== values[0])) throw new Error(`Inconsistent ${tag} decisions for ${lane}/${input.id}`);
      internalDecisions[tag] = values[0]!;
    }
    if (base) {
      const id = messagesOverflowCaseId(lane, input);
      if (Object.hasOwn(outcomes, id)) throw new Error(`Duplicate case id: ${lane}/${input.id}`);
      // Outcome-only tuples keep the base fixture small; dictionaries retain exact compared values.
      const outcome: unknown[] = [messagesOverflowLanes.indexOf(lane), result.status, result.clientRecognizes,
        intern(decisions, internalDecisions), input.classification[lane], intern(types, result.type ?? null),
        intern(codes, result.code ?? null), intern(mediaTypes, result.mediaType), result.clientError];
      if (input.classification[lane] === "success" || input.fixedLocal) {
        outcome.push(result.bodySha256, result.bodyLength);
      }
      outcomes[id] = outcome;
    } else rows.push({ lane, input, head: { ...result, internalDecisions } });
  }
} finally {
  delete (globalThis as any).__messagesOverflowRecord;
  releaseSpendHome?.();
}
if (base) {
  const header = { schemaVersion: 8, baseCommit: "72e80d280d614bdf4f1aada9b233f6732404afec", caseTableSha256: messagesOverflowCaseTableHash(),
    columns: ["lane", "status", "clientRecognizes", "decisions", "class", "type", "code", "mediaType", "clientError", "bodySha256?", "bodyLength?"],
    lanes: messagesOverflowLanes, decisions, types, codes, mediaTypes };
  const lines = Object.entries(outcomes).map(([id, outcome]) => `${JSON.stringify(id)}:${JSON.stringify(outcome)}`);
  // Three outcome entries per line keep the generated JSON below the unchanged line ratchet.
  const groups = [];
  for (let index = 0; index < lines.length; index += 3) groups.push(lines.slice(index, index + 3).join(","));
  await Bun.write(output, `${JSON.stringify(header).slice(0, -1)},"outcomes":{\n${groups.join(",\n")}\n}}\n`);
} else {
  // Successful exit is not enough on Windows: an async ACL child can outlive its caller.
  const { settleBackgroundWork } = await import("../../src/lib/background-work");
  const settled = await settleBackgroundWork({ timeoutMs: 2_000 });
  if (!settled.settled) throw new Error(`Overflow background work did not settle: ${settled.pending.join(", ")}`);
  const { flushConfigDirHardeningForTests } = await import("../../src/config/paths");
  const { flushWindowsSecretAclReapsBeforeRemoval, windowsSecretAclReapPendingAtOrBelow } = await import("../../src/lib/windows-secret-acl");
  await flushConfigDirHardeningForTests();
  await flushWindowsSecretAclReapsBeforeRemoval(scratch);
  if (windowsSecretAclReapPendingAtOrBelow(scratch)) throw new Error("Overflow ACL child remains active");
  await spawnTracker!.drain();
  spawnTracker!.restore();
  await Bun.write(output, JSON.stringify({ schemaVersion: 8, rows, fixtureAsyncSpawnsDrained: true }) + "\n");
}
