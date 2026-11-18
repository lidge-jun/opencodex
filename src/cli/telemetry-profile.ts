import { isatty } from "node:tty";
import { PROFILE_AVATARS, isProfileAvatar, type ProfileRankV1 } from "../telemetry/profile/contract";
import { PROFILE_DISCLOSURE_HEADING, PROFILE_DISCLOSURE_POINTS } from "../telemetry/profile/disclosure";
import {
  ProfileActionError,
  buildProfileStatusSnapshot,
  connectTelemetryProfile,
  disconnectTelemetryProfile,
  fetchConnectedProfileRank,
  type ProfileStatusSnapshot,
} from "../telemetry/profile/service";
import { isAgentDriven } from "./agent-driven";
import { interactiveConfirm } from "./interactive-confirm";
import {
  CliUsageError,
  RuntimeApiError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";

export const TELEMETRY_PROFILE_USAGE = `Usage:
  ocx telemetry profile [status] [--json]
  ocx telemetry profile connect --handle <handle> [--name <display name>] [--avatar <${PROFILE_AVATARS.join("|")}>] [--json]
  ocx telemetry profile disconnect [--json]`;

export const PROFILE_CLI_DISCLOSURE_LINES = Object.freeze([
  `  ${PROFILE_DISCLOSURE_HEADING}`,
  ...PROFILE_DISCLOSURE_POINTS.map(point => `  • ${point}`),
]);

export interface TelemetryProfileCliTestDeps {
  interactiveConfirm?: typeof interactiveConfirm;
  isTty?: () => boolean;
}

let testDeps: TelemetryProfileCliTestDeps | null = null;

export function setTelemetryProfileCliDepsForTests(deps: TelemetryProfileCliTestDeps | null): void {
  testDeps = deps;
}

function isInteractiveTty(): boolean {
  try {
    return testDeps?.isTty ? testDeps.isTty() : Boolean(isatty(0) && isatty(1));
  } catch {
    return false;
  }
}

function refuse(code: string, error: string, wantsJson: boolean): number {
  if (wantsJson) console.log(JSON.stringify({ ok: false, code, error }, null, 2));
  else console.error(`${code}: ${error}`);
  return 1;
}

function rankLines(rank: ProfileRankV1 | null): string[] {
  if (!rank) return [];
  return (["day", "week", "month"] as const).map(period => {
    const entry = rank.periods[period];
    const position = entry.rank === null ? "not ranked yet" : `#${entry.rank} of ${entry.of}`;
    return `  ${period.padEnd(5)} ${position} · ${entry.tokens.toLocaleString("en-US")} tokens · ${entry.requests.toLocaleString("en-US")} requests`;
  });
}

function statusLines(snapshot: ProfileStatusSnapshot, rank: ProfileRankV1 | null): string[] {
  if (snapshot.unreadable) {
    return ["Public profile: the local profile file cannot be read; nothing is sent. Run 'ocx telemetry profile disconnect' for details."];
  }
  if (!snapshot.profile) {
    return [
      "Public profile: not connected.",
      snapshot.telemetryEffective
        ? "Connect one with 'ocx telemetry profile connect --handle <handle>' or from the dashboard Home."
        : "Anonymous telemetry is off; a public profile needs it on.",
    ];
  }
  const profile = snapshot.profile;
  const state = profile.pendingDelete
    ? "deletion pending (retried by the proxy)"
    : profile.revoked
      ? "revoked by the server; disconnect and connect again"
      : snapshot.telemetryEffective
        ? "connected"
        : "paused while anonymous telemetry is off";
  return [
    `Public profile: @${profile.handle} (${profile.displayName}) — ${state}`,
    `Connected: ${profile.connectedAt}; last sent day: ${profile.lastSentDay ?? "none yet"}`,
    snapshot.preview
      ? `Next submission (${snapshot.preview.day}): ${snapshot.preview.requests} requests, ${snapshot.preview.families.map(row => `${row.family} ${row.tokens} tokens`).join(", ")}; --json shows the exact payload`
      : `Next submission: none due (${snapshot.nextDayReason})`,
    ...rankLines(rank),
  ];
}

async function readSnapshot(deps: RuntimeApiDeps): Promise<ProfileStatusSnapshot> {
  try {
    return await runtimeRequest<ProfileStatusSnapshot>("/api/telemetry/profile", {}, deps);
  } catch {
    return await buildProfileStatusSnapshot();
  }
}

async function readRank(deps: RuntimeApiDeps): Promise<ProfileRankV1 | null> {
  try {
    const live = await runtimeRequest<{ rank?: ProfileRankV1 }>("/api/telemetry/profile/rank", {}, deps);
    return live.rank ?? null;
  } catch (error) {
    if (error instanceof RuntimeApiError && error.status !== 503) return null;
    const local = await fetchConnectedProfileRank();
    return local.ok ? local.rank : null;
  }
}

async function disconnect(deps: RuntimeApiDeps): Promise<{ status: string }> {
  try {
    return await runtimeRequest<{ status: string }>("/api/telemetry/profile", { method: "DELETE" }, deps);
  } catch (error) {
    // Only a stopped or unreachable proxy falls back; a refusal from a running proxy is reported.
    if (error instanceof RuntimeApiError && error.status !== 503) throw error;
    return await disconnectTelemetryProfile();
  }
}

export async function handleTelemetryProfileCommand(argv: string[], wantsJson: boolean, deps: RuntimeApiDeps = {}): Promise<number> {
  const args = [...argv];
  const sub = (args.shift() ?? "status").toLowerCase();
  if (sub === "connect") {
    if (isAgentDriven()) {
      return refuse(
        "agent_consent_required",
        "Refused: a public profile must be connected by a human user in their own interactive terminal or in the dashboard Home.",
        wantsJson,
      );
    }
    if (Boolean(process.env.OCX_SERVICE) || !isInteractiveTty()) {
      return refuse(
        "tty_required",
        "Refused: 'ocx telemetry profile connect' requires an interactive human terminal (TTY stdin and stdout, not OCX_SERVICE). Connect in an interactive terminal or from the dashboard Home.",
        wantsJson,
      );
    }
  }
  return runCliAction(async () => {
    if (sub === "status") {
      rejectArgs(args, TELEMETRY_PROFILE_USAGE);
      const snapshot = await readSnapshot(deps);
      const rank = snapshot.profile && !snapshot.profile.pendingDelete ? await readRank(deps) : null;
      printData({ ...snapshot, rank }, wantsJson, statusLines(snapshot, rank));
      return;
    }
    if (sub === "connect") {
      const handle = takeOption(args, "--handle");
      const name = takeOption(args, "--name");
      const avatar = takeOption(args, "--avatar") ?? "blue";
      rejectArgs(args, TELEMETRY_PROFILE_USAGE);
      if (!handle) throw new CliUsageError("--handle is required", TELEMETRY_PROFILE_USAGE);
      if (!isProfileAvatar(avatar)) throw new CliUsageError(`--avatar must be one of ${PROFILE_AVATARS.join(", ")}`, TELEMETRY_PROFILE_USAGE);
      // Refuse before asking anything when the connect could not succeed.
      const before = await buildProfileStatusSnapshot();
      if (!before.telemetryEffective) {
        throw new Error("telemetry_off: A public profile needs anonymous telemetry to be on: its totals come from the same daily aggregate.");
      }
      console.log(PROFILE_CLI_DISCLOSURE_LINES.join("\n"));
      const ask = testDeps?.interactiveConfirm ?? interactiveConfirm;
      const yes = await ask({ question: "\n  Create this public profile? [y/N]", defaultYes: false });
      if (!yes) throw new Error("Profile connect cancelled: confirmation was declined. Nothing was sent.");
      try {
        const profile = await connectTelemetryProfile({ handle, displayName: name ?? handle, avatar });
        // A running proxy starts its profile loop when it next reads the profile status.
        await runtimeRequest("/api/telemetry/profile", {}, deps).catch(() => undefined);
        printData({ ok: true, profile }, wantsJson, [
          `Public profile @${profile.handle} connected. Your first rank appears after the next completed UTC day.`,
        ]);
      } catch (error) {
        if (error instanceof ProfileActionError) throw new Error(`${error.code}: ${error.message}`);
        throw error;
      }
      return;
    }
    if (sub === "disconnect") {
      rejectArgs(args, TELEMETRY_PROFILE_USAGE);
      let outcome: { status: string };
      try {
        outcome = await disconnect(deps);
      } catch (error) {
        if (error instanceof ProfileActionError) throw new Error(`${error.code}: ${error.message}`);
        throw error;
      }
      const line = outcome.status === "deleted"
        ? "Public profile deleted on the server and disconnected."
        : outcome.status === "not_connected"
          ? "No public profile is connected."
          : outcome.status === "local_removed"
            ? "The unreadable local profile file was removed. Its secret could not be read, so the server profile was not deleted; it stops receiving data and is pruned after 400 days without submissions."
          : "deletion_pending: the telemetry service could not be reached. Nothing more is sent; the proxy retries the deletion on every tick and on its next start.";
      printData({ ok: true, ...outcome }, wantsJson, [line]);
      return;
    }
    throw new CliUsageError(`unknown telemetry profile command ${sub}`, TELEMETRY_PROFILE_USAGE);
  });
}

