import { spawnSync } from "node:child_process";

/**
 * Strict bind script: exit 0 only after listen+close. Any listen error (including
 * Windows ghost-TCB failures under Bun) is busy — matches published `ocx start`
 * probes that treat every listen error as unavailable.
 */
export function strictBindProbeScript(port: number, hostname: string): string {
  return [
    "const net=require('net');",
    "const s=net.createServer();",
    "s.once('error',()=>process.exit(2));",
    `s.listen(${Math.trunc(port)},${JSON.stringify(hostname)},()=>s.close(()=>process.exit(0)));`,
    "setTimeout(()=>process.exit(3),2500);",
  ].join("");
}

export function spawnBindProbe(bin: string, script: string): boolean {
  try {
    const r = spawnSync(bin, ["-e", script], {
      windowsHide: true,
      timeout: 4000,
      stdio: "ignore",
    });
    return r.status === 0;
  } catch {
    return false;
  }
}
