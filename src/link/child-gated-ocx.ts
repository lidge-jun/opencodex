import { LinkSshArgumentError, remoteGatedOcxArgv } from "./ssh-argv";
import { parseStrictSemver } from "../lib/strict-semver";
import { classifyChildUpdatePlan, mapUpdateApplyExit, parseChildUpdatePlan, PLAN_TOKEN_PATTERN, type PlanClassification,
  type UpdateApplyVerdict } from "./child-update-contract";

export type SshResult = { code: number; stdout: string; stderr: string };
export type GatedRefusal = "child-ocx-lacks-expect-link" | "child-ocx-lacks-orchestrated-update" | "child-ocx-version-unknown" | "child-ocx-ephemeral" | "child-gate-failed";
export type GatedFraming =
  | { kind: "transport"; reason: "ssh-failed" | "child-ocx-not-found" | "child-ocx-not-contained" | "child-platform-unsupported" }
  | { kind: "refused"; reason: GatedRefusal }
  | { kind: "ran"; code: number; selectedVersion: string; entry: "pair" | "binary" | null; childNowMs: number | null; payload: string; lastStderrLine: string | undefined }
  | { kind: "invalid" };

function assertHomeVersion(version: string): void {
  if (version.length > 128 || !parseStrictSemver(version)) throw new LinkSshArgumentError("invalid Home version");
}
const UPDATE_GATE = { minVersion: "2.97.0", lacksMarker: "child-ocx-lacks-orchestrated-update", acceptEphemeral: false, reportEntry: true, reportClock: false } as const;

/**
 * Never mutates an install: below 2.97.0 the gate exits 121 before update runs, and update --plan only computes.
 * Not free of side effects on every Child: without a census pair (an npm/pnpm Child whose service never recorded one)
 * the script execs the ocx shim, so the Node launcher's ordinary bootstrap runs first (sync-guard bookkeeping, Bun
 * resolution; the Desktop handoff is disabled), exactly as for every pinned sync already sent to that Child. The probe
 * prints the Child's clock so the apply deadline can be set in the Child's time.
 */
export function remoteUpdatePlanArgv(homeVersion: string, platform: "posix" | "windows"): string[] {
  assertHomeVersion(homeVersion);
  return remoteGatedOcxArgv({ ...UPDATE_GATE, reportClock: true, args: ["update", "--plan", "--json", "--version", homeVersion] }, platform);
}

/**
 * The shipped builders refuse Windows apply: a dropped channel kills the orchestrating parent with the Job.
 * A token starting with "-" cannot pass the Child's --expect-plan parser (orchestrated-arguments.mjs refuses a value
 * that looks like a flag), so it is omitted; the apply stays pinned by --version, bounded by --not-after, serialized
 * by the Child's update mutex and refused on downgrade. Only the plan-consistency check is lost for that token.
 */
export function remoteUpdateApplyArgv(input: { homeVersion: string; planToken: string; notAfter: number }, platform: "posix" | "windows"): string[] {
  if (platform === "windows") throw new LinkSshArgumentError("unsupported:windows-apply");
  assertHomeVersion(input.homeVersion);
  if (!PLAN_TOKEN_PATTERN.test(input.planToken)) throw new LinkSshArgumentError("invalid plan token");
  if (!Number.isSafeInteger(input.notAfter) || input.notAfter <= 0) throw new LinkSshArgumentError("invalid deadline");
  const expectPlan = input.planToken.startsWith("-") ? [] : ["--expect-plan", input.planToken];
  return remoteGatedOcxArgv({ ...UPDATE_GATE, args: ["update", "--yes", "--json", "--version", input.homeVersion,
    ...expectPlan, "--not-after", String(input.notAfter)] }, platform);
}

const REFUSAL = /^ocx-fanout:(child-ocx-lacks-expect-link|child-ocx-lacks-orchestrated-update|child-ocx-version-unknown|child-ocx-ephemeral)$/;
const CHILD_NOW = "ocx-fanout:child-now:";

/**
 * The framing classifySyncResult applies, generalised to every gated command. A run is recognised by exactly one
 * selection marker and one stdout delimiter before the exit code is read, so an exit the selected ocx itself returns
 * after selection (even 121, 126, 127 or 255) is a run, never a transport failure or a gate refusal.
 */
