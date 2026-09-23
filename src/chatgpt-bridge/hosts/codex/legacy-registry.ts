import { readFileSync, statSync } from "node:fs";
import { BridgeCoreError, CHATGPT_CONVERSATION_URL_PATTERN } from "../../contracts";

/**
 * Read-only federation view over the legacy DevSpace bridge registry.
 *
 * Invariants (handoff §4.1 / P0 capability matrix §3):
 * - byte-read + JSON.parse only: importing bridge-lib would run mkdir/icacls
 *   side effects, so that module must never be loaded here;
 * - this reader never writes, never locks, and never touches *.cap files;
 * - snapshots are invalidated by managementRevision + mtime so OC always sees
 *   the legacy registry as the single source of truth for existing bindings.
 */
export const LEGACY_REGISTRY_PATH_DEFAULT =
  `${process.env.USERPROFILE ?? "~"}\\.codex\\state\\chatgpt-codex-live-bridge\\bindings.json`.replace(/~/g, process.env.USERPROFILE ?? "~");

export interface LegacyBindingSnapshot {
  source: "legacy-codex";
  bindingId: string;
  bindingEpoch: string;
  revision: number;
  active: boolean;
  paused: boolean;
  chatUrl: string | null;
  chatTitle: string | null;
  codexThreadId: string | null;
  codexDeepLink: string | null;
  /** controllers/<id>.cap file stem; the file name is a routing key, its content is the secret. */
  controllerFileId: string | null;
  capabilityExpiresAt: string | null;
  updatedAt: string | null;
  /** True when chatUrl is a normal-conversation URL this integration can target. */
  targetable: boolean;
}

export interface LegacyRegistrySnapshot {
  managementRevision: number;
  version: number;
  readAt: string;
  bindings: LegacyBindingSnapshot[];
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  snapshot: LegacyRegistrySnapshot;
}

export class LegacyBindingRegistryReader {
  private cache: CacheEntry | null = null;

  constructor(private readonly registryPath: string = LEGACY_REGISTRY_PATH_DEFAULT) {}

  read(): LegacyRegistrySnapshot {
    let stat: { mtimeMs: number; size: number };
    try {
      const s = statSync(this.registryPath);
      stat = { mtimeMs: s.mtimeMs, size: s.size };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        this.cache = null;
        return { managementRevision: -1, version: 0, readAt: new Date().toISOString(), bindings: [] };
      }
      throw new BridgeCoreError("INVALID_REGISTRY", `legacy registry unreadable: ${String(error)}`);
    }
    if (this.cache && this.cache.mtimeMs === stat.mtimeMs && this.cache.size === stat.size) {
      return this.cache.snapshot;
    }
    let parsed: {
      version?: number;
      managementRevision?: number;
      bindings?: Record<string, Record<string, unknown>>;
    };
    try {
      parsed = JSON.parse(readFileSync(this.registryPath, "utf8"));
    } catch (error) {
      throw new BridgeCoreError("INVALID_REGISTRY", `legacy registry parse failed: ${String(error)}`);
    }
    if (parsed.version !== 2) {
      throw new BridgeCoreError("PROTOCOL_UNSUPPORTED", `unsupported legacy registry version ${parsed.version}`);
    }
    const bindings = Object.entries(parsed.bindings ?? {}).map(([bindingId, entry]) =>
      projectLegacyBinding(bindingId, entry),
    );
    const snapshot: LegacyRegistrySnapshot = {
      managementRevision: typeof parsed.managementRevision === "number" ? parsed.managementRevision : -1,
      version: 2,
      readAt: new Date().toISOString(),
      bindings,
    };
    this.cache = { ...stat, snapshot };
    return snapshot;
  }

  get(bindingId: string): LegacyBindingSnapshot | null {
    return this.read().bindings.find(binding => binding.bindingId === bindingId.toLowerCase()) ?? null;
  }
}

function projectLegacyBinding(bindingId: string, entry: Record<string, unknown>): LegacyBindingSnapshot {
  const chatUrl = typeof entry.chatgptUrl === "string" ? entry.chatgptUrl : null;
  return {
    source: "legacy-codex",
    bindingId,
    bindingEpoch: typeof entry.bindingEpoch === "string" ? entry.bindingEpoch : "",
    revision: typeof entry.revision === "number" ? entry.revision : -1,
    active: entry.active === true,
    paused: entry.paused === true,
    chatUrl,
    chatTitle: typeof entry.chatgptTitle === "string" ? entry.chatgptTitle : null,
    codexThreadId: typeof entry.codexThreadId === "string" ? entry.codexThreadId : null,
    codexDeepLink: typeof entry.codexDeepLink === "string" ? entry.codexDeepLink : null,
    controllerFileId: typeof entry.controllerFileId === "string" ? entry.controllerFileId : null,
    capabilityExpiresAt: typeof entry.capabilityExpiresAt === "string" ? entry.capabilityExpiresAt : null,
    updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : null,
    targetable: chatUrl !== null && CHATGPT_CONVERSATION_URL_PATTERN.test(chatUrl.replace(/[#?].*$/, "")),
  };
}
