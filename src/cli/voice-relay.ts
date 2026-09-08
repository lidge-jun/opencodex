import { startVoiceRelay, VOICE_RELAY_DEFAULT_PORT } from "../client/voice-relay";
import { CliUsageError, rejectArgs, runCliAction, takeFlag, takeIntegerOption } from "./runtime-api";

export const VOICE_RELAY_USAGE = `Usage:
  ocx voice-relay [--port <port>] [--allow-standalone]`;

export async function handleVoiceRelayCommand(argv: string[]): Promise<number> {
  return runCliAction(async () => {
    const args = [...argv];
    const allowStandalone = takeFlag(args, "--allow-standalone");
    const port = takeIntegerOption(args, "--port", { min: 1 });
    if (port !== undefined && port > 65_535) throw new CliUsageError("--port must be between 1 and 65535", VOICE_RELAY_USAGE);
    rejectArgs(args, VOICE_RELAY_USAGE, { redactValues: true });
    const relay = startVoiceRelay({ port: port ?? VOICE_RELAY_DEFAULT_PORT, allowStandalone });
    console.log(`Voice relay listening on ${relay.origin}/v1 (Ctrl-C to stop).`);
    console.log(`Codex config: experimental_realtime_webrtc_call_base_url = "${relay.origin}/v1"`);
    console.log(`Codex config: experimental_realtime_ws_base_url = "${relay.origin}/v1"`);
    let stopping = false;
    const stop = () => { if (!stopping) { stopping = true; relay.stop(); } };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (process.platform !== "win32") process.once("SIGHUP", stop);
    try {
      const reason = await relay.done;
      if (reason === "connection_changed") throw new Error("connected hub or credential changed; voice relay stopped");
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      if (process.platform !== "win32") process.removeListener("SIGHUP", stop);
      relay.stop();
    }
  });
}
