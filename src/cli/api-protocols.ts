/**
 * `ocx api protocols | explain | policy`: the CLI side of the protocol management routes
 * (`src/server/management/protocol-routes.ts`).
 *
 * - `protocols` reads `GET /api/protocols` (optionally `?provider=<name>`).
 * - `explain` posts `POST /api/protocols/plan`: a preview computed from config that sends
 *   nothing upstream.
 * - `policy` with no setting flag reads the same GET; with one it sends
 *   `PATCH /api/protocols/settings`, which changes the operator's config. It is only ever
 *   invoked explicitly: nothing in the CLI calls it on the operator's behalf.
 *
 * Validation of values the server owns (rollout switch names, cross-field rules) stays on the
 * server, so the two cannot drift; the CLI rejects only malformed argv.
 */
import { isProtocol } from "../protocols/contract";
import { isProtocolFeature } from "../protocols/features";
import {
  CliUsageError,
  csv,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  takeFlag,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";

const USAGE = `Usage:
  ocx api protocols [--provider <name>] [--json]
  ocx api explain --model <id> --inbound <responses|chat|messages> [--feature <key>[,<key>]]... [--json]
  ocx api policy [--messages <on|off>] [--unrepresentable <legacy|reject>]
      [--rollout <switch>=<on|off>]... [--json]`;

type Rec = Record<string, unknown>;
function isRec(value: unknown): value is Rec {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Every value of a repeatable option, in argv order. */
function takeRepeated(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let value = takeOption(args, flag); value !== undefined; value = takeOption(args, flag)) values.push(value);
  return values;
}

function onOff(flag: string, raw: string): boolean {
  if (raw === "on") return true;
  if (raw === "off") return false;
  throw new CliUsageError(`${flag} must be on or off`, USAGE);
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "-";
}

function list(value: unknown): string {
  return Array.isArray(value) && value.length > 0 ? value.map(text).join(", ") : "none";
}

/** Human view of the `GET /api/protocols` body (also the PATCH answer). */
export function protocolInfoLines(payload: unknown): string[] {
  if (!isRec(payload)) return [text(payload)];
  const lines = [
    `Contract: ${text(payload.contractVersion)}  policy revision: ${text(payload.policyRevision)}`,
  ];
  if (isRec(payload.surfaces)) {
    for (const [name, surface] of Object.entries(payload.surfaces)) {
      if (!isRec(surface)) continue;
      lines.push(`API ${name}: ${surface.enabled === true ? "open" : "closed"} (${text(surface.source)})`);
    }
  }
  if (isRec(payload.settings)) {
    lines.push(`Unrepresentable features: ${text(payload.settings.unrepresentable)}`);
    if (isRec(payload.settings.rollout)) {
      for (const [name, on] of Object.entries(payload.settings.rollout)) {
        lines.push(`Rollout ${name}: ${on === true ? "on" : "off"}`);
      }
    }
  }
  if (Array.isArray(payload.features)) lines.push(`Features: ${payload.features.length} known (--json lists them)`);
  if (isRec(payload.provider)) {
    const provider = payload.provider;
    lines.push(
      `Provider ${text(provider.name)}: adapter ${text(provider.adapter)} (${text(provider.adapterSource)}), `
        + `upstream ${text(provider.upstream)}, auth ${text(provider.authMode)}`,
    );
    const overrides = Array.isArray(provider.modelOverrides) ? provider.modelOverrides : [];
    for (const override of overrides) {
      if (!isRec(override)) continue;
      lines.push(`  model ${text(override.model)}: adapter ${text(override.adapter)} (${text(override.source)})`);
    }
    if (provider.modelOverridesTruncated === true) lines.push("  more model overrides exist; --json has the same capped list");
  }
  return lines;
}

/** Human view of a `ProtocolPlanV1`. */
export function protocolPlanLines(plan: unknown): string[] {
  if (!isRec(plan)) return [text(plan)];
  const lines = [
    `${text(plan.inbound)} ${text(plan.requestedModel)}: ${text(plan.mode)} (${text(plan.routeKind)} route, ${text(plan.basis)})`,
    `Reasons: ${list(plan.reasonCodes)}`,
  ];
  const candidates = Array.isArray(plan.candidates) ? plan.candidates : [];
  for (const candidate of candidates) {
    if (!isRec(candidate)) continue;
    const path = Array.isArray(candidate.requestPath) && candidate.requestPath.length > 0
      ? candidate.requestPath.map(text).join(" > ")
      : "no path";
    lines.push(
      `  ${text(candidate.provider)}/${text(candidate.model)}: ${text(candidate.mode)} ${path}`
        + `${candidate.eligible === false ? " (refused under reject)" : ""}`,
    );
  }
  lines.push(`Guaranteed features: ${list(plan.guaranteedFeatures)}`);
  lines.push(`Partial features: ${list(plan.partialFeatures)}`);
  return lines;
}

async function protocols(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const provider = takeOption(args, "--provider");
  rejectArgs(args, USAGE);
  const path = provider === undefined ? "/api/protocols" : `/api/protocols?provider=${encodeURIComponent(provider)}`;
  const result = await runtimeRequest(path, {}, deps);
  printData(result, wantsJson, protocolInfoLines(result));
}

async function explain(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const model = takeOption(args, "--model");
  const inbound = takeOption(args, "--inbound");
  const features = takeRepeated(args, "--feature").flatMap(value => csv(value) ?? []);
  rejectArgs(args, USAGE);
  if (!model) throw new CliUsageError("--model is required", USAGE);
  if (!isProtocol(inbound)) throw new CliUsageError("--inbound must be responses, chat or messages", USAGE);
  const unknown = features.filter(feature => !isProtocolFeature(feature));
  if (unknown.length > 0) throw new CliUsageError("--feature names a feature this CLI does not know; `ocx api protocols --json` lists them", USAGE);
  const body = { model, inbound, ...(features.length > 0 ? { features: [...new Set(features)] } : {}) };
  const result = await runtimeRequest("/api/protocols/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, deps);
  printData(result, wantsJson, protocolPlanLines(result));
}

/** The `PATCH /api/protocols/settings` body the flags describe, or `undefined` for a read. */
export function protocolPolicyPatch(args: string[]): Rec | undefined {
  const messages = takeOption(args, "--messages");
  const unrepresentable = takeOption(args, "--unrepresentable");
  const rolloutArgs = takeRepeated(args, "--rollout");
  const body: Rec = {};
  if (messages !== undefined) body.messagesEnabled = onOff("--messages", messages);
  if (unrepresentable !== undefined) {
    if (unrepresentable !== "legacy" && unrepresentable !== "reject") {
      throw new CliUsageError("--unrepresentable must be legacy or reject", USAGE);
    }
    body.unrepresentable = unrepresentable;
  }
  if (rolloutArgs.length > 0) {
    const rollout: Rec = {};
    for (const entry of rolloutArgs) {
      const match = /^([A-Za-z]+)=(on|off)$/.exec(entry);
      if (!match) throw new CliUsageError("--rollout takes <switch>=<on|off>", USAGE);
      if (Object.hasOwn(rollout, match[1]!)) throw new CliUsageError("--rollout names the same switch twice", USAGE);
      rollout[match[1]!] = match[2] === "on";
    }
    body.rollout = rollout;
  }
  return Object.keys(body).length > 0 ? body : undefined;
}

async function policy(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const patch = protocolPolicyPatch(args);
  rejectArgs(args, USAGE);
  // No setting flag means show. A read must not write the value it is reporting.
  if (!patch) {
    const result = await runtimeRequest("/api/protocols", {}, deps);
    printData(result, wantsJson, protocolInfoLines(result));
    return;
  }
  const result = await runtimeRequest("/api/protocols/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  }, deps);
  printData(result, wantsJson, ["Protocol settings updated.", ...protocolInfoLines(result)]);
}

export async function handleApiCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const [sub, ...rest] = argv;
    if (sub === "protocols") await protocols(rest, deps);
    else if (sub === "explain") await explain(rest, deps);
    else if (sub === "policy") await policy(rest, deps);
    else throw new CliUsageError(sub ? `unknown api command ${sub}` : "an api command is required", USAGE);
  });
}

export const API_USAGE = USAGE;
