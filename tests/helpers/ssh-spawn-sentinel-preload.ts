/**
 * Test-only ssh sentinel for CLI children.
 *
 * A PATH fixture cannot prove that a CLI child never starts ssh on every platform: Windows does
 * not run an extensionless `#!/bin/sh` script, and an inherited PATH can reach the runner's real
 * ssh.exe. This preload wraps exactly the APIs Remote Link fan-out uses to start ssh,
 * `Bun.spawn` and `Bun.spawnSync`. An argv whose executable basename is `ssh` or `ssh.exe`
 * appends `Bun.<api> <basename>` to the marker named by OCX_TEST_SSH_SENTINEL and throws, so it
 * never runs. Every other call passes through unchanged.
 *
 * It leaves `node:child_process` alone, so it composes with owned-service-home-preload.ts, which
 * mocks that module on Windows. No production module reads the flag or imports this file.
 */
import { appendFileSync } from "node:fs";

const marker = process.env.OCX_TEST_SSH_SENTINEL;

function sshBasename(input: unknown): string | null {
  const cmd = Array.isArray(input) ? input
    : input !== null && typeof input === "object" && Array.isArray((input as { cmd?: unknown }).cmd) ? (input as { cmd: unknown[] }).cmd
    : null;
  const first = cmd?.[0];
  if (typeof first !== "string") return null;
  const base = (first.split(/[\\/]/).pop() ?? "").toLowerCase();
  return base === "ssh" || base === "ssh.exe" ? base : null;
}

if (marker) {
  const target = Bun as unknown as Record<"spawn" | "spawnSync", (...args: unknown[]) => unknown>;
  for (const api of ["spawn", "spawnSync"] as const) {
    const real = target[api];
    target[api] = (...args: unknown[]) => {
      const ssh = sshBasename(args[0]);
      if (ssh === null) return real.apply(Bun, args);
      appendFileSync(marker, `Bun.${api} ${ssh}\n`);
      throw new Error(`ssh sentinel: Bun.${api} ${ssh} was not started`);
    };
  }
}
