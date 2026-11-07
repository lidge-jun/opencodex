import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isatty } from "node:tty";
import { getConfigDir, mutatePersistedConfig, readConfigDiagnostics } from "../config";
import { atomicWriteFileNoFollow } from "../config/atomic-write";
import { withConfigDirHardeningSettled } from "../config/paths";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { resolveTelemetryStatus } from "../telemetry/consent";
import { deleteTelemetryInstallId } from "../telemetry/install-id";
import { buildTelemetryStatusSnapshot, type TelemetryStatusSnapshot } from "../telemetry/routes";
import type { OcxTelemetryConfig, OcxTelemetryDecision } from "../types";
import { currentVersion } from "../update/index";
import { isAgentDriven } from "./agent-driven";
import { interactiveConfirm } from "./interactive-confirm";
import {
  CliUsageError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  takeFlag,
  type RuntimeApiDeps,
} from "./runtime-api";

const USAGE = `Usage:
  ocx telemetry [status] [--json]
  ocx telemetry enable [--json]
  ocx telemetry disable [--json]`;

export const TELEMETRY_DEFERRAL_FILE = ".telemetry-deferred";
const DEFERRAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function isTelemetryDeferralCurrent(record: string | null, version: string, now: number): boolean {
  if (!record) return false;
  const match = /^(\S+)\s+(\S+)\s*$/.exec(record.trim());
  if (!match) return false;
  const at = Date.parse(match[1]!);
  if (Number.isNaN(at)) return false;
  const age = now - at;
  if (version !== "?" && match[2] === version) return age >= 0;
  return age >= 0 && age < DEFERRAL_MAX_AGE_MS;
}

export interface TelemetryPromptTestDeps {
  interactiveConfirm?: typeof interactiveConfirm;
  isTty?: () => boolean;
}

let promptDepsForTests: TelemetryPromptTestDeps | null = null;

export function setTelemetryPromptDepsForTests(deps: TelemetryPromptTestDeps | null): void {
  promptDepsForTests = deps;
}

async function persistTelemetryDecision(decision: OcxTelemetryDecision): Promise<void> {
  const nowIso = new Date().toISOString();
  const dir = getConfigDir();
  await withConfigDirHardeningSettled(dir, () =>
    mutatePersistedConfig(fresh => {
      const prev = fresh.telemetry;
      const next: OcxTelemetryConfig = {
        decision,
        decidedAt: nowIso,
        noticeShownAt: prev?.noticeShownAt ?? nowIso,
      };
      const changed = JSON.stringify(prev) !== JSON.stringify(next);
      fresh.telemetry = next;
      return { changed, value: next };
    }),
  );
  if (decision === "declined") {
    deleteTelemetryInstallId(dir);
  }
}

/**
 * One-time telemetry consent prompt for interactive starts (`ocx start`, `ocx service install`,
 * `ocx init`). Under an agent-driven session, non-TTY, or `OCX_SERVICE=1`, prints a one-line
 * notice at most once per version and records neither `noticeShownAt` nor `decision`.
 */
export async function maybeShowTelemetryPrompt(): Promise<void> {
  try {
    const diagnostics = readConfigDiagnostics({ passive: true });
    const status = resolveTelemetryStatus(diagnostics.config, process.env);
    if (status.envOverride !== null || status.decision !== null || status.noticeShownAt !== null) {
      return;
    }
    let isTty = false;
    try {
      isTty = promptDepsForTests?.isTty ? promptDepsForTests.isTty() : isatty(0) && isatty(1);
    } catch {
      /* best-effort */
    }
    const dir = getConfigDir();
    if (isAgentDriven() || !isTty || Boolean(process.env.OCX_SERVICE)) {
      const deferralPath = join(dir, TELEMETRY_DEFERRAL_FILE);
      let record: string | null = null;
      try {
        const stat = lstatSync(deferralPath);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024) {
          record = readFileSync(deferralPath, "utf8");
        }
      } catch { /* best-effort */ }
      const version = currentVersion();
      if (isTelemetryDeferralCurrent(record, version, Date.now())) return;
      console.log(
        "  ℹ️  Anonymous telemetry is awaiting human consent (run 'ocx telemetry status' or open the dashboard; disable anytime with 'ocx telemetry disable' or OCX_TELEMETRY=0).",
      );
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        recordOwnedConfigPath(dir, deferralPath);
        atomicWriteFileNoFollow(deferralPath, `${new Date().toISOString()} ${version}\n`);
      } catch { /* best-effort */ }
      return;
    }
    const ask = promptDepsForTests?.interactiveConfirm ?? interactiveConfirm;
    const yes = await ask({
      question: "\n  Share anonymous usage statistics? [Y/n]",
      defaultYes: true,
    });
    await persistTelemetryDecision(yes ? "accepted" : "declined");
  } catch {
    /* never disrupt startup or setup */
  }
}

function formatStatusLines(snapshot: TelemetryStatusSnapshot): string[] {
  return [
    `Telemetry: ${snapshot.effective ? "enabled" : "disabled"} (${snapshot.reason})`,
    `Decision: ${snapshot.decision ?? "undecided"}`,
    ...(snapshot.envOverride ? [`Environment override: ${snapshot.envOverride}`] : []),
    `Install channel: ${snapshot.installChannel}`,
    `Last sent day: ${snapshot.lastSentDay ?? "never"}`,
    `Preview (${snapshot.preview.day}):`,
    JSON.stringify(snapshot.preview, null, 2),
  ];
}

async function readLiveOrLocalSnapshot(deps: RuntimeApiDeps): Promise<TelemetryStatusSnapshot> {
  try {
    return await runtimeRequest("/api/telemetry", {}, deps) as TelemetryStatusSnapshot;
  } catch {
    const config = readConfigDiagnostics({ passive: true }).config;
    return await buildTelemetryStatusSnapshot(config);
  }
}

export async function handleTelemetryCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const sub = (args.shift() ?? "status").toLowerCase();
  if (sub === "enable" && isAgentDriven()) {
    const error = {
      ok: false,
      code: "agent_consent_required",
      error: "Refused: telemetry consent must be enabled by a human user in their own terminal or dashboard.",
    };
    if (wantsJson) console.log(JSON.stringify(error, null, 2));
    else console.error(`${error.code}: ${error.error}`);
    return 1;
  }
  return runCliAction(async () => {
    if (args.includes("--json")) {
      throw new CliUsageError("telemetry flags may only be specified once", USAGE);
    }
    if (sub === "status") {
      rejectArgs(args, USAGE);
      const snapshot = await readLiveOrLocalSnapshot(deps);
      printData(snapshot, wantsJson, formatStatusLines(snapshot));
      return;
    }
    if (sub === "enable") {
      rejectArgs(args, USAGE);
      await persistTelemetryDecision("accepted");
      const snapshot = await buildTelemetryStatusSnapshot(readConfigDiagnostics({ passive: true }).config);
      printData({ ok: true, ...snapshot }, wantsJson, ["Anonymous telemetry enabled."]);
      return;
    }
    if (sub === "disable") {
      rejectArgs(args, USAGE);
      await persistTelemetryDecision("declined");
      const snapshot = await buildTelemetryStatusSnapshot(readConfigDiagnostics({ passive: true }).config);
      printData({ ok: true, ...snapshot }, wantsJson, [
        "Anonymous telemetry disabled and local telemetry identifier removed.",
      ]);
      return;
    }
    throw new CliUsageError(`unknown telemetry command ${sub}`, USAGE);
  });
}

export const TELEMETRY_USAGE = USAGE;
