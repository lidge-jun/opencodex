import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { loadConfig } from "../config";
import { shouldSyncCodexOnStart } from "./desired-state";
import { atomicWriteFile } from "../config/atomic-write";
import { withConfigMutationLockSync } from "../config/mutation-lock";
import { getConfigDir } from "../config/paths";
import { assertCodexHomeOwner } from "./codex-home-owner";
import { ConfigWriteLockRefusal, publishConfigWriteTarget, watchConfigWriteTargets, withConfigWriteLockHeld, type LockHandle } from "./config-write-lock";
import { providerTableStart } from "./injected-marker";
import { CODEX_CONFIG_PATH, getCodexHome, tomlString } from "./paths";
import { rootSourceLines, sourceAssignment, sourceText } from "./toml-source-lines";
import { JOURNAL_PATH, removeJournal } from "./journal";
import { externalCodexModelProvider } from "./inject/config-toml";
import { readBoundedCodexConfig } from "./inject/bounded-config-reader";
import { isLoopbackHostname } from "./loopback-target";
import { validateCodexRoutingTarget, type CodexRoutingTarget } from "./inject/routing-target";

const approval = z.object({ original: z.string(), originalUrl: z.string().url(), managedUrls: z.array(z.string().url()).max(2) }).strict();
const recordSchema = z.object({ version: z.literal(1), codexHome: z.string(), providers: z.record(z.string(), approval) }).strict();
type RoutingRecord = z.infer<typeof recordSchema>;
type Approval = z.infer<typeof approval>;
let beforePublishForTests: (() => void) | undefined;
export function setBeforeProviderRoutingPublishForTests(hook: typeof beforePublishForTests): void { beforePublishForTests = hook; }

function recordPath(): string {
  const homeId = createHash("sha256").update(getCodexHome()).digest("hex");
  return join(getConfigDir(), `codex-provider-routing-${homeId}.json`);
}

function readRecord(): RoutingRecord {
  const content = readBoundedCodexConfig(recordPath());
  if (content === null) return { version: 1, codexHome: getCodexHome(), providers: {} };
  const record = recordSchema.parse(JSON.parse(content));
  if (record.codexHome !== getCodexHome()) throw new Error("Codex provider routing consent belongs to another home.");
  for (const saved of Object.values(record.providers)) {
    const parsed = Bun.TOML.parse(saved.original) as Record<string, unknown>;
    if (Object.keys(parsed).length !== 1 || parsed.base_url !== saved.originalUrl
      || saved.managedUrls.some(url => !isLoopbackHostname(new URL(url).hostname))) {
      throw new Error("Codex provider routing recovery evidence is invalid; existing files were preserved.");
    }
  }
  return record;
}

/** Only regular Responses provider tables with no separate credential transport are eligible. */
function providerUrl(content: string, id: string, checkCredentials = true) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || ["__proto__", "constructor", "prototype", "openai", "opencodex", "ollama", "lmstudio"].includes(id)) {
    throw new Error("Select a custom provider ID using letters, digits, hyphens or underscores.");
  }
  const parsed = Bun.TOML.parse(content) as Record<string, unknown>;
  const table = (parsed.model_providers as Record<string, Record<string, unknown>> | undefined)?.[id];
  if (!table || checkCredentials && ((table.wire_api !== undefined && table.wire_api !== "responses")
    || table.requires_openai_auth !== true
    || ["env_key", "experimental_bearer_token", "auth", "http_headers", "env_http_headers"].some(key => Object.hasOwn(table, key)))) {
    throw new Error("Routing consent requires a Responses provider using OpenAI authentication without custom credentials or headers.");
  }
  const { bom, lines } = rootSourceLines(content);
  const start = providerTableStart(lines.map(line => line.structural ? line.text : ""), id);
  if (start < 0) throw new Error("Routing consent requires an explicit provider table.");
  let end = start + 1;
  while (end < lines.length && !(lines[end]!.structural && /^\s*\[/.test(lines[end]!.text))) end++;
  for (let i = start + 1; i < end; i++) {
    const field = sourceAssignment(lines, i, end);
    if (field?.key !== "base_url") continue;
    if (typeof field.value !== "string") break;
    const url = new URL(field.value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) break;
    return { url: field.value, assignment: field.text, replace: (text: string) =>
      bom + sourceText(lines.slice(0, field.start)) + text + lines[field.end - 1]!.eol + sourceText(lines.slice(field.end)) };
  }
  throw new Error("Routing consent requires a credential-free HTTP(S) base_url assignment.");
}

function inWriteSection<T>(run: (held: LockHandle, content: string, record: RoutingRecord) => T): T {
  assertCodexHomeOwner(getCodexHome());
  const result = withConfigWriteLockHeld(CODEX_CONFIG_PATH, undefined, held => {
    watchConfigWriteTargets(held, [CODEX_CONFIG_PATH, recordPath(), JOURNAL_PATH]);
    const content = readFileSync(CODEX_CONFIG_PATH, "utf8");
    return run(held, content, readRecord());
  });
  if (!result.ok) throw new ConfigWriteLockRefusal(result);
  return result.value;
}

