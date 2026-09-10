import { readFileSync, writeFileSync } from "node:fs";
import { clearCodexAccountPin } from "../codex/account-priority";
import { getConfigPath, mutatePersistedConfig, readConfigDiagnostics, sanitizeModelCostsForDisplay, saveConfig, validateConfigCandidate } from "../config";
import { VISION_REASONING_EFFORTS, isVisionReasoningEffort } from "../reasoning-effort";
import type { OcxConfig } from "../types";
import { normalizeVisionReasoningForModel } from "../vision/reasoning";
import type { ClientConnectionStatus } from "./connect";
import { CliUsageError, printData, rejectArgs, runCliAction, takeFlag } from "./runtime-api";

const USAGE = `Usage:
  ocx config [show] [--json] [--source]
  ocx config get <dot.path> [--json]
  ocx config set <dot.path> <json-or-string> [--json]
  ocx config unset <dot.path> [--json]
  ocx config validate [path|-] [--json]
  ocx config export <path|->
  ocx config import <path|-> --yes [--json]`;

/**
 * Keys whose VALUE is a credential and must never be printed or exported.
 *
 * `webhookUrl` is here because for Slack and Discord the URL itself is the authorization:
 * anyone holding it can post to the channel. It looks like configuration rather than a secret,
 * which is exactly why it needs to be named explicitly — none of the other patterns match it,
 * so `ocx config show` printed it and `config export` wrote it to disk in the clear.
 */
const SECRET_KEYS = /^(apiKey|key|accessToken|refreshToken|idToken|token|password|clientSecret|webhookUrl)$/i;
const BLOCKED_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * The synthetic `_remoteHub` note printed by `ocx config show` on a client (#4236).
 *
 * `runtimeRole: "client"` and the `client` block were already printed, and were already ignored:
 * an agent read a client's `config.json`, saw an empty `providers` map and no grok, and concluded
 * the hub could not serve grok. Naming the situation in the config output costs one key.
 *
 * `connected` is OBSERVED, never assumed. It was briefly hardcoded `true` for any config with a
 * `client` block, which is the same defect in miniature: the presence of configuration is not
 * evidence that the connection works, and a machine whose data-plane token was revoked, rotated
 * away or deleted would have been labelled `connected: true` while it could not reach the hub at
 * all. `collectClientConnectionStatus` is the one reader that knows — it compares the token file's
 * fingerprint against the connection record — so the caller passes its answer in and this stays
 * pure and testable.
 *
 * Synthetic and NOT persisted, for two reasons. `clientConnectionSchema` is `.strict()`, so a
 * `client.note` field would not validate; and persisted prose drifts from the behaviour it
 * describes. The leading underscore marks it as an annotation rather than a setting, and
 * `config export` emits the real config untouched so round-trips still validate.
 */
export function remoteHubConfigNote(
  config: OcxConfig,
  readConnection: () => Pick<ClientConnectionStatus, "state" | "reason" | "token">,
): { connected: boolean; origin: string; note: string } | null {
  if (config.runtimeRole !== "client" || !config.client) return null;
  // A thunk, so a standalone or hub install pays nothing: the guard above returns first and the
  // connection probe (three file reads) never runs.
  const connection = readConnection();
  // Both halves are required: a settled connection record AND the token it recorded. Either one
  // alone describes a machine that cannot read its hub, and `ocx status` is still the command
  // that has the facts — so the note points there in every case, connected or not.
  const connected = connection.state === "connected" && connection.token === "owned";
  const note = connection.state !== "connected"
    ? `this machine is configured as a client but its connection is ${connection.state}${connection.reason ? ` (${connection.reason})` : ""}; run ocx connect status`
    : connection.token !== "owned"
      ? `this machine is configured as a client but its hub data-plane token is ${connection.token}; run ocx connect status`
      : "provider credentials and model availability live on the hub; run ocx status";
  return { connected, origin: config.client.serverUrl, note };
}

function redact(value: unknown, key = ""): unknown {
  if (SECRET_KEYS.test(key) && typeof value === "string") return value ? "********" : value;
  // `client.priorCatalog` is the base64 catalog snapshot connect took before overwriting the
  // local one — up to 64 MB of it (src/config.ts). Printed in full it buried `runtimeRole` and
  // the `client` block under a wall of base64, which is how a reader came to miss that this
  // machine is a client at all. Size only, mirroring sanitizeModelCostsForDisplay.
  if (key === "priorCatalog" && typeof value === "string") {
    return value ? `<omitted: ${Buffer.byteLength(value)} bytes>` : value;
  }
  // modelCosts rows are keyed by model id; a pasted API key in a key position
  // must not be echoed back by config show/get (values are already redacted).
  if (key === "modelCosts") return sanitizeModelCostsForDisplay(value);
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, redact(child, childKey)]));
  }
  return value;
}

