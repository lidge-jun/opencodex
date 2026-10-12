import { z } from "zod";
import { REMOTE_WORKSPACE_CAPABILITIES, isRemoteWorkspaceToolName } from "../remote-control/workspace-tools";
import { runCatalogAction } from "./catalog-command-result";
import { CliUsageError, RuntimeApiError, printData, rejectArgs, runtimeRequest, takeFlag, type RuntimeApiDeps } from "./runtime-api";

export const REMOTE_WORKSPACE_HUB_USAGE = "Usage: ocx remote-workspace hub [status|runtimes|sessions] [--json]";
const UNAVAILABLE = "Remote Workspace requires Hub mode and OCX_REMOTE_WORKSPACE_ENABLED=1. Run this command on the intended Hub.";
const identity = z.string().min(1);
const capabilities = z.array(z.enum(REMOTE_WORKSPACE_CAPABILITIES));
const root = z.object({ id: identity, label: z.string() });
const device = z.object({
  id: identity, name: z.string(), platform: z.string(), capabilities, roots: z.array(root),
  online: z.boolean(), createdAt: z.string(), lastSeenAt: z.string().nullable(),
});
const availability = z.object({ available: z.boolean(), version: z.string().optional(), reason: z.string().optional() });
const runtimes = z.object({ codex: availability, claude: availability, pi: availability });
const event = z.object({ sequence: z.number().int().nonnegative(), at: z.string(),
  type: z.enum(["status", "assistant", "tool", "error"]), text: z.string() });
const session = z.object({
  id: identity, profile: z.enum(["codex", "claude", "pi"]), accessMode: z.enum(["read-only", "workspace"]),
  deviceId: identity, deviceName: z.string(), rootId: identity, rootLabel: z.string(), capabilities,
  tools: z.array(z.custom<string>(isRemoteWorkspaceToolName)), threadId: z.string().nullable(),
  resumable: z.boolean(), status: z.enum(["starting", "ready", "running", "waiting_for_executor", "failed", "stopped"]),
  createdAt: z.string(), updatedAt: z.string(), events: z.array(event),
});
const sessions = z.array(session);
const status = z.object({ available: z.literal(true), devices: z.array(device), runtimes, sessions });
const unavailable = z.object({ available: z.literal(false), reason: z.string(),
  devices: z.array(z.unknown()).length(0), runtimes: z.object({}).strict(), sessions: z.array(z.unknown()).length(0) });

/** Hub observations use management admission; executor pairing and session writes remain separate. */
export async function handleRemoteWorkspaceHubCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCatalogAction(async () => {
    const args = [...argv];
    const wantsJson = takeFlag(args, "--json");
    const action = args.shift() ?? "status";
    rejectArgs(args, REMOTE_WORKSPACE_HUB_USAGE);
    if (!["status", "runtimes", "sessions"].includes(action)) {
      throw new CliUsageError("Expected Hub status, runtimes or sessions", REMOTE_WORKSPACE_HUB_USAGE);
    }
    const path = `/api/remote-workspace${action === "status" ? "" : `/${action}`}`;
    let raw: unknown;
    try {
      raw = await runtimeRequest(path, { redirect: "error" }, deps);
    } catch (error) {
      // The inner owner can refuse after activation changed; the outer owner uses a 200 observation.
      if (error instanceof RuntimeApiError && error.status === 409) {
        console.error(`Error: ${UNAVAILABLE}`);
        return 5;
      }
      throw error;
    }
    if (unavailable.safeParse(raw).success) {
      printData({ available: false, reason: UNAVAILABLE, devices: [], runtimes: {}, sessions: [] }, wantsJson, [UNAVAILABLE]);
      return 1;
    }
    if (action === "status") {
      const parsed = status.safeParse(raw);
      if (!parsed.success) throw new Error("Invalid Hub observation");
      const data = parsed.data;
      printData(data, wantsJson, [
        `Remote Workspace Hub: ${data.devices.length} device(s), ${data.sessions.length} session(s).`,
        ...data.devices.map(row => `${row.id}  ${row.name}: ${row.online ? "online" : "offline"} (${row.roots.length} workspace root(s))`),
        ...(data.devices.length ? [] : ["No paired devices. Pair a device from the Hub dashboard."]),
        ...Object.entries(data.runtimes).map(([name, row]) => `${name}: ${row.available ? "available" : "unavailable"}${row.version ? ` (${row.version})` : ""}`),
      ]);
      return 0;
    }
    if (action === "runtimes") {
      const parsed = z.object({ runtimes }).safeParse(raw);
      if (!parsed.success) throw new Error("Invalid runtime observation");
      printData(parsed.data, wantsJson, Object.entries(parsed.data.runtimes).map(([name, row]) =>
        `${name}: ${row.available ? "available" : "unavailable"}${row.version ? ` (${row.version})` : ""}${row.reason ? ` — ${row.reason}` : ""}`));
      return 0;
    }
    const parsed = z.object({ sessions }).safeParse(raw);
    if (!parsed.success) throw new Error("Invalid session observation");
    printData(parsed.data, wantsJson, parsed.data.sessions.length
      ? parsed.data.sessions.map(row => `${row.id}  ${row.profile}: ${row.status} (${row.deviceName} / ${row.rootLabel}, ${row.accessMode})`)
      : ["No Remote Workspace sessions. Create a session from the Hub dashboard."]);
    return 0;
  });
}