function publish(path: string, content: string, held: LockHandle): void {
  publishConfigWriteTarget(CODEX_CONFIG_PATH, held, path, (destination, hooks) => atomicWriteFile(destination, content, undefined, hooks));
}

function save(record: RoutingRecord, held: LockHandle): void {
  publish(recordPath(), JSON.stringify(record, null, 2) + "\n", held);
}

/** Read-only ownership evidence: consent alone never claims a URL we did not publish. */
export function isApprovedCodexProviderUrl(id: string, url: string): boolean {
  const record = readRecord();
  return Object.hasOwn(record.providers, id) && record.providers[id]!.managedUrls.includes(url);
}

export function approvedCodexProviders(): string[] {
  return Object.keys(readRecord().providers);
}

/** Capture the exact source before asking; commit refuses a changed provider after the prompt. */
export function previewCodexProviderConsent(id: string): string {
  return providerUrl(readFileSync(CODEX_CONFIG_PATH, "utf8"), id).assignment;
}

export function allowCodexProviderRouting(id: string, expected: string): void {
  inWriteSection((held, content, record) => {
    const field = providerUrl(content, id);
    if (field.assignment !== expected) throw new Error("Provider changed after confirmation; review it and retry.");
    if (Object.hasOwn(record.providers, id)) throw new Error("Provider is already approved; revoke it before granting new consent.");
    record.providers[id] = { original: field.assignment, originalUrl: field.url, managedUrls: [] };
    save(record, held);
  });
}

function accepts(fieldUrl: string, saved: Approval): boolean {
  return fieldUrl === saved.originalUrl || saved.managedUrls.includes(fieldUrl);
}

/** Called by start/sync, never prompts and never broadens the approved provider set. */
export function injectApprovedCodexProvider(id: string, target: CodexRoutingTarget, beforeWrite?: () => void, validateOnly = false): false | { configChanged: boolean } {
  return inWriteSection((held, content, record) => {
    if (!Object.hasOwn(record.providers, id)) return false;
    const apply = () => {
      target = validateCodexRoutingTarget(target);
      if (target.requiresAdmissionToken || target.desktopAuthless || target.clientCompaction || !isLoopbackHostname(new URL(target.baseUrl).hostname)) {
        throw new Error("Approved custom providers support only authenticated Codex on a local loopback proxy without client compaction.");
      }
      if (externalCodexModelProvider(content) !== id) throw new Error("Active provider changed; routing was not applied.");
      const field = providerUrl(content, id), saved = record.providers[id]!;
      if (!accepts(field.url, saved)) throw new Error("Approved provider base_url changed outside OpenCodex; revoke and approve it again.");
      if (validateOnly) return { configChanged: false };
      beforeWrite?.();
      if (!shouldSyncCodexOnStart(loadConfig())) return false;
      if (readFileSync(CODEX_CONFIG_PATH, "utf8") !== content) throw new Error("Codex config changed before publication; retry sync.");
      publishConfigWriteTarget(CODEX_CONFIG_PATH, held, JOURNAL_PATH, (_destination, hooks) => removeJournal(hooks));
      if (field.url === target.baseUrl) return { configChanged: false };
      // Write recovery evidence first. Both the previous and candidate URL remain restorable
      // if publication fails or the process exits between these two atomic renames.
      saved.managedUrls = [...new Set([field.url, target.baseUrl])].filter(url => url !== saved.originalUrl);
      save(record, held);
      beforePublishForTests?.();
      publish(CODEX_CONFIG_PATH, field.replace(`base_url = ${tomlString(target.baseUrl)}`), held);
      return { configChanged: true };
    };
    return validateOnly ? apply() : withConfigMutationLockSync(apply);
  });
}

/** Restore only our URLs; unrelated edits and provider IDs/history are never rewritten. */
export function restoreApprovedCodexProviders(revokeId?: string): boolean {
  const ids = approvedCodexProviders();
  if (revokeId !== undefined && !ids.includes(revokeId)) throw new Error("Provider has no routing consent to revoke.");
  if (!ids.length) return false;
  return inWriteSection((held, content, record) => {
    let next = content;
    for (const id of revokeId === undefined ? Object.keys(record.providers) : [revokeId]) {
      const saved = record.providers[id]!;
      const parsed = Bun.TOML.parse(next) as Record<string, unknown>;
      const table = (parsed.model_providers as Record<string, Record<string, unknown>> | undefined)?.[id];
      if (!table || !saved.managedUrls.includes(table.base_url as string)) continue;
      const field = providerUrl(next, id, false);
      if (saved.managedUrls.includes(field.url)) next = field.replace(saved.original);
    }
    if (next !== content) publish(CODEX_CONFIG_PATH, next, held);
    if (revokeId !== undefined) { delete record.providers[revokeId]; save(record, held); }
    return next !== content;
  });
}
