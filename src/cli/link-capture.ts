import { getConfigDir } from "../config/paths";
import { linkDir } from "../link/paths";
import {
  readSshCaptureStatus, SSH_CAPTURE_DEFAULT_MINUTES, SSH_CAPTURE_MAX_MINUTES, startSshCapture, stopSshCapture,
  type SshCaptureStatus,
} from "../link/ssh-capture";
import { CliUsageError, printData, rejectArgs, takeIntegerOption, takeJsonFlag } from "./runtime-api";

export const LINK_CAPTURE_USAGE = [
  "ocx link capture start [--minutes <1-" + SSH_CAPTURE_MAX_MINUTES + ">] [--json]",
  "ocx link capture stop [--json]",
  "ocx link capture status [--json]",
];

export interface LinkCaptureDeps {
  /** Test seam: the link directory whose ssh-capture/ the command manages. */
  captureLinkDir?: string;
  /** Test seam: the clock the capture window and retention read. */
  captureNow?: () => number;
}

function statusLines(status: SshCaptureStatus, verb: "start" | "stop" | "status"): string[] {
  const lines = [status.enabled
    ? "SSH capture: on until " + status.expiresAt + " (the next tunnel attempt runs ssh with LogLevel=DEBUG1)"
    : "SSH capture: off (the next tunnel attempt runs ssh with LogLevel=ERROR)"];
  if (verb === "start") {
    lines.push("A tunnel that is already connected keeps its log level until it reconnects. On the Home,",
      "ocx link reconnect --link-id <id> starts a new attempt now.");
  }
  lines.push("Directory: " + status.directory);
  if (status.removed > 0) lines.push("Deleted " + status.removed + " capture file(s) past retention or beyond the file limit.");
  if (status.files.length === 0) lines.push("No capture files.");
  else {
    lines.push("Capture files (deleted " + status.retentionHours + " h after their last write):");
    for (const file of status.files) {
      lines.push("  " + file.name + "  " + file.bytes + " bytes  last write " + file.lastWriteAt + "  deleted after " + file.deleteAfter);
    }
  }
  return lines;
}

/** ocx link capture: a local file operation on this machine; it needs no running proxy and no token. */
export async function runLinkCapture(args: string[], deps: LinkCaptureDeps, usage: string): Promise<void> {
  const verb = args.shift();
  const json = takeJsonFlag(args);
  const directory = deps.captureLinkDir ?? linkDir(getConfigDir());
  const now = (deps.captureNow ?? Date.now)();
  let status: SshCaptureStatus;
  if (verb === "start") {
    const minutes = takeIntegerOption(args, "--minutes", { min: 1, max: SSH_CAPTURE_MAX_MINUTES }) ?? SSH_CAPTURE_DEFAULT_MINUTES;
    rejectArgs(args, usage);
    status = startSshCapture({ linkDirectory: directory, now, minutes });
  } else if (verb === "stop") {
    rejectArgs(args, usage);
    status = stopSshCapture(directory, now);
  } else if (verb === "status") {
    rejectArgs(args, usage);
    status = readSshCaptureStatus(directory, now);
  } else {
    throw new CliUsageError("link capture requires one of: start, stop, status", usage);
  }
  printData(status, json, statusLines(status, verb));
}

