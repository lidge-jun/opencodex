/**
 * Read-only view of the Grok Build managed block.
 *
 * This never writes. `injectGrokConfig` owns every mutation of `~/.grok/config.toml`, behind
 * guards (non-loopback refusal, byte-for-byte preservation of user content, alias reservation)
 * that a web-reachable writer would widen the blast radius of. The dashboard only needs to
 * answer "is Grok wired up, and with what?", which a reader does at a fraction of the risk.
 *
 * It parses only the fenced region we ourselves emit, and only the specific fields
 * `buildGrokManagedBlock` writes — user content outside the fence is never read or echoed,
 * since it can legitimately contain real credentials.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BEGIN_MARKER = "# >>> opencodex managed block — do not edit (removed by `ocx stop`) >>>";
const END_MARKER = "# <<< opencodex managed block <<<";

export interface GrokStatusModel {
  /** Alias of the emitted `[model.<alias>]` table. */
  alias: string;
  /** The model id opencodex routes for. */
  id: string;
  contextWindow?: number;
}

export interface GrokStatus {
  configPath: string;
  /** Whether the managed fence is present in that file. */
  present: boolean;
  /** Endpoint the fence points at, parsed from the first entry. */
  baseUrl: string | null;
  models: GrokStatusModel[];
}

/** Mirrors `resolveGrokHome` in ./inject so both agree on the authoritative file. */
export function grokConfigPath(grokHome?: string): string {
  const home = grokHome ?? (process.env.GROK_HOME || join(homedir(), ".grok"));
  return join(home, "config.toml");
}

function tomlStringValue(line: string): string | undefined {
  const match = /^[A-Za-z_]+\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(line.trim());
  if (!match) return undefined;
  return match[1]!.replace(/\\(["\\])/g, "$1");
}

export function readGrokStatus(opts: { grokHome?: string } = {}): GrokStatus {
  const configPath = grokConfigPath(opts.grokHome);
  let content: string;
  try {
    content = readFileSync(configPath, "utf8");
  } catch {
    // No Grok install, or no config yet. Absent is a state, not an error.
    return { configPath, present: false, baseUrl: null, models: [] };
  }

  const begin = content.indexOf(BEGIN_MARKER);
  const end = content.indexOf(END_MARKER, begin + 1);
  if (begin < 0 || end < 0) return { configPath, present: false, baseUrl: null, models: [] };

  const region = content.slice(begin + BEGIN_MARKER.length, end);
  const models: GrokStatusModel[] = [];
  let baseUrl: string | null = null;
  let current: GrokStatusModel | null = null;

  // The provider block carries base_url in the current shape; per-model base_url is the
  // legacy fallback for fences written before the model_providers migration.
  let inProviderBlock = false;

  for (const rawLine of region.split("\n")) {
    const line = rawLine.trim();
    const providerHeader = /^\[model_providers\.([^\]]+)\]$/.exec(line);
    if (providerHeader) {
      inProviderBlock = true;
      continue;
    }
    const header = /^\[model\.([^\]]+)\]$/.exec(line);
    if (header) {
      inProviderBlock = false;
      current = { alias: header[1]!, id: "" };
      models.push(current);
      continue;
    }
    if (line.startsWith("base_url =")) {
      // Prefer the provider block's base_url; fall back to per-model (legacy shape).
      if (inProviderBlock) baseUrl ??= tomlStringValue(line) ?? null;
      else if (current && baseUrl === null) baseUrl = tomlStringValue(line) ?? null;
    } else if (!inProviderBlock && current) {
      if (line.startsWith("model =")) {
        current.id = tomlStringValue(line) ?? "";
      } else if (line.startsWith("context_window =")) {
        const value = Number(line.slice(line.indexOf("=") + 1).trim());
        if (Number.isFinite(value) && value > 0) current.contextWindow = value;
      }
    }
  }

  return { configPath, present: true, baseUrl, models: models.filter(model => model.id) };
}

/**
 * Does the fence point somewhere the running proxy is NOT?
 *
 * Grok resolves its model at request time and retries a refused connection up to 15
 * times, and those retries are invisible to us: nothing reaches the proxy, so nothing
 * lands in our log. The user sees a correct context window (the stale entry carries it)
 * and an endless "Retrying (attempt N/15)". That is a silent failure unless someone
 * compares the fence's port against the port we actually bound — which is exactly what
 * `ocx status` is for.
 *
 * Returns null when there is nothing to say: no fence, an unparsable endpoint, or a
 * fence that already agrees with the live listener.
 */
export function grokFenceEndpointDrift(
  status: Pick<GrokStatus, "present" | "baseUrl">,
  livePort: number | undefined,
): { fencePort: number; livePort: number } | null {
  if (!status.present || !status.baseUrl) return null;
  if (typeof livePort !== "number" || !Number.isFinite(livePort) || livePort <= 0) return null;
  let fencePort: number;
  try {
    const url = new URL(status.baseUrl);
    // An explicit port is the only thing we write, so an empty one means a shape we did
    // not produce; stay quiet rather than guess a default.
    if (!url.port) return null;
    fencePort = Number(url.port);
  } catch {
    return null;
  }
  if (!Number.isFinite(fencePort) || fencePort === livePort) return null;
  return { fencePort, livePort };
}
