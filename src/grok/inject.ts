import { constants, copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { applyEol, dominantEol, providerBaseHost } from "../codex/inject";

export interface GrokInjectModel {
  id: string;
  name?: string;
  contextWindow?: number;
}

export interface GrokInjectResult {
  ok: boolean;
  changed: boolean;
  message: string;
  skippedReason?: "no-grok-home" | "user-owned-provider";
}

const BEGIN_MARKER = "# >>> opencodex managed block — do not edit (removed by `ocx stop`) >>>";
const END_MARKER = "# <<< opencodex managed block <<<";
const PROVIDER_HEADER = "[model_providers.opencodex]";
// grok 0.2.101 verified live (2026-07-23): [model_providers.<id>] inheritance parses but the
// inherited base_url is NOT applied to inference routing — the turn falls through to the default
// cli-chat-proxy and 401s. Per-model direct fields DO route. So every [model.*] block carries its
// own base_url/api_backend/api_key; the provider table remains only as a user-visible grouping
// header (harmless) and the user-owned conflict guard keeps checking for it.

interface ManagedRegion {
  start: number;
  end: number;
  orphaned: boolean;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function resolveGrokHome(grokHome?: string): string {
  return grokHome ?? (process.env.GROK_HOME || join(homedir(), ".grok"));
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function findManagedRegion(content: string): ManagedRegion | null {
  const start = content.indexOf(BEGIN_MARKER);
  if (start === -1) return null;
  const endMarkerStart = content.indexOf(END_MARKER, start + BEGIN_MARKER.length);
  if (endMarkerStart === -1) return { start, end: content.length, orphaned: true };
  return { start, end: endMarkerStart + END_MARKER.length, orphaned: false };
}

function hasUserOwnedProvider(content: string, region: ManagedRegion | null): boolean {
  const outsideManagedRegion = region
    ? content.slice(0, region.start) + content.slice(region.end)
    : content;
  return /^\s*\[model_providers\.opencodex\]\s*(?:#.*)?$/m.test(outsideManagedRegion);
}

function copyBackupOnce(configPath: string, backupPath: string): void {
  if (existsSync(backupPath)) return;
  try {
    copyFileSync(configPath, backupPath, constants.COPYFILE_EXCL);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
}

function errorResult(action: string, error: unknown): GrokInjectResult {
  const detail = error instanceof Error ? error.message : String(error);
  return { ok: false, changed: false, message: `Could not ${action} Grok config: ${detail}` };
}

export function buildGrokManagedBlock(port: number, models: GrokInjectModel[], hostname?: string): string {
  const host = providerBaseHost(hostname);
  const baseUrl = `http://${host}:${port}/v1`;
  const lines = [
    BEGIN_MARKER,
  ];
  const aliasCounts = new Map<string, number>();

  for (const model of models) {
    const baseAlias = `ocx-${model.id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
    const count = (aliasCounts.get(baseAlias) ?? 0) + 1;
    aliasCounts.set(baseAlias, count);
    const alias = count === 1 ? baseAlias : `${baseAlias}-${count}`;
    const isFirst = lines.length === 1;
    lines.push(
      ...(isFirst ? [] : [""]),
      `[model.${alias}]`,
      `model = ${tomlString(model.id)}`,
      `base_url = ${tomlString(baseUrl)}`,
      'api_backend = "chat_completions"',
      'api_key = "opencodex-loopback"',
      `name = ${tomlString(model.name ?? `OCX ${model.id}`)}`,
    );
    if (Number.isFinite(model.contextWindow) && (model.contextWindow ?? 0) > 0) {
      lines.push(`context_window = ${model.contextWindow}`);
    }
  }

  lines.push(END_MARKER);
  return lines.join("\n");
}

export function injectGrokConfig(
  port: number,
  models: GrokInjectModel[],
  opts: { grokHome?: string; hostname?: string } = {},
): GrokInjectResult {
  const grokHome = resolveGrokHome(opts.grokHome);
  if (!isDirectory(grokHome)) {
    return {
      ok: true,
      changed: false,
      message: `Grok home not found at ${grokHome}; config injection skipped.`,
      skippedReason: "no-grok-home",
    };
  }

  const configPath = join(grokHome, "config.toml");
  const backupPath = join(grokHome, "config.toml.bak-opencodex");
  try {
    const configExisted = existsSync(configPath);
    const rawContent = configExisted ? readFileSync(configPath, "utf8") : "";
    const eol = dominantEol(rawContent);
    const content = applyEol(rawContent, "\n");
    const region = findManagedRegion(content);

    if (hasUserOwnedProvider(content, region)) {
      return {
        ok: true,
        changed: false,
        message: "Warning: Grok config injection skipped because a user-owned [model_providers.opencodex] table exists outside the managed block.",
        skippedReason: "user-owned-provider",
      };
    }

    const block = buildGrokManagedBlock(port, models, opts.hostname);
    let nextContent: string;
    if (region) {
      nextContent = content.slice(0, region.start) + block + content.slice(region.end);
    } else if (content.length === 0) {
      nextContent = `${block}\n`;
    } else {
      const separator = content.endsWith("\n") ? "\n" : "\n\n";
      nextContent = `${content}${separator}${block}\n`;
    }

    const output = applyEol(nextContent, eol);
    if (output === rawContent) {
      return { ok: true, changed: false, message: "Grok config already contains the current opencodex managed block." };
    }
    if (configExisted && !region) copyBackupOnce(configPath, backupPath);
    writeFileSync(configPath, output, "utf8");
    return {
      ok: true,
      changed: true,
      message: region
        ? "Updated the opencodex managed block in Grok config."
        : "Added the opencodex managed block to Grok config.",
    };
  } catch (error) {
    return errorResult("inject", error);
  }
}

export function stripGrokConfig(opts: { grokHome?: string } = {}): GrokInjectResult {
  const grokHome = resolveGrokHome(opts.grokHome);
  if (!isDirectory(grokHome)) {
    return {
      ok: true,
      changed: false,
      message: `Grok home not found at ${grokHome}; no managed config to remove.`,
      skippedReason: "no-grok-home",
    };
  }

  const configPath = join(grokHome, "config.toml");
  if (!existsSync(configPath)) {
    return { ok: true, changed: false, message: "Grok config not found; no managed block to remove." };
  }

  try {
    const rawContent = readFileSync(configPath, "utf8");
    const eol = dominantEol(rawContent);
    const content = applyEol(rawContent, "\n");
    const region = findManagedRegion(content);
    if (!region) {
      return { ok: true, changed: false, message: "No opencodex managed block found in Grok config." };
    }

    let removalEnd = region.end;
    if (!region.orphaned && content.startsWith("\n", removalEnd)) removalEnd += 1;
    let prefix = content.slice(0, region.start);
    if (prefix.endsWith("\n\n")) prefix = prefix.slice(0, -1);
    const stripped = prefix + content.slice(removalEnd);
    writeFileSync(configPath, applyEol(stripped, eol), "utf8");

    return {
      ok: true,
      changed: true,
      message: region.orphaned
        ? "Removed an orphaned opencodex begin marker and all following Grok config content."
        : "Removed the opencodex managed block from Grok config.",
    };
  } catch (error) {
    return errorResult("strip", error);
  }
}