export function readGatedFraming(result: SshResult): GatedFraming {
  const { code, stdout, stderr } = result;
  const lines = stderr.split(/\r?\n/);
  const last = stderr.trimEnd().split(/\r?\n/).at(-1);
  const selected = lines.map(line => /^ocx-fanout:selected:(.+)$/.exec(line)).filter(match => match !== null);
  const out = stdout.split(/\r?\n/);
  const delimiters = out.flatMap((line, index) => line === "ocx-fanout:stdout-begin" ? [index] : []);
  if (selected.length !== 1 || delimiters.length !== 1) {
    if (code === 255) return { kind: "transport", reason: "ssh-failed" };
    if (code === 127) return { kind: "transport", reason: "child-ocx-not-found" };
    if (code === 126) return { kind: "transport", reason: "child-ocx-not-contained" };
    if (code === 125) return { kind: "transport", reason: "child-platform-unsupported" };
    if (code === 121) return { kind: "refused", reason: (REFUSAL.exec(last ?? "")?.[1] ?? "child-gate-failed") as GatedRefusal };
    return { kind: "invalid" };
  }
  if (!parseStrictSemver(selected[0]![1]!)) return { kind: "invalid" };
  const entries = lines.filter(line => /^ocx-fanout:entry:(pair|binary)$/.test(line));
  if (entries.length > 1) return { kind: "invalid" };
  // Capture any value and validate it afterwards, so a malformed clock makes the framing invalid instead of absent.
  const clocks = lines.filter(line => line.startsWith(CHILD_NOW)).map(line => line.slice(CHILD_NOW.length));
  if (clocks.length > 1 || (clocks.length === 1 && (!/^[0-9]{10,16}$/.test(clocks[0]!) || !Number.isSafeInteger(Number(clocks[0]))))) return { kind: "invalid" };
  return { kind: "ran", code, selectedVersion: selected[0]![1]!, entry: entries.length ? (entries[0]!.slice("ocx-fanout:entry:".length) as "pair" | "binary") : null,
    childNowMs: clocks.length ? Number(clocks[0]) : null, payload: out.slice(delimiters[0]! + 1).join("\n").trim(), lastStderrLine: last };
}

export type PlanProbeVerdict =
  | { kind: "plan"; selectedVersion: string; classification: PlanClassification; childNowMs: number | null }
  | { kind: "legacy"; reason: "child-ocx-lacks-orchestrated-update" | "child-ocx-version-unknown" }
  | { kind: "ephemeral" }
  | { kind: "offline"; reason: "ssh-failed" }
  | { kind: "failed"; reason: string };

/** platform "windows": the Windows script prints no entry marker because it reads no census, so the entry is "binary". */
export function classifyUpdatePlanProbe(result: SshResult, ctx: { homeVersion: string; desktopUpdateRequest: boolean; platform?: "posix" | "windows" }): PlanProbeVerdict {
  const framing = readGatedFraming(result);
  if (framing.kind === "transport") return framing.reason === "ssh-failed" ? { kind: "offline", reason: "ssh-failed" } : { kind: "failed", reason: framing.reason };
  if (framing.kind === "refused") {
    if (framing.reason === "child-ocx-ephemeral") return { kind: "ephemeral" };
    if (framing.reason === "child-ocx-lacks-orchestrated-update" || framing.reason === "child-ocx-version-unknown") return { kind: "legacy", reason: framing.reason };
    return { kind: "failed", reason: framing.reason };
  }
  if (framing.kind === "invalid") return { kind: "failed", reason: "child-output-invalid" };
  if (framing.code !== 0) return { kind: "failed", reason: framing.code === 64 ? "contract-usage" : "child-plan-failed" };
  const parsed = parseChildUpdatePlan(framing.payload);
  if (!parsed.ok) return { kind: "failed", reason: parsed.reason };
  const entry = framing.entry ?? (ctx.platform === "windows" ? "binary" : null);
  return { kind: "plan", selectedVersion: framing.selectedVersion, childNowMs: framing.childNowMs,
    classification: classifyChildUpdatePlan(parsed.value, { homeVersion: ctx.homeVersion, desktopUpdateRequest: ctx.desktopUpdateRequest, entry }) };
}

export function classifyUpdateApply(result: SshResult): UpdateApplyVerdict {
  const framing = readGatedFraming(result);
  if (framing.kind === "transport") return framing.reason === "ssh-failed"
    ? { state: "uncertain", reason: "ssh-failed", suppressTarget: false, reobserve: true }
    : { state: "failed", reason: framing.reason, suppressTarget: false, reobserve: false };
  if (framing.kind === "refused") return framing.reason === "child-ocx-ephemeral"
    ? { state: "unsupported", reason: "ephemeral", suppressTarget: false, reobserve: false }
    : { state: "owner-action", reason: framing.reason === "child-gate-failed" ? "child-gate-failed" : "legacy-ocx", suppressTarget: false, reobserve: false };
  // Framing broken after a command may have run: never assume it did not.
  if (framing.kind === "invalid") return { state: "uncertain", reason: "child-output-invalid", suppressTarget: false, reobserve: true };
  return mapUpdateApplyExit(framing.code, framing.payload);
}