function pathSegments(path: string): string[] {
  const segments = path.split(".").map(part => part.trim()).filter(Boolean);
  if (segments.length === 0 || segments.some(part => BLOCKED_SEGMENTS.has(part))) throw new CliUsageError("invalid config path", USAGE);
  return segments;
}

function getPath(root: unknown, path: string): unknown {
  let current = root;
  for (const segment of pathSegments(path)) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, segment)) throw new CliUsageError(`config path not found: ${path}`);
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function setPath(root: Record<string, unknown>, path: string, value: unknown, remove = false): void {
  const segments = pathSegments(path);
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (!next || typeof next !== "object" || Array.isArray(next)) throw new CliUsageError(`config parent path not found: ${segment}`, USAGE);
    current = next as Record<string, unknown>;
  }
  const leaf = segments.at(-1)!;
  if (remove && !Object.hasOwn(current, leaf)) throw new CliUsageError(`config path not found: ${path}`);
  if (remove) delete current[leaf];
  else current[leaf] = value;
}

function parseValue(raw: string): unknown {
  try { return JSON.parse(raw); }
  catch { return raw; }
}

function loadInput(path: string): unknown {
  const raw = path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
  try { return JSON.parse(raw); }
  catch { throw new CliUsageError(`invalid JSON in ${path}`); }
}

function visionReasoningError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const vision = (value as Record<string, unknown>).visionSidecar;
  if (!vision || typeof vision !== "object" || Array.isArray(vision)) return null;
  const reasoning = (vision as Record<string, unknown>).reasoning;
  if (reasoning === undefined || isVisionReasoningEffort(reasoning)) return null;
  return `schema_invalid: visionSidecar.reasoning: must be one of ${VISION_REASONING_EFFORTS.join(", ")}`;
}

function validateCandidate(value: unknown): ReturnType<typeof validateConfigCandidate> {
  const error = visionReasoningError(value);
  return error ? { ok: false, error } : validateConfigCandidate(value);
}

function normalizeVisionConfig(config: OcxConfig): OcxConfig {
  const vision = config.visionSidecar;
  if (!vision || vision.reasoning === undefined) return config;
  // Keep CLI import/set semantics aligned with the execution path: an omitted or blank model means
  // the bounded OpenAI vision default, gpt-5.6-luna, not the Dashboard's web-search default.
  const model = vision.model || "gpt-5.6-luna";
  const normalized = normalizeVisionReasoningForModel(model, vision.reasoning);
  if (normalized === undefined) delete vision.reasoning;
  else vision.reasoning = normalized;
  return config;
}

function validate(value: unknown): OcxConfig {
  const result = validateCandidate(value);
  if (!result.ok) throw new CliUsageError(result.error);
  return normalizeVisionConfig(result.config);
}

