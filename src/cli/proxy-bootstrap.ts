import { spawn } from "node:child_process";
import { findLiveProxy } from "../server/proxy-liveness";

/** Start the local proxy if needed and return its port (or null on timeout). */
export async function ensureProxyForClaude(): Promise<number | null> {
  const live = await findLiveProxy();
  if (live) return live.port;
  const child = spawn(process.execPath, [process.argv[1], "start"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, OCX_SERVICE: "1" },
  });
  child.unref();
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const started = await findLiveProxy();
    if (started) return started.port;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return null;
}