export async function handleConfigCommand(argv: string[]): Promise<number> {
  return runCliAction(async () => {
    const args = [...argv];
    const action = (args.shift() ?? "show").toLowerCase();
    const wantsJson = takeFlag(args, "--json");
    if (action === "show") {
      const source = takeFlag(args, "--source");
      rejectArgs(args, USAGE);
      const diagnostics = readConfigDiagnostics();
      const redacted = redact(diagnostics.config);
      // Imported here rather than at module scope: `./connect` pulls the whole client lifecycle
      // in, and `ocx config get/set` has no use for it.
      const { collectClientConnectionStatus } = await import("./connect");
      // The readiness probe is declined explicitly. `collectClientConnectionStatus` observes the
      // local Codex ladder for a connected client, and observing it spawns `codex debug models`
      // under a 45s budget. `ocx config show` reads only `state`, `reason` and `token` from the
      // result, so paying for a subprocess here would buy nothing and would quietly turn a
      // read-only config dump into a runtime probe. Returning no ladder resolves readiness to
      // `unverified`, which is the honest answer for a caller that never asked.
      const note = remoteHubConfigNote(
        diagnostics.config,
        () => collectClientConnectionStatus(undefined, undefined, { supportedEfforts: () => null }),
      );
      // First key, not last: it has to be read before the empty `providers` map that misled a
      // reader into concluding nothing was configured anywhere.
      const config = note && redacted && typeof redacted === "object" && !Array.isArray(redacted)
        ? { _remoteHub: note, ...redacted as Record<string, unknown> }
        : redacted;
      const result = source ? { config, source: diagnostics.source, error: diagnostics.error, warnings: diagnostics.warnings ?? [] } : config;
      printData(result, true);
      return;
    }
    if (action === "get") {
      const path = args.shift();
      if (!path) throw new CliUsageError("config path is required", USAGE);
      rejectArgs(args, USAGE);
      const value = redact(getPath(readConfigDiagnostics().config, path), path.split(".").at(-1));
      if (wantsJson || typeof value === "object") console.log(JSON.stringify(value, null, 2));
      else console.log(String(value));
      return;
    }
    if (action === "set" || action === "unset") {
      const path = args.shift();
      const raw = action === "set" ? args.shift() : undefined;
      if (!path || (action === "set" && raw === undefined)) throw new CliUsageError("config path and value are required", USAGE);
      rejectArgs(args, USAGE);
      // #1835/#1838: the read used to happen OUTSIDE the mutation lock, so a concurrent
      // edit landing between it and the save was reverted by this whole-snapshot write.
      // `mutatePersistedConfig` reruns this callback against the latest validated disk
      // state, so the operation is applied to what is actually there at commit time.
      let savedValue: unknown = null;
      const outcome = mutatePersistedConfig(fresh => {
        // Snapshot BEFORE mutating: comparing after the write compares a value with
        // itself and would report every no-op as a change, bumping the generation.
        const before = JSON.stringify(fresh);
        const candidate = structuredClone(fresh) as unknown as Record<string, unknown>;
        setPath(candidate, path, raw === undefined ? undefined : parseValue(raw), action === "unset");
        const config = validate(candidate);
        savedValue = action === "unset" ? null : getPath(config, path);
        // Setting the order here is the operator restating it, exactly as through
        // `ocx account priority` or the management route, so it releases the manual pin
        // for the same reason those do: a pin made before any order existed would
        // otherwise outrank every order set afterwards, capping the pool at the pinned
        // account's tier with nothing on any surface explaining why. `import` is
        // deliberately not covered — that file supplies its own pin, so there is no
        // stale one to release.
        if (pathSegments(path)[0] === "codexAccountPriorities") clearCodexAccountPin(config);
        // REPLACE rather than merge: `Object.assign` alone cannot remove a key that
        // `unset` deleted, which would make unset silently succeed while changing nothing.
        for (const key of Object.keys(fresh)) {
          if (!(key in (config as unknown as Record<string, unknown>))) {
            delete (fresh as unknown as Record<string, unknown>)[key];
          }
        }
        Object.assign(fresh, config);
        return { changed: JSON.stringify(fresh) !== before, value: undefined };
      });
      if (outcome.status === "unavailable") {
        throw new Error(outcome.reason === "conflict"
          ? "config changed while applying this update; retry"
          : `config is ${outcome.reason}`);
      }
      printData({ ok: true, path, value: redact(savedValue, path.split(".").at(-1)) }, wantsJson,
        [`${action === "unset" ? "Unset" : "Set"} ${path}.`]);
      return;
    }
    if (action === "validate") {
      const path = args.shift();
      rejectArgs(args, USAGE);
      const result = path ? validateCandidate(loadInput(path)) : (() => {
        const diagnostics = readConfigDiagnostics();
        if (diagnostics.error) return { ok: false as const, error: diagnostics.error };
        return validateCandidate(diagnostics.config);
      })();
      printData(result.ok ? { ok: true, source: path ?? getConfigPath() } : result, wantsJson,
        [result.ok ? "Config is valid." : `Config is invalid: ${result.error}`]);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (action === "export") {
      const path = args.shift();
      if (!path) throw new CliUsageError("export path is required", USAGE);
      rejectArgs(args, USAGE);
      const content = `${JSON.stringify(readConfigDiagnostics().config, null, 2)}\n`;
      if (path === "-") process.stdout.write(content);
      else { writeFileSync(path, content, { encoding: "utf8", mode: 0o600 }); console.log(`Exported config to ${path}.`); }
      return;
    }
    if (action === "import") {
      const path = args.shift();
      const yes = takeFlag(args, "--yes");
      if (!path) throw new CliUsageError("import path is required", USAGE);
      if (!yes) throw new CliUsageError("import requires --yes", USAGE);
      rejectArgs(args, USAGE);
      saveConfig(validate(loadInput(path)));
      printData({ ok: true, source: path }, wantsJson, [`Imported config from ${path}. Restart or run ocx sync if needed.`]);
      return;
    }
    throw new CliUsageError(`unknown config command ${action}`, USAGE);
  });
}

export const CONFIG_USAGE = USAGE;
